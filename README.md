# OrbitViewer

Compare any place on Earth across two dates with real Sentinel-2 imagery, a split before/after viewer, optional hand-gesture control, and an AI vision explanation in Spanish.

- Vanilla HTML/CSS/JS frontend (no build step) in [public/](public/)
- Vercel Serverless Functions (Node 20, CommonJS) in [api/](api/)
- 100% free APIs by default — paid keys are optional fallbacks
- Visual identity: **Ntizar Aurora** (glass surfaces, blue → orange gradients, Inter + JetBrains Mono)

## Free-API guarantee

| Concern | Service | Cost |
| --- | --- | --- |
| Globe basemap | Mapbox GL JS (public token, free tier) | Free |
| Sentinel-2 scenes | [Earth Search STAC](https://earth-search.aws.element84.com/v1/) | Free, no key |
| COG → PNG render | [TiTiler.xyz](https://titiler.xyz) | Free, no key |
| Elevation (DEM) | [OpenTopoData](https://api.opentopodata.org) | Free, no key |
| Reverse geocoding | [Nominatim (OSM)](https://nominatim.openstreetmap.org) | Free, no key |
| Hand tracking | MediaPipe Hands (CDN) | Free |
| AI vision *(optional)* | OpenRouter (`google/gemma-4-31b-it:free`, plus fallback chain) | Optional |
| Spectral imagery *(optional)* | Sentinel Hub WMS | Optional |

If `OPENROUTER_API_KEY` is unset the app still works — it shows a clean fallback explanation.

## Environment variables

Copy [`.env.local.example`](.env.local.example) → `.env.local` and fill what you need:

```bash
MAPBOX_PUBLIC_TOKEN=pk.xxx          # required (browser-safe public token)
OPENROUTER_API_KEY=                 # optional, enables AI analysis
OPENROUTER_MODEL=google/gemma-4-31b-it:free
SENTINEL_HUB_INSTANCE_ID=           # optional, enables spectral layers
```

All secrets stay in `api/*` — the browser never sees them.

## Local development

```bash
npm install
npx vercel link        # link to your Vercel project
npx vercel pull        # pull env vars locally
npm run dev            # vercel dev on http://localhost:3000
```

## Production deploy

```bash
npm run deploy         # vercel --prod
```

## Gesture cheatsheet

| Gesture | In **Mapa** mode | In **Comparador** mode |
| --- | --- | --- |
| ☝️ Index pointing | Move virtual cursor | Move virtual cursor |
| ✊ Closed fist | Drag (pan) the map | — |
| ✌️ V (index + middle) | Zoom in | Move split right |
| 🖐️ Open hand (4 fingers) | Zoom out | Move split left |
| 👍 Thumbs up — hold 5 s | Lock area + run comparison | Lock area + run comparison |

Mode **Manual** disables all gesture actions — mouse and keyboard work as usual.

## What each area does

- The globe lets you pick the exact place to compare.
- The date pill controls the two comparison dates: **Before** and **Now**.
- The analysis mode buttons bias the AI explanation toward vegetation, fire, water, urban change, natural color, or elevation.
- The split card lets you inspect the same location across the two dates with drag or range input.
- The AI card explains what changed, likely causes, estimated magnitude, and a practical recommendation.
- The territory card resolves the selected point into place, region, and country.
- The webcam card tracks the hand and shows thumbs-up hold progress, but the app remains fully usable with mouse and keyboard only.

## Endpoints

- `GET  /api/health` — liveness probe
- `GET  /api/config` — public client config (Mapbox token, `aiEnabled`)
- `GET  /api/territory?lat&lon&lang=es` — reverse geocode (Nominatim)
- `POST /api/compare` — body `{ lat, lon, date_from, date_to, mode, layer }` → before/after PNGs + AI analysis

## License

MIT.
