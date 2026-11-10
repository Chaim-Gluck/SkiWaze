# ⛷ SkiWays

**Navigate the slopes** - plan a route from point A to point B on a mountain by combining
downhill pistes and uphill lifts, respecting your ability, slope-color preferences,
allowed lift types, and available lift opening hours. Follow it with live GPS guidance,
or explore the mountain in 2D or 3D.

Web app: **React + TypeScript + Vite + MapLibre GL**, with **Material UI** and
**English / Hebrew (RTL)**. Ski data comes from **OpenStreetMap** and elevation datasets,
compiled ahead of time into static per-resort routing graphs. Routes are calculated in
the browser, with no account or installation required.

The app is branded **SkiWays**; the repository/package names and existing browser-storage
keys stay unchanged.

## Features
- Choose from **18 resorts** using the country-grouped picker or resort markers on the map.
  With location permission, a nearby resort can be selected automatically; otherwise the
  default is **Madonna di Campiglio**.
- Choose **A** and **B** from named points (lift tops/bottoms, named piste ends), your
  current location, or by pinning on the map.
- Compare **Balanced**, **Fastest**, **Fewest lifts**, **My preferred runs**, and
  **Longest run** routing. Balanced compares different goals; individual modes offer up to
  three distinct options when the terrain allows, with time, distance, descent and lift stats.
- Find the **longest lift-free descent between A and B**, or use **This resort > Longest**
  to find up to three descents anywhere in the resort. If B cannot be reached without a
  lift, the A-to-B longest mode can offer a lift-assisted route instead.
- Plan for **now** or **arrive by** a chosen time, including the estimated time to leave.
- Set your **max difficulty**, **preferred colors**, **allowed lift types**, skiing pace,
  and whether to allow a bit of poling or avoid app-added bridges.
- Use **live GPS turn-by-turn guidance** with a following map, current-run label,
  next-turn instructions, remaining distance/time, ETA and available GPS speed.
  Off-route warnings offer a **Re-route** action.
- When location is unavailable or you are away from the mountain, an optional, clearly
  labelled **Preview** can play through the route. Preview is simulated, not live guidance.
- Switch between **Map** (OpenFreeMap Liberty), **Topo**, and **Satellite** bases, with
  optional **3D terrain** and piste, lift, area and label layers.
- Mark lifts and runs **closed** from the Closed panel or route steps. Saved closures
  affect routing and are shown on the map; reopen them when conditions change.
- Add **custom links** for connections you know are skiable. These remain local to your browser.
- **Share your location or a meeting point by link**, including through WhatsApp.
  A friend can open it in a browser and plan from their own start to the same destination,
  without installing the app. This shares a fixed point, not continuous live friend tracking.
- Use your **locally measured skiing speeds** from real GPS navigation to personalize estimates.
- Light/dark themes and a mobile layout with bottom navigation and a bottom sheet.

## Safety, status and privacy
**There is no live lift/piste-status or queue feed.** Terrain is assumed open unless you
mark it closed. Opening-hours warnings use the hours recorded in the data, where available;
missing hours and queue waits rely on assumptions, not live resort information.
Follow official closures, signs and resort instructions. Times and GPS positions are estimates,
and dotted app-added connections are not proof that terrain is skiable.

**Off-piste is excluded from routing and hidden on the map by default.** Routing over it
requires an explicit preference, and displaying it uses a separate layer toggle. It is
unmarked, unpatrolled terrain, not an ordinary black run.

Location needs browser permission and **HTTPS**, or `localhost` during development.
Keep the app visible while navigating; background GPS and screen-wake behavior depend on
the browser and device. 3D performance also depends on the device; 2D remains available.

Routing runs on the client. Preferences, closures, custom links and measured-speed samples
are stored in the browser. **This does not mean there is no server communication:** the app
downloads static resort data and third-party map resources. Shared links include the meeting
point in their URL query, so the hosting service and the service used to send the link can
receive those coordinates.

## Getting started
Use a supported **Node.js LTS** release (22.12 or newer) and npm.

```bash
npm ci
npm run dev        # start the web app
npm run build      # TypeScript project build + production bundle
npm run lint       # oxlint
npm run preview    # serve the production bundle after building
```

The compiled resort data is already included, so running the web app does **not** require
rebuilding it. App and pipeline APIs need no custom API keys. The committed lockfile uses
public npm; keep machine-specific npm configuration in a git-ignored `.npmrc`, not the lockfile.

> **Contributors / AI agents:** see [`AGENTS.md`](./AGENTS.md) for architecture, data model,
> domain invariants, gotchas, and conventions.

## Data pipeline
The Node/TypeScript pipeline fetches OpenStreetMap pistes, passenger lifts and road barriers
through Overpass. Elevations come primarily from **Skadi SRTM and Terrarium rasters** sampled
locally, with an **ASTER API tiebreaker** where needed.

It compiles `public/resorts/<id>/{graph.json, geo.json, meta.json}` and updates
`public/resorts/index.json`. Each build also emits `spines.json` for the debug map; the normal
app does not download that review artifact. **Overpass queries and routing-graph elevation
enrichment run only in the build pipeline.** The app reads compiled routing data; its basemap
and 3D terrain resources are loaded separately at runtime.

```bash
npm run data madonna-di-campiglio   # build one resort
npm run data:all                    # build every configured resort
npm run data:refresh                # refresh OSM inputs for every resort
npm run data -- madonna-di-campiglio --refresh  # refresh OSM for one resort
```

Overpass inputs use a **30-day disk cache** in the git-ignored `pipeline/.cache/`.
Elevation samples and downloaded rasters are persistent caches; `--refresh` refetches OSM,
not the entire elevation dataset. Compiled resort files are committed, raw caches are not.

### Resorts
The current 18 configured resorts are:

| Country / countries | Resorts |
|---|---|
| Italy | Madonna di Campiglio (including Pinzolo and Folgarida-Marilleva), Sella Ronda, Monterosa Ski, Pontedilegno-Tonale |
| France | Les 3 Vallées, Tignes - Val d'Isère, Paradiski (Les Arcs - La Plagne), Alpe d'Huez, Les 2 Alpes |
| Austria | Ski Arlberg (St. Anton, Lech, Zürs, Warth), Mayrhofen, Sölden |
| Switzerland | Verbier - 4 Vallées |
| Switzerland / Italy | Zermatt - Cervinia (Matterhorn Ski Paradise) |
| Austria / Switzerland | Ischgl - Samnaun (Silvretta Arena) |
| France / Switzerland | Portes du Soleil |
| Georgia | Gudauri |
| Israel | Mount Hermon |

`src/config/resorts.ts` is the source of truth for names, extraction boundaries and official
information links. Some areas contain genuine disconnected sectors or valley run-outs;
the graph does not invent connections to make them routable.

## How the graph is built (node identity & skiability)
The hard part is deciding when two nearby points are the **same** node and when a gap is
**skiable** (and in which direction). SkiWays models every node in 3D (lon, lat, **elevation**).

**Graph rules live in the shared pipeline** (`pipeline/build.ts`, `pipeline/lib/` and
`src/config/graphConstants.ts`) and apply to every resort. There is no per-resort routing code.
The full invariants and pass ordering are documented in [`AGENTS.md`](AGENTS.md).

- **Same point** only when two endpoints are within *both* a horizontal (`Hmerge`) *and*
  vertical (`Vmerge`) tolerance — so two huts a short distance apart but at different heights
  stay distinct.
- **Endpoint-to-line snapping** (`snapToLineRadius`, 45 m): a run whose endpoint touches
  another run's *middle* (a T-junction) is connected by splitting that run at the touch point.
  This closes the most common OSM gap class.
- **Gap-filling passes** can add short, explicitly synthetic connectors. Direction, climb,
  road-crossing and reachability guards limit these guesses; proximity alone is not evidence
  that a crossing exists.
- **Slopes are one-way** (descending only), **except near-flat cat-tracks** (gradient
  ≤ `flatGradeMax`) which can earn a reverse traverse within `maxTraverseClimb`.
  An explicit mapped `oneway=no` can waive the grade test, not the climb cap. Limited mapped
  lift-access climbs are handled separately and charged as climbing, not free skiing.
- **Lifts** are normally up-only. Gondolas, cable cars and funiculars can carry skiers down;
  explicit two-way tags can also grant a reverse direction to eligible aerial lifts or
  people movers. Non-passenger and lifecycle-dead lifts are filtered out.
- **Area pistes** contribute routing through interior spines and connections, while the map
  displays the polygons as fills instead of drawing their rims as extra runs.
- **Automatic elevation-consensus corrections** re-derive affected directions and use
  reachability guards. Where automatic evidence is insufficient, an evidence-backed human
  override can pin a correction.
- **App-added bridges** are dotted magenta and can be excluded with the corresponding
  preference. **User custom links** are dotted cyan and remain a separate, deliberate input.
- Per-resort `pipeline/overrides/<id>.json` files hold reviewed data corrections.
  `acceptedBasins` and `acceptedDeadEnds` record legitimate disconnections for the audits;
  they do not add graph connections.

## Adding a resort
Adding a resort uses the existing shared pipeline, with **no per-resort routing code**.
Mapping gaps and elevation faults still require acceptance review, and sometimes
evidence-backed overrides. A reusable defect belongs in a shared build-time rule.

1. **Define it** — add an entry to `RESORTS` in `src/config/resorts.ts`
   (`id`, `name`, `country`, `center`, `bbox`, `defaultZoom`, `timezone`). The **`bbox`** is the
   OpenStreetMap extraction area, so make it cover the whole ski area. Size it from data, not by
   eye — bbox clipping is invisible and has silently cut three resorts (procedure in `AGENTS.md`).
2. **Build its data** — `npm run data <id>`. Fetches OSM + elevation and writes
   `public/resorts/<id>/{graph,geo,meta}.json` and updates `resorts/index.json`. This also runs the
   elevation-consensus pass, which repairs mis-oriented piste segments automatically.
3. **Audit it — one command** —
   ```bash
   npm run check:resort <id>                     # the acceptance gate: one verdict table
   npm run check:resort -- <id> --skip-elevation  # skip the second-DEM cross-check
   ```
   Each line reports `ok` / `REVIEW` / `FAIL`. **`REVIEW` is not failure** — these tools report
   *candidates*, not certainties, and a valley run ending at a road is a legitimate "trapped" node.
   Review candidates using the investigation-specific debug-map recipe in `AGENTS.md`
   before writing an override. `FAIL` means the check itself errored - fix the tooling first.
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

Use `pipeline/overrides/<id>.json` only for corrections supported by real-world evidence;
see `pipeline/overrides/example.json.example` for examples and `pipeline/lib/overrides.ts`
for the schema. Overrides run after the initial graph build, followed by guarded corrections
and cleanup passes. Real-world dead-ends are signed off, not bridged.

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
  and installs the committed dependency versions from public npm with `npm ci`, so it
  doesn't depend on any local registry.
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
  hooks/                 live GPS location
  i18n/, locales/        language setup and English/Hebrew catalogues
  data/, state/          static-data loaders and browser-local settings/contributions
  theme.tsx              shared MUI theme and CSS tokens
  App.tsx                main UI
pipeline/
  lib/                   overpass, normalize, elevation, buildGraph, overrides, validate, emit, cache
  build.ts               orchestrator (npm run data)
public/resorts/          compiled per-resort datasets (the saved data)
docs/                   speed-model and style references
```

## Not yet available
Accounts and cross-device sync, Strava integration, live lift/piste status and queue feeds,
signposted **Iconic routes** (the tab currently says "Coming soon"), and complete offline
maps / PWA support. Local measured-speed calibration, live GPS navigation and 3D terrain
are already available; they are not future features.

## License & attribution
- **Code:** [MIT](./LICENSE).
- **Ski/route data:** derived from **© OpenStreetMap contributors**, licensed under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The compiled
  datasets in `public/resorts/*` are produced from OpenStreetMap via the Overpass API.
- **Base maps:** OpenFreeMap Liberty (OpenStreetMap/OpenMapTiles and Natural Earth),
  OpenTopoMap (CC-BY-SA), and Esri World Imagery - each credited in the in-app map
  attribution control and subject to its provider's terms.
- **Elevation:** Skadi SRTM and Terrarium (Terrain Tiles / AWS Open Data), with ASTER via
  OpenTopoData for tiebreaking. Provider data and map assets retain their own terms;
  the code's MIT license does not replace them.
