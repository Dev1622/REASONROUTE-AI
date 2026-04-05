# ReasonRoute AI

ReasonRoute AI is a dispatcher-facing route planning app for shadow pilots with local fleets. It supports:

- geographic stop input with OpenStreetMap map rendering
- road-snapped routing
- traffic-aware routing through Mapbox when configured
- manual stop reordering
- snapped road-block rerouting on the map
- startup pilot-health panel for config readiness
- CSV and Excel stop import
- driver handoff exports in JSON and HTML

## Pilot Readiness

The current build is ready for a first shadow pilot if you provide:

- a valid `GEMINI_API_KEY`
- a valid `MAPBOX_ACCESS_TOKEN` for traffic-aware routing
- real stop data in `label, lat, lng` format

## Environment Setup

Copy `.env.example` to `.env.local` and fill in the values:

```powershell
Copy-Item .env.example .env.local
```

Important vars:

- `GEMINI_API_KEY`
- `VITE_GEMINI_API_KEY`
- `ROUTING_PROVIDER=mapbox`
- `MAPBOX_ACCESS_TOKEN`
- `MAPBOX_DEPART_AT`

Notes:

- If `MAPBOX_ACCESS_TOKEN` is present, the app prefers Mapbox traffic routing.
- If no Mapbox token is set, the app falls back to OSRM road routing.
- `MAPBOX_DEPART_AT` is optional and useful for replaying historical dispatch windows in a shadow pilot.

## Run Locally

Install dependencies:

```powershell
npm install
```

Start the API server:

```powershell
npm run api
```

In a second terminal, start the frontend:

```powershell
npm run dev
```

## Shadow Pilot Workflow

1. Paste stops in `label, lat, lng` format with the depot on the first row.
   You can also upload `.csv`, `.xlsx`, `.xls`, or `.json` stop files.
2. Click `OPTIMIZE ROUTE`.
3. Confirm in `Pilot Health` and `Routing Diagnostics` that the provider is `mapbox` and traffic mode is `historical_or_live`.
4. Use `Mark blocked road` on the map if a corridor should be avoided.
5. If the dispatcher wants a different visit order, reorder the stop list and apply the manual override.
6. Export `Driver_Manifest.html` for the driver and `Route.geojson` for audit or GIS review.

## Recommended Pilot Checks

- Verify `fallback legs` stays at `0` on the test route.
- Verify the provider is `mapbox` before trusting traffic-aware ETA claims.
- Compare ETA realism on known congested corridors before presenting savings numbers.
- Keep at least one baseline screenshot and one reroute screenshot per pilot run.

## Current Limitations

- There is no live driver GPS tracking yet.
- Excel upload is not implemented yet; current input is text/CSV-style paste or JSON import.
- Traffic-aware routing depends on external provider availability and your API token.
