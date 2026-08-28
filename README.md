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

> Note: if your machine needs a private npm registry, put it in a git-ignored `.npmrc`.
> External contributors just use public npm.

> **Contributors / AI agents:** see [`AGENTS.md`](./AGENTS.md) for architecture, data model,
> domain invariants, gotchas, and conventions.

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
Adding a resort is a **supported, routine operation and should go smoothly**. The pipeline is fully
generic — the same graph rules apply to every resort, with **no per-resort code**. Every defect we
have hit so far has been turned into a build-time rule that fires for all resorts, so a new resort
mostly just works.

1. **Define it** — add an entry to `RESORTS` in `src/config/resorts.ts`
   (`id`, `name`, `country`, `center`, `bbox`, `defaultZoom`, `timezone`). The **`bbox`** is the
   OpenStreetMap extraction area, so make it cover the whole ski area. Size it from data, not by
   eye — bbox clipping is invisible and has silently cut three resorts (procedure in `AGENTS.md`).
2. **Build its data** — `npm run data <id>`. Fetches OSM + elevation and writes
   `public/resorts/<id>/{graph,geo,meta}.json` and updates `resorts/index.json`. This also runs the
   elevation-consensus pass, which repairs mis-oriented piste segments automatically.
3. **Audit it — one command** —
   ```bash
   npm run check:resort <id>                    # the acceptance gate: one verdict table
   npm run check:resort <id> --skip-elevation   # skip the (slower) second-DEM cross-check
   ```
   Each line reports `ok` / `REVIEW` / `FAIL`. **`REVIEW` is not failure** — these tools report
   *candidates*, not certainties, and a valley run ending at a road is a legitimate "trapped" node.
   Verify every candidate on the map (`/devtools/mapdebug.html`, or the deep-link
   `?resort=<id>&at=<lat>,<lon>&z=18`) before writing an override. `FAIL` means the check itself
   errored — fix the tooling first.
4. **Sign off the islands** — `npm run check:basins` finds terrain you can ski *into* that cannot
   get back to the main body. Usually the biggest review job on a new resort, and most of what it
   finds is **not a bug** (ski-bus satellites, village run-outs, nursery pods). Record each verdict
   as an `acceptedBasins` entry with the evidence in `why`. **Never bridge a basin just to make the
   number go down**, and never invent terrain.
5. **Sanity-check the model** — `npm run probe:liftmix` and `npm run probe:liftspeed` (a new region
   can shift the measured per-type medians), then `npm run probe:badges <id>` (a route card must
   never contradict the number printed beside it).
6. **Preview** — `npm run dev`, pick the resort, try a few A→B routes and the longest-run widget.
7. **Ship** — commit `public/resorts/<id>/*` and `src/config/resorts.ts` (plus any override), push,
   then deploy (below).

Genuine data gaps are fixed with a `pipeline/overrides/<id>.json` file — see
`pipeline/overrides/example.json.example` for the schema; overrides run *after* the generic passes.
Real-world dead-ends (a valley run ending at a road with no lift) are fine to leave.

### Pitfalls — see `AGENTS.md`
**Every pitfall we have discovered and handled, with its symptom, diagnosis and fix, lives in
[`AGENTS.md`](AGENTS.md)** — the maintainer/agent handbook. It is the single source of truth and is
updated with each pipeline change; keeping a second copy here is what let this section go stale
before. Go there for the override recipes (which primitive fixes which symptom), the bbox-sizing
procedure, the full pass-by-pass graph invariants, and the "gotchas / lessons learned" log — for
example why a line drawn on the map may still not route, why a basin with no entry edges is a
clipping symptom rather than a missing connector, and why a sector that "obviously" needs a lift may
just have an unbuilt one.

A few that bite every run of the pipeline itself:
- **Stop the Vite dev server before any `npm run data*`** — its watcher on `public/` causes
  `graph.json` open errors mid-write.
- The OSM cache is keyed by **resort id, not bbox and not the query text** — after changing a
  `bbox`, or `buildQuery`, you must `data:refresh` (not plain `data`) to actually re-fetch.
- **Never add per-resort routing code.** All corrections are data. If a defect is one a *future*
  resort could hit too, fix it as a build-time rule in the pipeline rather than an override — that
  is what keeps adding a resort cheap.
- Validate with **`npm run build`** (`tsc -b`) and **`npm run lint`** — both must stay green.

## Deploy
Hosted on a **static web host** as a plain static site. Deploys are **manual** — a plain
`git push` never publishes.

- **GitHub Actions (recommended):** Actions tab → *Deploy to Azure Static Web Apps (manual)* →
  **Run workflow**. It builds on the runner and uploads `dist/`. It reads the deploy token from
  the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (stored in GitHub, never in the repo)
  and re-resolves dependencies from public npm, so it doesn't depend on any local registry.
- **CLI (local):** `npm run build`, then upload `dist/` with the hosting provider's CLI using
  the deploy token.

Concrete resource names, the live URL, and provider-specific admin commands are kept out of the
repo in a git-ignored `NOTES.local.md`.

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

## License & attribution
- **Code:** [MIT](./LICENSE).
- **Ski/route data:** derived from **© OpenStreetMap contributors**, licensed under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The compiled
  datasets in `public/resorts/*` are produced from OpenStreetMap via the Overpass API.
- **Base map tiles:** OpenStreetMap (standard), OpenTopoMap (CC-BY-SA), and Esri World
  Imagery — each credited in the in-app map attribution control.
- **Elevation:** Terrain Tiles (AWS Open Data).
