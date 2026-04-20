module.exports = (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).json({
    mapboxToken: process.env.MAPBOX_PUBLIC_TOKEN || '',
    aiEnabled: Boolean(process.env.OPENROUTER_API_KEY),
    spectralEnabled: Boolean(process.env.SENTINEL_HUB_INSTANCE_ID),
    version: '3.0.0'
  });
};
