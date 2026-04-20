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

// --------- helpers ---------

function bboxAround(lat, lon, kmHalf = 5) {
  // ~10 km square (5 km half-side)
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
  u.searchParams.set('width', '720');
  u.searchParams.set('height', '720');
  return u.toString();
}

async function buildSentinelImage(lat, lon, requestedDate) {
  const bbox = bboxAround(lat, lon, 5);
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
    scene_id: feat.id
  };
}

// --------- DEM via OpenTopoData ---------

async function buildDemImage(lat, lon, requestedDate) {
  const bbox = bboxAround(lat, lon, 5);
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
    elevation_min: min,
    elevation_max: max
  };
}

// --------- AI ---------

const PROMPT_TEMPLATE = ({ lat, lon, date_from, date_to, mode }) => `Eres un analista de teledetección. Recibes dos imágenes de satélite del mismo lugar (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)}) en dos fechas distintas:
- Imagen 1 (Antes): ${date_from}
- Imagen 2 (Ahora): ${date_to}
Modo de análisis: ${mode}.

Compara ambas imágenes y responde EN ESPAÑOL en exactamente 3 líneas cortas (máx. 22 palabras cada una), sin viñetas ni saltos extra:
1) Qué cambió visualmente.
2) Posible causa (incendio, deforestación, urbanización, sequía, inundación, etc.).
3) Una recomendación o dato útil para alguien que viva o investigue allí.`;

async function runAi({ urlBefore, urlAfter, lat, lon, date_from, date_to, mode }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { text: null, used: false };

  const model = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';
  const prompt = PROMPT_TEMPLATE({ lat, lon, date_from, date_to, mode });

  const body = {
    model,
    max_tokens: 350,
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: urlBefore } },
        { type: 'image_url', image_url: { url: urlAfter } }
      ]
    }]
  };

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Ntizar/OrbitMixer',
      'X-Title': 'OrbitMixer'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { text: (text || '').trim(), used: true };
}

function fallbackAnalysis({ mode, date_from, date_to }) {
  const m = {
    natural: 'cambios visibles en color y textura del terreno',
    vegetation: 'cambios en cobertura vegetal y vigor de la vegetación',
    fire: 'posibles cicatrices de incendio o zonas quemadas',
    water: 'cambios en cuerpos de agua, humedad o sequía',
    urban: 'expansión urbana o cambios en infraestructura'
  }[mode] || 'cambios entre las dos fechas';
  return [
    `1) Comparación visual entre ${date_from} y ${date_to}: ${m}.`,
    `2) Causas posibles: estacionalidad, actividad humana, eventos climáticos extremos o uso del suelo.`,
    `3) Recomendación: activa la clave OPENROUTER_API_KEY para una explicación detallada por IA.`
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

  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date_from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    return res.status(400).json({ error: 'parámetros inválidos' });
  }

  try {
    const builder = layer === 'DEM' ? buildDemImage : buildSentinelImage;
    const [imgBefore, imgAfter] = await Promise.all([
      builder(lat, lon, date_from),
      builder(lat, lon, date_to)
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

    try {
      const ai = await runAi({
        urlBefore: imgBefore.url,
        urlAfter: imgAfter.url,
        lat, lon,
        date_from: imgBefore.date,
        date_to: imgAfter.date,
        mode
      });
      if (ai.used && ai.text) {
        aiText = ai.text;
        isMock = false;
      }
    } catch (e) {
      renderNote += ` IA no disponible (${String(e.message || e).slice(0, 80)}).`;
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
