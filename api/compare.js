// POST /api/compare
// Body: { lat, lon, date_from, date_to, mode, layer }
// Returns:
// {
//   image_before: { url, date, source, ... },
//   image_after:  { url, date, source, ... },
//   ai_analysis: string,
//   is_mock: boolean,
//   render_note: string,
//   bbox: [w, s, e, n]
// }

const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
const TITILER = 'https://titiler.xyz/cog/bbox';
const OPENTOPO = 'https://api.opentopodata.org/v1';
const AI_CACHE = new Map();

// --------- helpers ---------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveSelectionHalfKm(body) {
  const explicit = Number(body.selection_half_km);
  if (Number.isFinite(explicit)) return clamp(explicit, 0.35, 5);

  const zoom = Number(body.map_zoom);
  if (Number.isFinite(zoom)) {
    return clamp(3.8 / Math.pow(1.17, zoom - 4), 0.45, 4.8);
  }

  return 3.8;
}

function bboxAround(lat, lon, kmHalf = 3.8) {
  // adaptive square around the selected point, usually tighter than 10 km
  const dLat = kmHalf / 111;
  const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const dLon = Math.min(0.15, kmHalf / (111 * cosLat));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function searchSentinel(bbox, dateCenter, windowDays) {
  const start = shiftDate(dateCenter, -windowDays);
  const end = shiftDate(dateCenter, windowDays);
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    limit: 30,
    'query': { 'eo:cloud_cover': { lt: 80 } },
    sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }]
  };
  const r = await fetch(STAC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/geo+json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) return null;
  const j = await r.json();
  const feats = (j && j.features) || [];
  if (!feats.length) return null;
  // Pick the scene whose date is closest to the target, breaking ties by cloud cover.
  const target = new Date(dateCenter + 'T12:00:00Z').getTime();
  feats.sort((a, b) => {
    const da = Math.abs(new Date(a.properties.datetime).getTime() - target);
    const db = Math.abs(new Date(b.properties.datetime).getTime() - target);
    if (da !== db) return da - db;
    return (a.properties['eo:cloud_cover'] || 0) - (b.properties['eo:cloud_cover'] || 0);
  });
  return feats[0];
}

function titilerUrl(cogHref, bbox) {
  const [w, s, e, n] = bbox;
  const u = new URL(`${TITILER}/${w},${s},${e},${n}.png`);
  u.searchParams.set('url', cogHref);
  u.searchParams.set('coord_crs', 'epsg:4326');
  u.searchParams.set('width', '960');
  u.searchParams.set('height', '960');
  return u.toString();
}

async function buildSentinelImage(lat, lon, requestedDate, selectionHalfKm) {
  const bbox = bboxAround(lat, lon, selectionHalfKm);
  let feat = await searchSentinel(bbox, requestedDate, 30);
  if (!feat) feat = await searchSentinel(bbox, requestedDate, 60);
  if (!feat) return { ok: false, bbox };
  const visual = feat.assets && (feat.assets.visual || feat.assets.tci || feat.assets.thumbnail);
  if (!visual || !visual.href) return { ok: false, bbox };
  const url = titilerUrl(visual.href, bbox);
  return {
    ok: true,
    url,
    date: feat.properties.datetime.slice(0, 10),
    source: 'earth-search-stac+titiler',
    cloud_cover: feat.properties['eo:cloud_cover'],
    bbox,
    selection_half_km: selectionHalfKm,
    scene_id: feat.id
  };
}

// --------- DEM via OpenTopoData ---------

async function buildDemImage(lat, lon, requestedDate, selectionHalfKm) {
  const bbox = bboxAround(lat, lon, selectionHalfKm);
  const [w, s, e, n] = bbox;
  const N = 8;
  const points = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const py = s + (n - s) * (r / (N - 1));
      const px = w + (e - w) * (c / (N - 1));
      points.push(`${py.toFixed(5)},${px.toFixed(5)}`);
    }
  }
  const datasets = ['mapzen', 'aster30m', 'srtm90m'];
  let elevations = null;
  for (const ds of datasets) {
    try {
      const url = `${OPENTOPO}/${ds}?locations=${points.join('|')}`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.results && j.results.length === N * N) {
        elevations = j.results.map(p => (p.elevation == null ? 0 : p.elevation));
        break;
      }
    } catch (_) { /* try next */ }
  }
  if (!elevations) return { ok: false, bbox };

  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const span = Math.max(1, max - min);

  // Render an inline SVG hillshade as a data URL.
  const cell = 720 / N;
  let rects = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = (elevations[r * N + c] - min) / span;
      // simple shade: blue (low) → green → orange (high)
      const hue = 220 - v * 200; // 220 → 20
      const light = 25 + v * 50;
      rects += `<rect x="${c * cell}" y="${(N - 1 - r) * cell}" width="${cell + 1}" height="${cell + 1}" fill="hsl(${hue.toFixed(0)} 70% ${light.toFixed(0)}%)"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">
    <defs><filter id="b"><feGaussianBlur stdDeviation="14"/></filter></defs>
    <g filter="url(#b)">${rects}</g>
    <text x="16" y="34" font-family="JetBrains Mono, monospace" font-size="18" fill="#ffffffcc">DEM ${min.toFixed(0)}–${max.toFixed(0)} m</text>
  </svg>`;
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  return {
    ok: true,
    url,
    date: requestedDate,
    source: 'opentopodata',
    bbox,
    selection_half_km: selectionHalfKm,
    elevation_min: min,
    elevation_max: max
  };
}

async function fetchPlaceLabel(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=es,en`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'OrbitViewer/3.1 (contact via repo)',
        'Accept': 'application/json'
      }
    });
    if (!r.ok) return '';
    const data = await r.json();
    const a = data.address || {};
    return [
      a.city || a.town || a.village || a.county || a.state_district,
      a.state || a.region,
      a.country
    ].filter(Boolean).join(', ') || data.display_name || '';
  } catch (_) {
    return '';
  }
}

// --------- AI ---------

const MODE_HINTS = {
  natural:    'Color natural RGB — fija la atención en color, textura, tonos de suelo y agua.',
  vegetation: 'Vegetación — fija la atención en tonos verdes, vigor vegetal, deforestación o reforestación, cultivos, estacionalidad.',
  fire:       'Incendio — fija la atención en cicatrices oscuras / pardas, humo, suelo quemado, pérdida de cobertura repentina.',
  water:      'Agua — fija la atención en ríos, lagos, embalses, costa, sequía, inundación, retroceso glaciar.',
  urban:      'Urbano — fija la atención en expansión de ciudades, nuevas vías, edificios, pérdida de suelo verde.'
};

const PROMPT_TEMPLATE = ({ lat, lon, date_from, date_to, mode, place }) => {
  const hint = MODE_HINTS[mode] || MODE_HINTS.natural;
  const placeStr = place ? ` (${place})` : '';
  return `Eres un analista experto en teledetección y observación de la Tierra. Recibes dos imágenes Sentinel-2 del MISMO lugar (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)})${placeStr} en dos fechas distintas:
- Imagen 1 (ANTES): ${date_from}
- Imagen 2 (AHORA): ${date_to}

Modo solicitado: ${mode}. ${hint}

Compara ambas imágenes con detalle y responde EN ESPAÑOL siguiendo EXACTAMENTE este formato Markdown, sin añadir secciones extra ni texto introductorio:

**Resumen** (1-2 frases): qué ves a primera vista que haya cambiado.

**Cambios observados**:
- 3 a 5 viñetas concretas describiendo cambios visibles (color, textura, cobertura, geometría, límites, agua, vegetación, infraestructura). Si una zona NO cambió, dilo explícitamente.

**Causas probables**:
- 2 a 3 hipótesis ordenadas de más a menos probable. Considera estacionalidad, sequía, incendios, inundaciones, deforestación, agricultura, urbanización, minería, obras hidráulicas, eventos climáticos.

**Magnitud estimada**: una línea con porcentaje aproximado de la imagen afectado y nivel (bajo/medio/alto/crítico).

**Recomendación**: 1-2 acciones útiles para alguien que viva, trabaje o investigue en esa zona (qué mirar, a quién consultar, qué dataset cruzar).

Reglas:
- No inventes nombres de pueblos o ríos si no estás seguro.
- Sé específico ("el cuerpo de agua del cuadrante NE se ha reducido ~30%"), no genérico ("hay cambios").
- Si las imágenes son casi idénticas, di claramente que no se aprecian cambios significativos y explica por qué.
- Si una imagen tiene mucha nube, indícalo y advierte que el análisis es parcial.
- Total: 120-200 palabras.`;
};

async function runAi({ urlBefore, urlAfter, lat, lon, date_from, date_to, mode, place }) {
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) return { text: null, used: false, model: null };

  const cacheKey = [urlBefore, urlAfter, date_from, date_to, mode, place || ''].join('|');
  const cached = AI_CACHE.get(cacheKey);
  if (cached) {
    return { text: cached.text, used: true, model: `${cached.model} (cache)` };
  }

  const userModel = (process.env.OPENROUTER_MODEL || '').trim();
  const chain = [
    userModel,
    'google/gemini-2.5-flash-image',
    'google/gemini-2.0-flash-lite-001',
    'google/gemini-3.1-flash-image-preview',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-3-4b-it:free'
  ].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i); // dedupe

  const prompt = PROMPT_TEMPLATE({ lat, lon, date_from, date_to, mode, place });
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: urlBefore } },
      { type: 'image_url', image_url: { url: urlAfter } }
    ]
  }];

  let lastErr = null;
  const failures = [];
  for (const model of chain) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://orbitmixer.vercel.app',
          'X-Title': 'OrbitViewer'
        },
        body: JSON.stringify({ model, max_tokens: 700, temperature: 0.35, messages })
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        lastErr = new Error(`${model}: ${r.status} ${t.slice(0, 160)}`);
        failures.push(lastErr.message);
        continue;
      }
      const j = await r.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (text && text.trim()) {
        AI_CACHE.set(cacheKey, { text: text.trim(), model, ts: Date.now() });
        if (AI_CACHE.size > 40) {
          const firstKey = AI_CACHE.keys().next().value;
          if (firstKey) AI_CACHE.delete(firstKey);
        }
        return { text: text.trim(), used: true, model };
      }
      lastErr = new Error(`${model}: respuesta vacía`);
      failures.push(lastErr.message);
    } catch (e) {
      lastErr = e;
      failures.push(`${model}: ${String(e && e.message || e)}`);
    }
  }
  throw new Error(failures.slice(0, 3).join(' | ') || String(lastErr && lastErr.message || lastErr || 'AI sin modelo disponible'));
}

function fallbackAnalysis({ mode, date_from, date_to }) {
  const m = {
    natural:    'cambios visibles en color y textura del terreno',
    vegetation: 'cambios en cobertura vegetal y vigor de la vegetación',
    fire:       'posibles cicatrices de incendio o zonas quemadas',
    water:      'cambios en cuerpos de agua, humedad o sequía',
    urban:      'expansión urbana o cambios en infraestructura'
  }[mode] || 'cambios entre las dos fechas';
  return [
    `**Resumen**: comparación visual entre ${date_from} y ${date_to}: ${m}.`,
    '',
    '**Cambios observados**:',
    '- Análisis automático no disponible sin clave de IA.',
    '',
    '**Causas probables**:',
    '- Estacionalidad, actividad humana o eventos climáticos.',
    '',
    '**Recomendación**: configura `OPENROUTER_API_KEY` en Vercel para obtener un análisis detallado.'
  ].join('\n');
}

function demAnalysis({ date_from, date_to, min, max }) {
  return [
    `**Resumen**: la capa de elevación es una referencia topográfica estática; no representa un cambio temporal entre ${date_from} y ${date_to}.`,
    '',
    '**Cambios observados**:',
    '- El relieve base se mantiene igual entre ambas fechas porque procede de un modelo digital del terreno.',
    `- Rango altimétrico aproximado en la ventana seleccionada: ${Math.round(min)} a ${Math.round(max)} m.`,
    '',
    '**Causas probables**:',
    '- No aplica un análisis de cambio temporal en DEM; esta capa sirve como contexto de altitud y pendiente.',
    '',
    '**Recomendación**: usa DEM para interpretar drenaje, cuencas, laderas y exposición; usa Sentinel-2 RGB para detectar cambios reales en el tiempo.'
  ].join('\n');
}

// --------- main handler ---------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'invalid_json' }); }

  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  const date_from = (body.date_from || '').toString();
  const date_to = (body.date_to || '').toString();
  const mode = (body.mode || 'natural').toString();
  const layer = (body.layer || 'TRUE_COLOR').toString().toUpperCase();
  const selectionHalfKm = resolveSelectionHalfKm(body);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date_from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    return res.status(400).json({ error: 'parámetros inválidos' });
  }

  try {
    const builder = layer === 'DEM' ? buildDemImage : buildSentinelImage;
    const [imgBefore, imgAfter, place] = await Promise.all([
      builder(lat, lon, date_from, selectionHalfKm),
      builder(lat, lon, date_to, selectionHalfKm),
      layer === 'DEM' ? Promise.resolve('') : fetchPlaceLabel(lat, lon)
    ]);

    if (!imgBefore.ok || !imgAfter.ok) {
      return res.status(200).json({
        error: 'No hay imagen Sentinel-2 pública para esta fecha.',
        image_before: imgBefore.ok ? imgBefore : null,
        image_after: imgAfter.ok ? imgAfter : null,
        bbox: imgBefore.bbox || imgAfter.bbox
      });
    }

    let aiText = null;
    let isMock = true;
    let renderNote = layer === 'DEM'
      ? 'DEM renderizado vía OpenTopoData (sin clave).'
      : 'Sentinel-2 L2A vía Earth Search STAC + TiTiler (sin clave).';
    renderNote += ` Ventana: ~${(selectionHalfKm * 2).toFixed(1)} km.`;

    if (layer === 'DEM') {
      aiText = demAnalysis({
        date_from: imgBefore.date,
        date_to: imgAfter.date,
        min: imgBefore.elevation_min,
        max: imgBefore.elevation_max
      });
      renderNote += ' IA omitida en DEM porque la capa es estática y se genera como SVG local.';
    } else {
      try {
        const ai = await runAi({
          urlBefore: imgBefore.url,
          urlAfter: imgAfter.url,
          lat, lon,
          date_from: imgBefore.date,
          date_to: imgAfter.date,
          mode,
          place
        });
        if (ai.used && ai.text) {
          aiText = ai.text;
          isMock = false;
          renderNote += ` IA: ${ai.model}.`;
        }
      } catch (e) {
        renderNote += ` IA no disponible (${String(e.message || e).slice(0, 80)}).`;
      }
    }

    if (!aiText) {
      aiText = fallbackAnalysis({ mode, date_from: imgBefore.date, date_to: imgAfter.date });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      image_before: imgBefore,
      image_after: imgAfter,
      ai_analysis: aiText,
      is_mock: isMock,
      render_note: renderNote,
      bbox: imgBefore.bbox
    });
  } catch (err) {
    return res.status(200).json({
      error: 'fallo_interno',
      detail: String(err && err.message || err)
    });
  }
};
