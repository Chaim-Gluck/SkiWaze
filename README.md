# ⛷ SkiWaze

**Waze for ski resorts** — navigate from point A to point B on a mountain by combining
downhill pistes and uphill lifts, respecting your ability, slope-color preferences,
allowed lift types, and lift opening hours, with realistic time estimates.

Web app: **React + TypeScript + Vite + MapLibre GL**. Ski data comes from **OpenStreetMap**
(via the Overpass API) plus an elevation service, preprocessed offline into static per-resort
routing graphs. No login in v1 — preferences are stored in your browser.

## Features
- Pick a resort (defaults to your nearest by geolocation, else **Madonna di Campiglio**).
- Choose **A** and **B** from named points (lift tops/bottoms, named piste ends), your
  current location, or by pinning on the map.
- **Fastest** routing that mixes slopes + lifts, or a **Longest skiable streak** mode that
  maximises your longest lift-free descent.
- Get **2–3 diverse route options** with stats (time, distance, descent, lifts, color
  breakdown, longest streak) and pick the one you like — nothing is auto-chosen for you.
- **Go now** or **arrive by** a time (derives when to start).
- Set your **max difficulty**, **preferred colors**, and **allowed lift types**.
- Warnings when a lift on the route is **about to close**, and popups when data
  (opening hours, wait times, speeds) is unavailable and defaults are used.

## Getting started
```bash
npm install
npm run dev        # start the web app
```

> Note: this environment uses a corporate npm registry via a git-ignored `.npmrc`.

## Data pipeline
Resort data is fetched from OpenStreetMap + an elevation API and compiled into
`public/resorts/<id>/{graph.json, geo.json, meta.json}` (plus `resorts/index.json`).
The web app only reads these static files — it never calls Overpass at runtime.

```bash
npm run data madonna-di-campiglio   # build one resort
npm run data:all                    # build all five resorts
npm run data:refresh                # force re-sync (ignore the 30-day cache)
```

Raw Overpass responses and elevation lookups are cached on disk in `pipeline/.cache/`
(git-ignored) with a 30-day TTL, so rebuilds are fast and don't hammer the public APIs.
The compiled `public/resorts/*` files are the saved dataset and should be committed.

### Resorts
Madonna di Campiglio (IT, default), Cervinia–Zermatt (IT/CH), Sella Ronda / Canazei (IT),
Val Thorens – Les 3 Vallées (FR), Tignes – Val d'Isère / Espace Killy (FR).

## How the graph is built (node identity & skiability)
The hard part is deciding when two nearby points are the **same** node and when a gap is
**skiable** (and in which direction). SkiWaze models every node in 3D (lon, lat, **elevation**).

**These rules live in the shared pipeline (`pipeline/lib/buildGraph.ts` + `src/config/graphConstants.ts`)
and therefore apply identically to EVERY resort — current and any future one you add.** There is
no per-resort graph code; adding a resort just runs the same passes.

- **Same point** only when two endpoints are within *both* a horizontal (`Hmerge`) *and*
  vertical (`Vmerge`) tolerance — so two huts a short distance apart but at different heights
  stay distinct.
- **Endpoint-to-line snapping** (`snapToLineRadius`, 45 m): a run whose endpoint touches
  another run's *middle* (a T-junction) is connected by splitting that run at the touch point.
  This closes the most common OSM gap class.
- **Skiable gaps** between close-but-distinct "stuck" nodes get a **directional** connector:
  downhill-only (higher→lower) when the gradient is skiable, near-flat gaps become a
  bidirectional traverse, and uphill is never inferred.
- **Slopes are one-way** (descending only), **except near-flat cat-tracks** (gradient
  ≤ `flatGradeMax`) which also get a reverse traverse — but never a rise over `maxTraverseClimb`
  (you can skate a few metres, not climb toward a summit).
- **Lifts** are up-only, except gondolas/cable-cars/funiculars which also carry skiers **down**.
- **Flat areas / junctions** take direction from their surroundings (the "K" swap) without ever
  gaining elevation.
- **Rescue pass** guarantees no run is a dead route: a node that can't reach any lift is linked
  to the nearest reachable node within `rescueRadius`; large drops become one-way so the reverse
  can't be abused to climb.
- **Slope numbers** (OSM `ref`/`piste:ref`) are shown before names in directions and the A/B list.
- Inferred/rescue/snap links (and user custom links) are marked **synthetic** → drawn dotted,
  flagged in routes, and excludable via the "Avoid app-added bridges" toggle.
- A per-resort `pipeline/overrides/<id>.json` can correct any heuristic mistake
  (force-merge/split nodes, add/remove connectors, set lift download capability).

## Adding a resort
1. Add an entry to `RESORTS` in `src/config/resorts.ts` (id, name, country, center, bbox, timezone).
2. Run `npm run data <id>` (or `npm run data:all`). The **same** graph-building rules above run
   automatically — no per-resort code. The compiled dataset lands in `public/resorts/<id>/`.
3. Audit connectivity with `npm run check:trapped <id>`; fix any genuinely isolated fragments via
   `pipeline/overrides/<id>.json`. Commit the `public/resorts/<id>/*` files.

## Project layout
```
src/
  types/domain.ts        shared domain model
  config/                resorts, default speeds, graph constants
  utils/                 geo + formatting helpers
  routing/               graph index, cost, Dijkstra, alternatives, longest-streak, planner
  components/            MapView, PointPicker, PreferencesPanel, RouteOptions
  data/, state/          static-data loaders, localStorage preferences
  App.tsx                main UI
pipeline/
  lib/                   overpass, normalize, elevation, buildGraph, overrides, validate, emit, cache
  build.ts               orchestrator (npm run data)
public/resorts/          compiled per-resort datasets (the saved data)
```

## Not in v1 (future)
Login / accounts, Strava integration (personal average speeds), live lift status &
queue times, live GPS turn-by-turn, 3D terrain, offline/PWA.
