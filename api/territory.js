// GET /api/territory?lat=&lon=&lang=es
// Reverse geocode using Nominatim (OpenStreetMap). No key required.

module.exports = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const lang = (req.query.lang || 'es').toString();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat/lon inválidos' });
    }

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=${encodeURIComponent(lang + ',en')}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'OrbitMixer/3.0 (contact via repo)',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) {
      return res.status(200).json({
        place: '—',
        region: '—',
        country: '—',
        label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        source: 'nominatim',
        error: `nominatim_${r.status}`
      });
    }

    const data = await r.json();
    const a = data.address || {};
    const place =
      a.city || a.town || a.village || a.hamlet || a.municipality ||
      a.suburb || a.county || a.locality || '—';
    const region = a.state || a.region || a.province || '—';
    const country = a.country || '—';
    const label = data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({ place, region, country, label, source: 'nominatim' });
  } catch (err) {
    return res.status(200).json({
      place: '—',
      region: '—',
      country: '—',
      label: '—',
      source: 'nominatim',
      error: String(err && err.message || err)
    });
  }
};
