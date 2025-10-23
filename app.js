"use strict";

document.addEventListener('DOMContentLoaded', () => {
  // ===== CONFIG =====
  const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxviDpRACUW8GMp3HfsIznOJCbXLcCIXI3qvjL-PcYZLYnIRbRAwcpMpLq1JSPfJfJ_dQ/exec"; // <-- tu /exec
  const TIPO_FIJO = "CARGUE";        // SIEMPRE CARGUE
  const AUTOSYNC_MS = 30_000;        // re-carga Liquidaciones cada 30s
  // ==================

  // Estado
  let groups = [];       // [{col, placa, ciudad, color, colorName, guias:[] }]
  let guideToGroup = {}; // { "XXXXXXXXXXX": { placa, ciudad, color, colorName, col } }
  let scanned = [];      // [{n, codigo, hora, placa, ciudad, color, colorName}]
  let scannedSet = new Set(); // para evitar duplicados exactos (11 dígitos)
  let grouped = new Map(); // key=colorName -> { placa, ciudad, color, datos:[{codigo,hora}] }
  let debounce = null;
  let autosyncTimer = null;
  let lastSync = null;

  // UI refs
  const input = document.getElementById('barcode');
  const tbody = document.getElementById('tbody');
  const lastRes = document.getElementById('last-result');
  const counter = document.getElementById('counter');
  const btnEnviar = document.getElementById('btn-enviar');
  const btnSync = document.getElementById('btn-sync');
  const btnClear = document.getElementById('btn-clear');
  const btnFaltantes = document.getElementById('btn-faltantes');
  const groupsGrid = document.getElementById('groups-grid');
  const syncInfo = document.getElementById('sync-info');

  // ===== Helpers UI =====
  const pad = (n)=> (n<10? '0'+n : String(n));
  function now12(){
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad(m)}:${pad(s)} ${ampm}`;
  }
  function clearTbody(){ while(tbody.firstChild) tbody.removeChild(tbody.firstChild); }
  function drawRow(rec){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rec.n}</td>
      <td>${rec.codigo}</td>
      <td>${rec.hora}</td>
      <td>${rec.placa || '-'}</td>
      <td>${rec.ciudad || '-'}</td>
      <td><span class="badge" style="background:${rec.color};">${rec.colorName || '—'}</span></td>
    `;
    tbody.appendChild(tr);
  }
  function renderCounter(){ counter.textContent = `${scanned.length} escaneadas`; }
  function setLastResultOK(info, guide, original=null, sourceLen=null){
    lastRes.classList.remove('hidden','fail');
    lastRes.classList.add('ok');
    // fondo completo del panel con el color del grupo
    lastRes.style.background = info.color;
    lastRes.style.borderColor = "#1f2937";
    lastRes.innerHTML = `
      <div class="title">
        <div style="font-size:26px;"><b>${guide}</b></div>
      </div>
      <div class="info" style="color:#0b0d10;">
        <div>Placa: <b>${info.placa || '-'}</b></div>
        <div>Ciudad: <b>${info.ciudad || '-'}</b></div>
        <div>Grupo: <span class="badge" style="background:#0b0d10;color:${info.color};border-color:#0b0d10;">${info.colorName}</span></div>
      </div>
      ${ (original && original !== guide)
          ? `<div style="margin-top:6px;">
               <span class="badge" style="background:#334155;color:#e5e7eb;border-color:#0b0d10;">
                 extraído de ${sourceLen} dígitos
               </span>
               <small style="margin-left:8px; color:#0b0d10;">${original}</small>
             </div>`
          : '' }
    `;
  }
  function setLastResultFail(text){
    lastRes.classList.remove('hidden','ok');
    lastRes.classList.add('fail');
    lastRes.style.background = '#2b1111';
    lastRes.style.borderColor = 'rgba(239,68,68,.35)';
    lastRes.innerHTML = `
      <div class="title">
        <div style="font-size:24px;"><b>${text}</b></div>
      </div>
      <div class="info" style="color:#fca5a5;">No aparece en Liquidaciones</div>
    `;
  }
  function updateSyncInfo(){
    syncInfo.textContent = lastSync ? `Última sync: ${lastSync}` : `Esperando sincronización…`;
  }

  // ===== Persistencia ligera =====
  function saveLocal(){
    try {
      const compressed = LZString.compress(JSON.stringify({ scanned }));
      localStorage.setItem('liq_scanned', compressed);
    } catch(_) {}
  }
  function restoreLocal(){
    try{
      const saved = localStorage.getItem('liq_scanned');
      if (!saved) return;
      const json = LZString.decompress(saved);
      const data = JSON.parse(json||'{}');
      scanned = Array.isArray(data.scanned) ? data.scanned : [];
      scannedSet = new Set(scanned.map(r => r.codigo));
      clearTbody();
      scanned.forEach(r => drawRow(r));
      renderCounter();
      // reconstruir grouped
      grouped = new Map();
      scanned.forEach(r => {
        const key = r.colorName || 'X';
        if (!grouped.has(key)) grouped.set(key, { placa:r.placa, ciudad:r.ciudad, color:r.color, datos:[] });
        grouped.get(key).datos.push({ codigo:r.codigo, hora:r.hora });
      });
    }catch(_){}
  }

  // ===== Normalización de códigos (extraer 11 dígitos) =====
  function extractGuideFromScan(raw) {
    const s = String(raw || '').trim();
    const digits = s.replace(/\D+/g, ''); // quedarse solo con números
    if (digits.length === 15) {
      return { guide: digits.slice(1, 12), original: s, sourceLen: 15 };
    }
    if (digits.length === 32) {
      return { guide: digits.slice(18, 29), original: s, sourceLen: 32 };
    }
    // En cualquier otro caso, se usa como viene (ej. ya son 11).
    return { guide: digits, original: s, sourceLen: digits.length };
  }

  // ===== Cargar Liquidaciones (GET al Apps Script) =====
  async function loadLiquidaciones(showToast=true){
    const url = `${SCRIPT_URL}?mode=liquidaciones`;
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error('Respuesta inválida');

    groups = json.groups || [];

    // reconstruir índice exacto (por guía 11 dígitos)
    guideToGroup = {};
    groups.forEach(g => {
      (g.guias || []).forEach(code => {
        const clean = String(code || '').trim();
        if (!clean) return;
        guideToGroup[clean] = { col: g.col, placa: g.placa, ciudad: g.ciudad, color: g.color, colorName: g.colorName };
      });
    });

    renderGroupsGrid();
    lastSync = now12();
    updateSyncInfo();
    if (showToast) {
      syncInfo.textContent = `Sincronizado: ${lastSync}`;
    }
  }

  // Tarjetas de grupos con escaneados/total
  function renderGroupsGrid(){
    groupsGrid.innerHTML = '';
    // construir contador por colorName a partir de grouped
    const scannedByColor = {};
    for (const [key, g] of grouped.entries()) {
      scannedByColor[key] = (g.datos || []).length;
    }

    groups.forEach(g => {
      const scannedCount =
        scannedByColor[g.colorName] && g.guias
          ? Math.min(scannedByColor[g.colorName], g.guias.length)
          : (scannedByColor[g.colorName] || 0);
      const total = (g.guias || []).length;

      const card = document.createElement('div');
      card.className = 'group-card';
      card.innerHTML = `
        <div class="title">
          <span class="dot" style="background:${g.color}"></span>
          <strong>${g.placa || '(sin placa)'} — ${g.ciudad || '-'}</strong>
        </div>
        <div class="meta">${scannedCount} / ${total} guías</div>
      `;
      groupsGrid.appendChild(card);
    });
  }

  // ===== Auto-sync =====
  function startAutosync(){
    if (autosyncTimer) clearInterval(autosyncTimer);
    autosyncTimer = setInterval(() => {
      loadLiquidaciones(false).then(renderGroupsGrid).catch(err => console.error('Auto-sync error:', err));
    }, AUTOSYNC_MS);
  }

  // ===== Escaneo =====
  function onScan(raw){
    const { guide, original, sourceLen } = extractGuideFromScan(raw);
    const code = String(guide || '').trim();
    if (!code) return;

    const info = guideToGroup[code] || null;

    if (!info) {
      setLastResultFail(code);
      input.value = ''; input.focus();
      return;
    }

    if (scannedSet.has(code)) {
      setLastResultFail(`${code} (duplicado)`);
      input.value = ''; input.focus();
      return;
    }

    const rec = {
      n: scanned.length + 1,
      codigo: code,           // 11 dígitos a enviar/guardar
      hora: now12(),
      placa: info.placa,
      ciudad: info.ciudad,
      color: info.color,
      colorName: info.colorName
    };
    scanned.push(rec);
    scannedSet.add(code);
    drawRow(rec);
    renderCounter();
    setLastResultOK(info, code, original, sourceLen);

    // agrupar para envío
    const key = info.colorName;
    if (!grouped.has(key)) {
      grouped.set(key, { placa: info.placa, ciudad: info.ciudad, color: info.color, datos: [] });
    }
    grouped.get(key).datos.push({ codigo: code, hora: rec.hora });

    saveLocal();
    renderGroupsGrid();
    input.value = '';
    input.focus();
  }

  // ===== Listeners input =====
  input.addEventListener('input', ()=>{
    const v = input.value.trim();
    if (debounce) clearTimeout(debounce);
    if (v) debounce = setTimeout(()=> onScan(v), 250);
  });
  input.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounce) clearTimeout(debounce);
      onScan(input.value);
    }
  });

  // ===== Botones =====
  // Sincronizar ahora
  btnSync?.addEventListener('click', ()=>{
    btnSync.disabled = true;
    btnSync.textContent = 'Sincronizando…';
    loadLiquidaciones()
      .then(renderGroupsGrid)
      .catch(err => { console.error(err); alert('No pude sincronizar.'); })
      .finally(()=>{ btnSync.disabled=false; btnSync.textContent='Sincronizar ahora'; input.focus(); });
  });

  // Limpiar (borrar todo escaneado)
  btnClear?.addEventListener('click', ()=>{
    if (!scanned.length) return;
    const ok = confirm('¿Borrar todos los escaneos de esta sesión?');
    if (!ok) return;
    scanned = [];
    scannedSet = new Set();
    grouped = new Map();
    clearTbody();
    renderCounter();
    localStorage.removeItem('liq_scanned');
    setLastResultFail('Sesión limpia');
    renderGroupsGrid();
    input.focus();
  });

  // Faltantes (abre página con no liquidadas por grupo)
  btnFaltantes?.addEventListener('click', ()=>{
    // construir índice escaneado por colorName
    const scannedByColor = {};
    for (const [key, g] of grouped.entries()) {
      scannedByColor[key] = new Set(g.datos.map(d => d.codigo));
    }

    let html = `
      <html><head><meta charset="utf-8">
      <title>Faltantes</title>
      <style>
        body{font-family:system-ui,Arial,sans-serif;padding:16px;color:#111827;}
        .card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0;}
        .title{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
        .dot{width:14px;height:14px;border-radius:50%;}
        ul{margin:8px 0 0 20px;}
        .muted{color:#6b7280;}
      </style></head><body>
      <h2>Guías faltantes por grupo</h2>
    `;

    groups.forEach(g=>{
      const total = g.guias || [];
      const setScanned = scannedByColor[g.colorName] || new Set();
      const notFound = total.filter(guide => !setScanned.has(String(guide).trim()));

      html += `
        <div class="card">
          <div class="title">
            <span class="dot" style="background:${g.color}"></span>
            <strong>${g.placa || '(sin placa)'} — ${g.ciudad || '-'}</strong>
            <span class="muted">(${total.length - notFound.length} / ${total.length} liquidadas)</span>
          </div>
          ${ notFound.length
              ? `<ul>${notFound.map(n=>`<li>${n}</li>`).join('')}</ul>`
              : `<div class="muted">Sin faltantes ✅</div>`
            }
        </div>
      `;
    });

    html += `</body></html>`;
    const w = window.open('', '_blank');
    if (w) {
      w.document.open();
      w.document.write(html);
      w.document.close();
    } else {
      alert('El navegador bloqueó la ventana emergente.');
    }
  });

  // Enviar a base (agrupado por color/vehículo/ciudad)
  btnEnviar?.addEventListener('click', async ()=>{
    if (!scanned.length) { alert('No hay escaneos.'); return; }
    if (!/^https?:\/\/script\.google\.com\/macros\//.test(SCRIPT_URL)) {
      alert('Configura SCRIPT_URL en app.js');
      return;
    }

    // construir payload por grupos
    const gruposPayload = [];
    for (const [key, g] of grouped.entries()) {
      if (!g.datos.length) continue;
      gruposPayload.push({
        placa: g.placa,
        ciudad: g.ciudad,
        color: g.color,
        datos: g.datos   // [{codigo(11),hora}]
      });
    }
    if (!gruposPayload.length) { alert('No hay grupos con datos.'); return; }

    const meta = { tipo: TIPO_FIJO, timestamp_envio: new Date().toISOString() };

    const prev = btnEnviar.textContent;
    btnEnviar.disabled = true;
    btnEnviar.textContent = 'Enviando…';
    try{
      const resp = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // CORS simple (sin preflight)
        body: JSON.stringify({ meta, grupos: gruposPayload })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const out = await resp.json().catch(()=>({}));
      alert(`OK. Hoja: ${out.sheet || '-'} — Bloques: ${out.blocks || 0}`);
      // (Si quieres limpiar auto tras enviar, descomenta)
      // btnClear.click();
    }catch(err){
      console.error(err);
      alert('No se pudo enviar. Revisa la consola.');
    }finally{
      btnEnviar.disabled = false;
      btnEnviar.textContent = prev;
      input.focus();
    }
  });

  // ===== Init =====
  restoreLocal();
  loadLiquidaciones()
    .then(()=> { input.focus(); renderGroupsGrid(); startAutosync(); })
    .catch(err => {
      console.error('Error cargando Liquidaciones:', err);
      alert('No pude cargar Liquidaciones. Revisa el Apps Script/hoja.');
    });
});
