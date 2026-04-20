// =====================================================================
// OrbitViewer — main app
// =====================================================================

(function () {
  // ---------------- state ----------------

  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); })();

  const state = {
    language: 'es',
    imagerySource: 'mapbox',     // 'mapbox' | 'sentinel'
    handControlMode: 'map',      // 'map' | 'compare' | 'manual'
    webcamActive: false,
    currentMode: 'natural',
    currentLayer: 'TRUE_COLOR',
    selectionLat: 40.4168,
    selectionLon: -3.7038,
    splitPosition: 50,
    splitLoaded: false,
    busy: false,
    isLocked: false,
    lockUntil: 0,
    thumbsUpStartAt: 0,
    comparisonObjectUrls: [],
    lastCompareRequestId: 0,
    config: { mapboxToken: '', aiEnabled: false, spectralEnabled: false }
  };
  window.OrbitViewerState = state;
  window.OrbitMixerState = state;

  // ---------------- helpers ----------------

  const $ = (sel) => document.querySelector(sel);

  function setHud() {
    $('#hud-coords').textContent = `${state.selectionLat.toFixed(4)}, ${state.selectionLon.toFixed(4)}`;
    $('#hud-lock').textContent = state.isLocked
      ? (window.I18N.lang === 'es' ? 'BLOQUEADO' : 'LOCKED')
      : (window.I18N.lang === 'es' ? 'SIN BLOQUEO' : 'UNLOCKED');
    const cd = Math.max(0, (state.lockUntil - performance.now()) / 1000);
    $('#hud-cooldown').textContent = `⏱ ${cd.toFixed(1)}s`;
  }
  setInterval(setHud, 200);

  function setSplit(pos) {
    state.splitPosition = Math.max(0, Math.min(100, pos));
    document.documentElement.style.setProperty('--split-position', `${state.splitPosition}%`);
    const stage = $('#split-stage');
    if (stage) stage.style.setProperty('--split-position', `${state.splitPosition}%`);
    const div = $('#split-divider');
    if (div) { div.style.left = `${state.splitPosition}%`; div.setAttribute('aria-valuenow', String(Math.round(state.splitPosition))); }
    $('#split-range').value = String(Math.round(state.splitPosition));
    $('#split-value').textContent = `${Math.round(state.splitPosition)}%`;
  }

  function pressSegment(group, value, attr) {
    document.querySelectorAll(`[data-${attr}]`).forEach(b => {
      b.setAttribute('aria-pressed', String(b.getAttribute(`data-${attr}`) === value));
    });
  }

  // ---------- tiny markdown renderer (bold + bullets + line breaks) ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function renderMarkdown(src) {
    const lines = String(src || '').split(/\r?\n/);
    const out = [];
    let inList = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        const item = line.replace(/^\s*[-*]\s+/, '');
        out.push('<li>' + inlineFmt(item) + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (line === '') out.push('');
        else out.push('<p>' + inlineFmt(line) + '</p>');
      }
    }
    if (inList) out.push('</ul>');
    return out.join('\n');
  }
  function inlineFmt(s) {
    let h = escapeHtml(s);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    return h;
  }

  // ---------------- init ----------------

  let map = null;
  let selectionMarker = null;

  function updateSelection(lat, lon, options = {}) {
    state.selectionLat = lat;
    state.selectionLon = lon;
    setHud();

    if (selectionMarker) {
      selectionMarker.setLngLat([lon, lat]);
    }

    if (options.compare) {
      void runCompare(options.trigger || 'selection');
    }
    if (options.fetchTerritory !== false) {
      void fetchTerritory();
    }
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      state.config = await r.json();
    } catch (_) {
      state.config = { mapboxToken: '', aiEnabled: false };
    }
  }

  function initMap() {
    if (!state.config.mapboxToken) {
      $('#map').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fbbf24;padding:24px;text-align:center;">
        Falta <code>MAPBOX_PUBLIC_TOKEN</code> en las variables de entorno.<br>
        El resto de la app sigue funcionando.</div>`;
      return;
    }
    window.mapboxgl.accessToken = state.config.mapboxToken;
    map = new window.mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      projection: 'globe',
      center: [state.selectionLon, state.selectionLat],
      zoom: 1.85
    });
    map.on('style.load', () => map.setFog({}));
    selectionMarker = new window.mapboxgl.Marker({ color: '#f97316' })
      .setLngLat([state.selectionLon, state.selectionLat])
      .addTo(map);
    map.on('click', (e) => {
      updateSelection(e.lngLat.lat, e.lngLat.lng, { compare: true, trigger: 'click' });
    });
  }

  // ---------------- date inputs ----------------

  function initDates() {
    $('#date-to').value = today;
    $('#date-from').value = yearAgo;
  }

  // ---------------- toolbar wiring ----------------

  function wireToolbar() {
    // language
    $('#lang-es').addEventListener('click', () => { state.language = 'es'; window.I18N.setLang('es'); pressSegment(null,'es','i18n-lang'); $('#lang-es').setAttribute('aria-pressed','true'); $('#lang-en').setAttribute('aria-pressed','false'); });
    $('#lang-en').addEventListener('click', () => { state.language = 'en'; window.I18N.setLang('en'); $('#lang-es').setAttribute('aria-pressed','false'); $('#lang-en').setAttribute('aria-pressed','true'); });

    // imagery source
    document.querySelectorAll('[data-imagery]').forEach(b => b.addEventListener('click', () => {
      state.imagerySource = b.getAttribute('data-imagery');
      pressSegment(null, state.imagerySource, 'imagery');
    }));

    // hand control mode
    document.querySelectorAll('[data-handmode]').forEach(b => b.addEventListener('click', () => {
      state.handControlMode = b.getAttribute('data-handmode');
      pressSegment(null, state.handControlMode, 'handmode');
    }));

    // mode (analysis)
    document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      state.currentMode = b.getAttribute('data-mode');
      pressSegment(null, state.currentMode, 'mode');
    }));

    // layer
    document.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => {
      state.currentLayer = b.getAttribute('data-layer');
      pressSegment(null, state.currentLayer, 'layer');
    }));

    // capture
    $('#manual-capture').addEventListener('click', () => runCompare('manual'));

    // webcam toggle
    $('#webcam-toggle').addEventListener('click', toggleWebcam);

    // help modal
    const overlay = $('#help-overlay');
    const showHelp = () => overlay.hidden = false;
    const hideHelp = () => overlay.hidden = true;
    $('#help-toggle').addEventListener('click', showHelp);
    $('#help-close').addEventListener('click', hideHelp);
    $('#help-close-2').addEventListener('click', hideHelp);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideHelp(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });
    // auto-open on first visit
    try {
      if (!localStorage.getItem('orbitviewer.helpSeen')) {
        showHelp();
        localStorage.setItem('orbitviewer.helpSeen', '1');
      }
    } catch (_) {}

    // dates
    $('#date-from').addEventListener('change', () => { /* nothing — used at compare time */ });
    $('#date-to').addEventListener('change', () => {});

    // split slider
    $('#split-range').addEventListener('input', (e) => setSplit(parseFloat(e.target.value)));

    // split divider drag
    const divider = $('#split-divider');
    const stage = $('#split-stage');
    let dragging = false;
    const startDrag = (e) => { dragging = true; e.preventDefault(); };
    const moveDrag = (e) => {
      if (!dragging) return;
      const rect = stage.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      setSplit((x / rect.width) * 100);
    };
    const endDrag = () => { dragging = false; };
    divider.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', moveDrag);
    document.addEventListener('mouseup', endDrag);
    divider.addEventListener('touchstart', startDrag, { passive: true });
    document.addEventListener('touchmove', moveDrag, { passive: true });
    document.addEventListener('touchend', endDrag);
  }

  // ---------------- webcam ----------------

  async function toggleWebcam() {
    const btn = $('#webcam-toggle');
    if (state.webcamActive) {
      await window.OrbitGestures.stop();
      state.webcamActive = false;
      btn.textContent = window.I18N.t('webcam-on');
      const c = $('#virtual-cursor'); c.classList.remove('active');
    } else {
      try {
        await window.OrbitGestures.start();
        state.webcamActive = true;
        btn.textContent = window.I18N.t('webcam-off');
        $('#virtual-cursor').classList.add('active');
      } catch (e) {
        // status already emitted
      }
    }
  }

  // ---------------- gesture wiring ----------------

  function wireGestures() {
    document.addEventListener('gesture:cursor', (ev) => {
      if (state.handControlMode === 'manual') return;
      const c = $('#virtual-cursor');
      // EMA smoothing for less jitter
      const targetX = ev.detail.x * window.innerWidth;
      const targetY = ev.detail.y * window.innerHeight;
      state._cx = state._cx == null ? targetX : state._cx + (targetX - state._cx) * 0.45;
      state._cy = state._cy == null ? targetY : state._cy + (targetY - state._cy) * 0.45;
      c.style.left = `${state._cx}px`;
      c.style.top  = `${state._cy}px`;
    });

    document.addEventListener('gesture:pan', (ev) => {
      if (state.handControlMode !== 'map' || !map) return;
      // map.panBy(): positive x moves world right, so cursor right (positive dx) should pan opposite
      const W = $('#map').clientWidth;
      const H = $('#map').clientHeight;
      map.panBy([-ev.detail.dx * W * 1.2, -ev.detail.dy * H * 1.2], { duration: 60 });
    });

    document.addEventListener('gesture:zoom', (ev) => {
      if (state.handControlMode !== 'map' || !map) return;
      if (ev.detail.dir > 0) map.zoomIn(); else map.zoomOut();
    });

    document.addEventListener('gesture:split', (ev) => {
      if (state.handControlMode !== 'compare') return;
      setSplit(state.splitPosition + ev.detail.dir * 1.5);
    });

    document.addEventListener('gesture:thumb', (_) => {
      const c = $('#virtual-cursor'); c.classList.add('locked');
    });

    document.addEventListener('gesture:lock', (ev) => {
      const c = $('#virtual-cursor'); c.classList.remove('locked');
      // turn cursor pos -> map lngLat (only if cursor is over the map)
      const mapEl = $('#map');
      const rect = mapEl.getBoundingClientRect();
      const px = ev.detail.x * window.innerWidth;
      const py = ev.detail.y * window.innerHeight;
      if (map && px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom) {
        const ll = map.unproject([px - rect.left, py - rect.top]);
        updateSelection(ll.lat, ll.lng, { fetchTerritory: true });
      }
      state.isLocked = true;
      state.lockUntil = performance.now() + 6000;
      setTimeout(() => { state.isLocked = false; }, 6000);
      void runCompare('thumbs-up');
    });

    document.addEventListener('gesture:status', (ev) => {
      $('#gesture-status').textContent = ev.detail.text;
    });
  }

  // ---------------- compare flow ----------------

  function setBusy(b) {
    state.busy = b;
    $('#manual-capture').disabled = b;
    $('#manual-capture').innerHTML = b
      ? `<span class="spinner"></span> ${window.I18N.lang === 'es' ? 'Comparando…' : 'Comparing…'}`
      : window.I18N.t('capture');
  }

  async function runCompare(trigger) {
    if (state.busy) return;
    setBusy(true);
    const reqId = ++state.lastCompareRequestId;

    try {
      const body = {
        lat: state.selectionLat,
        lon: state.selectionLon,
        date_from: $('#date-from').value || yearAgo,
        date_to:   $('#date-to').value   || today,
        mode: state.currentMode,
        layer: state.currentLayer,
        map_zoom: map ? map.getZoom() : 1.85
      };
      const r = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (reqId !== state.lastCompareRequestId) return; // stale

      if (data.error && (!data.image_before || !data.image_after)) {
        renderAi({ ai_analysis: data.error, is_mock: true, render_note: 'Sin imagen disponible.' }, true);
        return;
      }

      const before = data.image_before;
      const after  = data.image_after;
      $('#img-before').src = before.url;
      $('#img-after').src  = after.url;
      $('#img-before').alt = `Sentinel-2 ${before.date || ''}`;
      $('#img-after').alt  = `Sentinel-2 ${after.date || ''}`;
      state.splitLoaded = true;
      setSplit(50);
      renderAi(data, false);
    } catch (err) {
      renderAi({
        ai_analysis: (window.I18N.lang === 'es' ? 'Error al obtener la comparación: ' : 'Failed to fetch comparison: ') + (err.message || err),
        is_mock: true,
        render_note: '—'
      }, true);
    } finally {
      if (reqId === state.lastCompareRequestId) setBusy(false);
    }
  }

  function renderAi(data, isError) {
    const txt = data.ai_analysis || '—';
    $('#ai-text').innerHTML = renderMarkdown(txt);
    const meta = $('#ai-meta');
    meta.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (isError ? 'badge-warning' : (data.is_mock ? 'badge-muted' : 'badge-success'));
    badge.textContent = isError ? '⚠ ERROR' : (data.is_mock ? window.I18N.t('ai-fallback') : window.I18N.t('ai-real'));
    meta.appendChild(badge);
    if (data.render_note) {
      const n = document.createElement('span');
      n.className = 'badge badge-info';
      n.textContent = data.render_note;
      meta.appendChild(n);
    }
  }

  async function fetchTerritory() {
    try {
      const r = await fetch(`/api/territory?lat=${state.selectionLat}&lon=${state.selectionLon}&lang=${window.I18N.lang}`);
      const t = await r.json();
      $('#ter-place').textContent   = t.place   || '—';
      $('#ter-region').textContent  = t.region  || '—';
      $('#ter-country').textContent = t.country || '—';
      $('#ter-label').textContent   = t.label   || '—';
    } catch (_) {}
  }

  // ---------------- boot ----------------

  document.addEventListener('DOMContentLoaded', async () => {
    window.I18N.apply();
    initDates();
    setSplit(50);
    wireToolbar();
    wireGestures();
    await loadConfig();
    initMap();
    void fetchTerritory();
  });
})();
