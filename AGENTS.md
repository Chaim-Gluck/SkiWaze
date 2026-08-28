# AGENTS.md — SkiWaze

Handoff/orientation doc for humans and AI agents picking up this project. Keep it
**public-safe**: no secrets, no exact cloud resource names, no personal emails, no internal
URLs. Operational specifics live in `NOTES.local.md` (git-ignored).

## What this is
**SkiWaze** — "Waze for ski resorts." Plan a route from point **A** to point **B** on a
mountain by combining downhill pistes and uphill lifts, respecting the skier's ability
(max difficulty), slope-color preferences, allowed lift types, and lift opening hours, with
realistic time estimates. There is also a **Longest skiable run** finder (longest lift-free
descent for your level). No login in v1 — preferences persist in the browser (localStorage).

## Tech stack
- **Web app:** React 19 + TypeScript + Vite, map rendering via **MapLibre GL**.
- **Data pipeline:** Node + TypeScript run with `tsx`. Source data from **OpenStreetMap**
  (Overpass API) + a public elevation API, compiled **offline** into static per-resort
  routing graphs. The web app never calls Overpass at runtime — it only reads static JSON.
- **Lint:** oxlint. **Build:** `tsc -b && vite build` (project-reference build).
- No backend, no database — the app is a static site over static data files.

## Repo layout
```
src/
  types/domain.ts        shared domain model (nodes, edges, routes, preferences)
  config/                resorts list, default speeds/waits, graph constants
  utils/                 geo + formatting helpers (haversine, 3D length, nearest)
  routing/               graphIndex, cost, dijkstra, alternatives, longestStreak,
                         plan (fastest planner), buildRoute, closures, openingHours,
                         customGraph (user-added nodes/edges)
  state/                 localStorage: preferences, closures, custom nodes/edges
  data/resortData.ts     static-data loaders (fetch public/resorts/*.json)
  components/            MapView, PointPicker, PreferencesPanel, RouteOptions,
                         LongestRunPanel, CustomLinkPanel, ClosedPanel, AccordionSection,
                         Legend, Logo
  App.tsx                main UI wiring
pipeline/
  lib/                   overpass, normalize, elevation, buildGraph, overrides, validate,
                         emit, cache
  build.ts               orchestrator (npm run data)
  _trapped.ts, _routetest.ts   connectivity / routing smoke tests
  overrides/<id>.json    per-resort human corrections (merge/split, connectors, lift dl,
                         setNodeElevation, removePistes, reclassifyLift, removeConnectors,
                         acceptedBasins)
public/resorts/<id>/     compiled datasets: graph.json, geo.json, meta.json (+ index.json)
```

## Architecture & data flow
1. **Build time (pipeline):** `RESORTS` in `src/config/resorts.ts` defines each resort
   (`id`, `name`, `country`, `center`, `bbox`, `defaultZoom`, `timezone`). `npm run data <id>`
   fetches OSM pistes+lifts for the bbox (Overpass) → enriches every point with elevation →
   `buildResortGraph` compiles a 3D routing graph → optional `overrides/<id>.json` corrections
   → validation → emits `public/resorts/<id>/{graph,geo,meta}.json` and updates `index.json`.
   Raw OSM/elevation responses are cached on disk (`pipeline/.cache/`, git-ignored, 30-day TTL).
2. **Run time (app):** loads `graph.json` (routing graph) + `geo.json` (render geometry) +
   `meta.json` (named points, lift info) for the chosen resort and does all routing in the
   browser. No network calls except loading these static files and map tiles.

## Data model (see `src/types/domain.ts`)
- **GraphNode:** `id`, 3D `point` (lon, lat, **ele**), `kind` (lift_station | piste_endpoint |
  junction | poi).
- **GraphEdge:** `from`/`to`, `kind` (piste | lift | connector), `geometry` (polyline),
  `lengthM`, `dropM`, optional `color` (green/blue/red/black/unknown), `connectorKind`
  (skiable_down | flat_traverse), lift metadata, `synthetic` (inferred/rescue/snap/custom),
  `custom` (user-added), `area` (from an OSM area=yes polygon).
- **ResortGraph:** nodes + edges. **GraphIndex** builds fast out-edge/adjacency maps.
- **Preferences:** `maxDifficulty`, `preferredColors`, allowed lift types, `preferSkiing`,
  `avoidSyntheticBridges`, speeds/waits — persisted in localStorage.

## Key domain rules / invariants
These live in the **shared** pipeline (`pipeline/lib/buildGraph.ts` + `src/config/graphConstants.ts`)
and apply identically to **every** resort — there is no per-resort graph code.
- **Same node** only when two endpoints are within *both* a horizontal (`Hmerge`) *and*
  vertical (`Vmerge`) tolerance — huts close horizontally but at different heights stay distinct.
- **Endpoint→line snapping** (`snapToLineRadius`): a run touching another run's middle
  (T-junction) splits that run at the touch point (fixes the most common OSM gap).
- **Coincident duplicate nodes are unified first** (`pipeline/lib/coincidentNodes.ts`). Junctions are
  found by counting, *per OSM node id*, how many ways contain it — which assumes mappers reuse one
  node where two runs meet. Often they don't: each way gets its own node at the same coordinates, so
  both ids count 1, neither way is split, and a junction that exists on the snow is silently dropped.
  Nothing downstream recovers it (endpoint merge and endpoint→line snap only look at *endpoints*;
  `weldCoincidentNodes` only welds nodes already joined by an edge). The pre-pass rewrites such ids
  to the smallest in the group — order-independent, so node ids stay stable. Guards: **piste×piste
  only** (welding onto a lift's interior would invent a mid-span boarding point), never two points of
  the same way, never across differing `layer`/`bridge`/`tunnel` (`levelKey`), and ≤ 0.5 m.
- **Slopes are one-way (descending only)**, except near-flat cat-tracks (gradient ≤ `flatGradeMax`)
  which also get a reverse traverse — but never a rise over `maxTraverseClimb`.
- **Uphill is never inferred.** Skiable connectors are downhill-only or flat/bidirectional.
- **A split may not invent an uphill piste.** A piste's direction comes from its two endpoint
  elevations, so a non-monotonic way (classically an `area=yes` ring arcing over a rim: down into
  the bowl, back out, ending near its start height) passes as "descending". Splitting it at an
  interior point yields halves that inherit `kind:'piste'` while one genuinely climbs — and
  `cost.ts` charges nothing to ascend a piste, making it a free lift. Any split half that climbs
  more than `maxTraverseClimb` is emitted **reversed** (`pushSplitHalf` in `buildGraph.ts`), so the
  real descent survives and the bogus ascent goes. Smaller rises are left alone: that's DEM noise,
  and flipping a run over it would be worse than the rise.
- **Lifts are up-only**, except gondolas/cable-cars/funiculars which also carry skiers **down** —
  plus any **aerial** lift OSM explicitly tags `aerialway:oneway=no` / `oneway=no`. That tag is a
  deliberate minority signal, not an editor default: fleet-wide only 32 of 347 chairlifts carry it
  against 103 explicitly `oneway=yes`, and **zero** of 318 surface lifts claim it. Honouring it is
  what makes the Sella Ronda circuit work in both directions (Arabba Fly, Arabba–Monte Burz), and it
  alone cut fleet stranded nodes **720 → 287**. Two rules keep it safe:
  **(a) grant-only, never revoke** — `oneway=yes` on a gondola usually just records the way's drawn
  direction, so believing it would strand terrain on ambiguous evidence; we only ever *add* a
  downhill direction. **(b)** gated on `AERIAL_LIFT_TYPES`, so a drag lift/platter can never become
  bidirectional however it is tagged.
- **Rescue pass**: any node that can't reach a lift is linked to the nearest reachable node
  within `rescueRadius`; large drops become one-way so they can't be abused to climb.
- **Lift-top ski-out pass** (`liftSkiOutRadius`): a lift top with no ski-out is projected onto
  the nearest downhill piste point, splitting it and adding a synthetic skiable_down connector.
- **Areas** (OSM `area=yes` pistes): **kept in the routing graph** (open bowls need them for
  connectivity) but **excluded from the render lines** and emitted separately as polygon fills.
  Never drop areas from the graph — it disconnects bowls.
- **Polygon spines are adopted by geometry, never by run name.** A polygon's centreline candidates
  are the piste lines that physically lie **inside** the ring (`insideLenM` ≥ max(15 m, 10% of the
  polygon's length)), not the ways sharing the polygon's `ref`/`name`. Name matching failed two ways:
  76% of area polygons are unnamed, so they got **zero** candidates and fell back to synthesising a
  spine between the farthest **portals** — which, on a ribbon whose portals all cluster mid-way, gave
  a spine covering 1–23% of the polygon; and a *named* polygon still only ever adopted one name, so a
  run split across ways under different names was truncated. Geometry subsumes both cases.
- **A polygon's spine must span the polygon, not merely descend it.** Three rules enforce this, each
  fixing a different way a spine ended up covering half a shape: candidates are scored **per source
  way, not per edge** (a run is split at every junction, so a centreline that crosses the whole
  polygon arrives as fragments that each fall under a whole-polygon threshold and get rejected one by
  one); a centreline spanning under `SPAN_MIN` (0.6) gets a **synthesised spine added alongside** it,
  because a run that crosses the polygon and then simply stops inside it leaves one end with no
  centreline; and a synthesised spine terminates at the polygon's **extremity** rather than its
  farthest portal when the extremity is >`EXTEND_TO_EXTREMITY` (1.25×) farther, since a ribbon whose
  neighbours touch it only in the middle otherwise gets a spine only as long as that portal cluster.
- **Synthetic** links (inferred/rescue/snap + user custom) are drawn dotted, flagged in routes,
  and excludable via "Avoid app-added bridges."
- **Polygon gateways split at corners.** Two polygons can meet along two *separate* stretches of
  rim that happen to share the corner node between them (a corridor wedged into a notch of a bigger
  polygon touches it left and right). Walking that as one chain drops a single gateway at the arc
  midpoint, which lands *on the corner* — a point that was already a portal — while both real
  mid-boundary crossings get none. `sharedRim.ts` therefore cuts a chain wherever it deflects by
  ≥ `CORNER_DEG` (60°). Fleet-wide 88 % of chain corners are under 30°, so this touches ~3 % of chains.
- **Squat polygons are spined gateway-to-gateway.** A synthesised (class B) spine normally runs
  between the geodesically most distant portals, which is right for a ribbon. For a polygon that is
  merely the *join* between its neighbours, maximising length ends the spine at rim corners and
  demotes the gateways to arms, so crossing it means detouring to a corner and back. When
  `chord² / (2·area) ≤ 2` **and** `chord ≤ 250 m`, the termini come from the two farthest-apart
  gateways instead. The gate is **shape, not size** — the two known corridors differ by ~10× in area,
  and one ribbon that must never qualify is smaller than one corridor that must. Ribbons measure
  3.3–16 on that ratio; nothing observed sits between 2 and 3.3. 46 of ~1076 polygons qualify.
- **Spine fragments are stitched, and the stitch is routed, smoothed and anchored.** A polygon's
  spine often arrives in disconnected pieces. The stitch pass is a **minimum spanning forest** over
  those pieces: a short chord (`STITCH_MAX_M` 30 m) when one fits inside the ring, otherwise a
  Dijkstra route over the interior sampling lattice up to `STITCH_ROUTE_MAX_M` (250 m) with a
  `STITCH_DETOUR_MAX` (1.6) cap on route-length ÷ straight-line. Two mandatory post-steps: the raw
  lattice path can only step between neighbouring grid cells, so it **must** go through the shared
  `smoothPath()` or it paints a visible staircase; and it must be **anchored** onto the true piece
  endpoints, trimming any vertex that does not make progress toward the anchor first — the lattice
  node can *overshoot*, which showed up as a 7 m double-back. Because it is a spanning forest, a
  hole between two pieces that are *already* connected is deliberately never stitched.
- **A run leaving its polygon and returning is not a coverage hole.** Where two spine pieces come
  from the same OSM way (`src[i] === src[j]`) they are united with **no link drawn**: the piste is a
  single continuous edge in the routing graph, so nothing is disconnected and inventing a link would
  duplicate an existing run across terrain outside the ring. Verified on `les-deux-alpes`
  `w1217422010`, where 20 of 21 samples along the "gap" fall outside the polygon. Fleet-wide there
  are 113 such unions, 59 over 30 m, max 531 m. The span is recorded in `SkelGeom.wayBridges` —
  **measurement only**, consumed by `check:spines`/`_spineparts` so the metric stops reporting a
  defect, never emitted as geometry. User review of the six largest found the rims are genuinely
  under-drawn in OSM; the right fix is upstream, and widening a ring in the pipeline is rejected
  because the ring is our only evidence of where terrain is actually skiable.
- **App-invented plumbing (arms, spine duplicates, synthetic links) is a last resort, not a shortcut.**
  Skeleton **arms** and **spine duplicates** exist for connectivity — an arm is often the only way
  through a rim portal — but they are not real pistes and routes should not prefer them. Three
  separate mechanisms had to be fixed before routes stopped weaving onto them, and each failed in a
  different layer, so check all three when plumbing reappears in a route:
  1. **Cost** — `ARM_PENALTY` (1.25) and `SPINE_DUPLICATE_PENALTY` (1.5) in `cost.ts`.
  2. **Ranking** — `ranking.ts` excludes `leg.plumbing` from `skiM`, otherwise invented links count
     as "skiing" and win the skiing objective outright.
  3. **The longest-descent search** — see the diversity-penalty asymmetry below.
- **A diversity penalty punishes only what was chosen, so it can hand victory to what never was.**
  `longestDownhillPaths` multiplies each *used* edge by 0.55 per accepted variant. Plumbing scores
  ~0 in `makeDescentScorer`, so it is never chosen and therefore **never penalised**, while the real
  line beside it decays 1 → 0.55 → 0.30; by the third variant the invented link wins. No per-edge
  score change can fix this, because the *penalty* is deciding, not the score. The fix is
  `smoothPlumbing()` — for each maximal run of consecutive plumbing edges, re-solve that stretch
  **unpenalised** and splice it in when it scores better. Penalise what the search found, keep the
  smoothed result. This mirrors `smoothDetours` in `alternatives.ts`, which solves the identical
  pathology for the alternatives search; if you add a third penalised search, it needs the same pass.
- **Coincident lines are welded, and near-duplicate spines are marked.** Two passes run in
  `build.ts`: `weldCoincident.ts` merges lines that occupy the same ground, and
  `spineDuplicates.ts` flags an edge that merely parallels an adopted spine (`spineDuplicate`), so
  cost can prefer the real centreline. Neither deletes terrain — both only relabel — because a
  parallel line is sometimes a genuinely separate run.
- **Longest-run finder** rewards **straight-line descent progress** and **penalizes internal
  uphill** — winding pistes that descend then climb back are what cause visible "doubling-back",
  so they must not be over-rewarded by raw skied length. Genuinely curving-but-descending
  pistes are preserved (only internal climbing is penalized).

## Run locally
```bash
npm install
npm run dev            # web app (Vite dev server)
npm run build          # production build (tsc -b && vite build) — the real CI gate
npm run lint           # oxlint

# Data pipeline
npm run data <id>      # build one resort (uses 30-day disk cache)
npm run data:all       # build all resorts
npm run data:refresh   # force re-fetch OSM (ignores cache)
npm run check:resort <id> [--skip-elevation]  # THE acceptance gate for a resort. Runs the whole
                             #   battery below (trapped / audit / elevation / spines / overrides /
                             #   routetest / plan) and prints one ok|REVIEW|FAIL table. Use this when
                             #   adding or refreshing a resort instead of remembering seven commands.
                             #   REVIEW = a human must eyeball it on the map (these tools report
                             #   candidates, not certainties); FAIL = the check itself errored.
                             #   Each reader parses a specific summary line and FAILs if absent —
                             #   keep it that way, a regex that silently matches nothing reports a
                             #   false 'ok' (this bit us twice while building it).
npm run check:trapped <id>   # nodes that can't reach a lift / are isolated / trapped basins
npm run check:basins         # fleet-wide trapped basins (ski in, no way back to the main body);
                             #   writes the trapped-basins overlay + the mapdebug review list
npm run check:audit <id>     # false-elevation reversals + non-skiable long connections
npm run check:graphdiff <id|all>  # structural diff of the built graph vs the committed one:
                             #   matches nodes by position and compares edges as a multiset, so a
                             #   pure id change reports "IDENTICAL (relabelled only)"
npm run check:elevation <id|all> [thresh]  # cross-check node elevations vs Terrarium DEM; lists
                             #   piste "reversal candidates" + clusters; writes a map-debug overlay
                             #   (verified-good spots are silenced via `ignoreReversals` in the override)
npm run probe:elevation <id> <node...>  # dump a node's edge neighbourhood: our elevation vs DEM at
                             #   both ends of every edge — for a suspicious arrow the audit missed
npm run check:overrides <id|all>  # validate id-based override entries (addConnectors /
                             #   setNodeElevation / mergeNodes) — catches stale ids after a refresh
npm run routetest <id>       # routing smoke test from the summit. NOTE: it plans with timing
                             #   'now', so lift opening hours gate the result and the score is
                             #   time-of-day dependent. Only ever compare A/B at the SAME moment
                             #   (swap in the other graph.json, run, restore) — a recorded baseline
                             #   from another hour is meaningless.
npm run check:spines <id|all>  # per-polygon spine health, two independent complaints:
                             #   drop  — spine descends over the polygon's own top-to-bottom drop
                             #   cover — the UNION of the spine pieces (plus stitches and way
                             #           bridges) over the polygon extent, both projected onto the
                             #           polygon's long axis. Catches a spine that is healthy but
                             #           *short* (descends fine, only spans half the polygon), which
                             #           the drop test cannot see. A good spine is interior, so it
                             #           scores ~0.8–0.95, never 1.0. It must be a union: measuring
                             #           the extent (min..max) instead was structurally blind to
                             #           fragmentation — the very defect stitching exists to fix.
                             #   Still blind to twisting polygons: a spine can score 99% while
                             #           visibly missing a lobe, so never guard or validate on the
                             #           axis projection alone.

# Diagnostics (report-only; none of them write data)
npm run probe:spineparts <id> <wayId...>  # answers "*where* is the gap": the polygon's spine pieces
                             #   projected on its long axis, marked SYNTH / STITCH / WAY-BRIDGE,
                             #   plus the merged union. The union here is the trustworthy figure.
npm run probe:trappeddiff <baseline.json> <current.json> [label]  # the ONLY correct way to judge a
                             #   connectivity change. A count moving by five says nothing about
                             #   whether five real places got worse; this names them, and prints a
                             #   REGRESSED section only when real terrain actually got worse.
npm run probe:reach <graph.json> [label]  # raw BFS reachability from the highest node over all
                             #   out-edges, ignoring preferences — separates "the graph broke" from
                             #   "the planner rejected the routes", which routetest cannot.
npm run probe:plan <id> [pairs]  # routing quality: option 1's distance vs the shortest *feasible*
                             #   path (never straight-line — one-way pistes make a 40 m gap
                             #   legitimately cost kilometres), plus mean option count and connector
                             #   share. Run before and after a ranking change and diff.
npm run probe:badges <id|all> [pairs]  # asserts a badge never contradicts the number printed beside
                             #   it: no card badged "Fastest" shows more minutes than a sibling, none
                             #   badged "Longest" shows fewer ski km. Compares at DISPLAY resolution
                             #   (whole minutes, 0.1 km) — a margin the user cannot see is not a lie.
                             #   Exit code 1 on any violation, so it works as a gate.
npm run probe:wiggle <id>    # how often option 1 detours off a spine onto a parallel duplicate, and
                             #   by how far. Report the RATE, MEAN and WORST together — a pass that
                             #   turns one 1246 m detour into several 50 m ones raises the rate while
                             #   plainly improving the map. (See the two traps in its header comment.)
npm run probe:legturns <id> <from> <to> [option]  # per-leg dump of one route: edge, kind, way id,
                             #   coords and the turn angle at each boundary (`<<<` at >=75deg). THE
                             #   diagnostic for "why is this route zigzagging".
npm run probe:hood <id> <latMin> <latMax> <lonMin> <lonMax>  # every node and edge in a bbox with
                             #   direction, way and flags — use it to check whether a line the router
                             #   skipped is actually traversable before blaming the router.
npm run probe:longsum <id>   # the three resort-wide "Longest runs" figures, as a regression guard.
npm run probe:goldenroutes   # THE ONLY GATE ON TIME. Replays real recorded runs (Strava elapsed) from
                             #   pipeline/fixtures/golden-routes.json and compares our estimate against
                             #   the clock. Add a fixture whenever a real run is available — the speed
                             #   and queue-wait numbers otherwise have nothing holding them honest.
npm run probe:elevoverrides [--details]  # are our setNodeElevation overrides still doing anything?
                             #   Compares each entry against what the CURRENT provider chain samples
                             #   at that node. Most were written against an older DEM: at last run,
                             #   43/117 were redundant and 36 pointed at nodes that no longer exist.
npm run probe:plumb <id>     # how much app-invented plumbing ends up inside longest-descent options.
npm run probe:armsweep <id>  # sweeps ARM_PENALTY, reporting plumbing share AND detour rate together
                             #   (a penalty that cuts plumbing but sends routes the long way is a
                             #   loss, and only the pair of numbers shows that).
npm run probe:liftspeed      # re-derives the per-type lift speed table from OSM `aerialway:duration`
                             #   across the cached resorts. Run it after adding resorts, and sanity-
                             #   check DEFAULT_SPEEDS.liftSpeedByType against the medians.
npm run probe:liftmix        # lift counts by type per resort — a quick read on how much any per-type
                             #   constant actually matters (cable cars are 3.6% of the fleet).
```

> **Validate the probe before you believe the probe.** Four separate wrong conclusions in this repo
> came from a broken measurement, not broken code: geometry points are `{lon,lat,ele}` **objects**,
> so a probe doing `p[0]-q[0]` gets `NaN` and cheerfully reports "0 problems"; sampling node pairs in
> **id order** silently changes the test set whenever a pass adds or removes nodes, manufacturing a
> phantom regression; and pricing every option with the `fastest` cost makes a `longest_ab` option a
> "detour" by construction. When a probe result is surprising, instrument the **real** code path.

> Debug map tool: `public/devtools/mapdebug.html` (served at `/devtools/mapdebug.html` by the dev
> server). Resort + investigation-overlay dropdowns, OpenTopoMap/OSM/satellite base, area fills,
> flow-direction arrows (double-headed ⟺ = bidirectional), piste-name labels, and a node finder —
> the main way to eyeball routing/elevation questions. It also has a **review list** (dropdown +
> prev/next) driven by `public/devtools/overlays/review-list.json`, which `npm run check:basins`
> writes (AGENTS and the tool's own comment both used to call it hand-written — it never was). It
> holds only the **unsigned** basins, so the moment the last one is signed off in `acceptedBasins`
> a run legitimately produces nothing, and writing that `[]` takes the reviewer off the tool with
> no error anywhere (the box only renders when the file loads non-empty). `_basins.ts` therefore
> **refuses to write an empty list or an empty overlay**, same guard as `_areaskel.ts`. Keep both
> files committed, and keep one entry as a schema example.
>
> **`check:areaskel` and `check:areaclass` are retired.** They re-derive polygons straight from OSM
> via `buildResortGraph` and so never see `build.ts`'s synthesis passes — today they classify every
> polygon class `D` and produce nothing. `check:spines` is the live gate. `_areaskel.ts` now refuses
> to write an empty overlay, because running it once silently truncated the committed 10.6 MB
> `area-skeletons.json` and took the spine overlay off the debug map.
> If your machine needs a private npm registry, put it in a **git-ignored `.npmrc`**.
> External contributors just use public npm; the CI build resolves from public npm.

## Environment variables / secrets
- The **app and pipeline need no custom env vars** (only Vite's built-in `import.meta.env.BASE_URL`).
  The elevation/Overpass APIs are public and unauthenticated.
- **Deploy secret:** the CI workflow reads a deploy token from a **repository secret** named
  `AZURE_STATIC_WEB_APPS_API_TOKEN`. The value is stored only in GitHub → Settings → Secrets;
  it is **not** in the repo. Rotate it from the hosting provider if ever exposed.

## Deployment approach (generic)
- Static site: `npm run build` → `dist/` of static assets → uploaded to a **static web host**.
- **Manual only:** the deploy GitHub Actions workflow is `workflow_dispatch` (Run workflow) —
  a plain `git push` never publishes.
- CI removes `package-lock.json` and reinstalls from **public npm** (the committed lock may
  reference a private registry the runner can't reach), then builds and uploads `dist/`.
- SPA routing + cache headers are configured in `public/staticwebapp.config.json`.
- Exact resource names, the live URL, provider admin commands, and account details are in
  **`NOTES.local.md`** (git-ignored) — not committed.

## Gotchas / lessons learned
- **"It's drawn on the map, so why won't it route?" is a real bug report — chase it.** Warth (Ski
  Arlberg) looked like an 8-node island: gondola + 2 runs, zero edges in or out. Everything pointed
  at missing terrain, and two different connectors were proposed (both wrong). The user insisted the
  runs visibly meet. They do: run 269 Dorfabfahrt and run 266 Wannenkopf each make a **hairpin at
  bit-identical coordinates** (`10.1756297,47.2585637`) — 0.000 m apart, node ids `3419720259` vs
  `12815432358`, interior to both ways. `geo.json` draws true geometry, so the junction was on screen
  the whole time; only the *router* couldn't turn there. Lessons: (a) when render and routing
  disagree, diff `geo.json` against `graph.json` in a box before blaming OSM; (b) **compare full
  vertex lists, not just endpoints and nearest-node distances** — a nearest-*node* search reported a
  105 m gap and hid a 0 m touch; (c) two ways that each put an explicit vertex at the same spot is a
  mapper marking a junction, not a coincidence. Fixed generically — see `coincidentNodes.ts` above.
  Census at the time: 18 dropped junctions across 8 of 15 resorts.
- **A basin "obviously" needing a lift may just have an unbuilt one.** Schröcken's village gondola is
  `w660999299 aerialway=proposed`, note "in Planung". Grep OSM for `proposed`/`construction` before
  assuming a data bug.
- **Station *polygons* masquerade as lifts.** `aerialway=station` catches most, but mappers also tag
  outlines `aerialway=yes` + `building=yes` / `public_transport=station`. A lift is a line, never a
  polygon, so `isPassengerLift` rejects those too. Left in they become zero-length "lifts" that weld
  together whatever the outline touches (Zermatt's Plan Maison, Madonna's `w561699267`).
- **Bbox clipping is invisible — check the graph's extent against the bbox.** Overpass returns a way
  in *full* if any node touches the box, so a clipped resort still looks complete. The tell is the
  built graph's lon/lat extent exceeding the declared bbox (St. Anton: `lat …47.2398` vs
  `maxLat 47.21` — the box cut straight through Lech/Oberlech/Warth). Has now bitten Tignes, Mayrhofen
  and St. Anton. To resize: Overpass `way["piste:type"="downhill"]` + `way["aerialway"]` over a
  generous box → `out tags center` → histogram lon and lat in 0.005° bins; the real edge is the bin
  before a multi-km empty run. Then check the other bands for a *foreign* resort a rectangle would
  swallow (Sonnenkopf/Klösterle) and cut it with `excludeBboxes`. **The OSM cache is keyed by resort
  id + TTL, not bbox — `npm run data -- <id> --refresh` is mandatory after a bbox edit.**
- **`check:overrides` reporting N stale does not mean your change caused them.** Triage each id
  against `git show HEAD:public/resorts/<id>/graph.json`: present-both / lost-today / already-stale.
  The last fleet run was 17 pre-existing vs 3 genuinely broken; chasing all 20 would have been wasted
  work. For a lost id, find the nearest node in the new graph — if it is ~0 m away the entry just
  needs repointing (record the reason in a `_why`).
- **A parameter sweep that moves nothing is a bug signal, not a plateau.** Twice now, sweeping a
  constant produced byte-identical fleet numbers because the test it fed never actually fired: a
  structurally-dead `TAIL_CLEAR_RATIO`, and `STITCH_ROUTE_MAX_M` whose effect was invisible because
  `check:spines` measured spine *extent* instead of the *union* of its pieces — so fragmentation,
  the defect stitching exists to fix, could not register. With an honest metric the same sweep
  responded immediately (`<0.9`: 150 → 175, 250 → 170, 400 → 169; knee at 250). If a knob does
  nothing, verify the measurement before concluding the knob does not matter.
- **Validate with `npm run build` (`tsc -b`), not `tsc --noEmit`** — project-reference build
  mode catches errors the root `--noEmit` misses (a TS2367 once passed `--noEmit` but failed CI).
- **Triple/parallel piste lines** were OSM `area=yes` polygons rendered as perimeters. Fix:
  keep areas in the graph, exclude from render lines, emit as polygon fills (see invariants).
- **Node ids are stable, derived from OSM.** A merged cluster is named `n<smallest OSM node id in
  the cluster>`; the two synthetic passes name their node after the node it serves (`s<id>` for a
  dead-end snap, `k<id>` for a lift-top ski-out). Ids therefore do **not** depend on iteration order,
  so `data:refresh` no longer renumbers anything and id-based `overrides/<id>.json` entries survive.
  A refresh can still change *one* id if OSM deletes the specific node a cluster was named after —
  the damage is now local and `npm run check:overrides` names it, instead of every id shifting at once.
  Verified by rebuilding all 13 resorts (`check:graphdiff` → identical) and by reshuffling a resort's
  Overpass input order and confirming every id and edge came out the same.
  - *Historical note (why this matters):* ids used to be a global counter, so any refresh silently
    repointed override entries. Past `addConnectors` became multi-km "teleport" links (e.g. a 12 km
    flat traverse in Madonna) that quietly corrupted routing. **`npm run check:overrides`** still
    exists as the safety net: it flags long connectors and classifies them **stale** (redundant:
    removing changes reachability nothing → the ids point at already-connected nodes) vs
    **load-bearing** (removing strands nodes → probably a real long link like a skiroute or
    pedestrian gondola — verify, don't auto-remove). To recover a connector's *original* intent, read
    its endpoints' coordinates from the `graph.json` at the commit that added it
    (`git show <commit>:public/resorts/<id>/graph.json`) and map those coordinates back to today's ids.
  - **Edge ids (`e<idx>`) are still order-dependent** — a follow-up. They leak into user localStorage
    (`edge:<id>` closure keys, `customNodes.attachEdgeId`), so those entries can still be orphaned by
    a rebuild. Closures keyed by name (`lift:<name>`, `piste:<ref>~<name>`) are already stable.
- **Long lines running parallel to a polygon spine are gateway *forks*, not stray arms.** A gateway
  arm is replaced by two forks jumping to points ±`FORK_M` (40 m) along the spine, so on a narrow
  polygon they necessarily lie almost on top of it. Measured at Ischgl they are 38% of all arm length
  and 55% of everything drawn within 5 m of a spine. They are load-bearing (they make gateway
  crossings work in both directions), so do **not** "fix" them by widening `ARM_CLIP_M` — that was
  tried and moved the number the wrong way (29.4% → 32.1%).
- **A slope's direction comes from its endpoints, so a run that *starts by climbing* can strand its
  own lift.** `buildGraph.ts` orients every piste segment high→low from its two endpoint elevations.
  Cervinia's run 72 Furggsattel (`w58069456`, `piste:difficulty=intermediate`) is drawn starting **at
  the chairlift top station**, climbs **+21 m over the col in its first 91 m**, then descends — so the
  opening stretch was flipped to point back at the station and the chair lost its only ski-out,
  trapping the sector. The DEM was innocent (it agreed within 2 m at every node); the *rule* was the
  bug. Fix: when a way starts at a lift station and its opening segment climbs by more than
  `maxTraverseClimb` but no more than `liftAccessClimbMax` (40 m), emit an **extra one-way connector
  in the as-drawn uphill direction** alongside the untouched descending piste. It is not flagged
  `synthetic` — it comes from real OSM geometry and is load-bearing lift access, not an app guess —
  and `cost.ts` charges `CLIMB_SECONDS_PER_M` (12 s/m) on it, so a 20 m push costs ~4 min and the
  router will not abuse it. Blast radius is exactly **14 edges fleet-wide**, all 28–203 m; count them
  any time with the census in the session artifacts.
- **Off-piste is not a piste, and importing it as one is a safety bug — but the trigger must be
  `piste:difficulty`, not grooming.** We mapped `piste:difficulty=freeride|extreme` straight to black
  and routed over unmarked, unpatrolled, avalanche-exposed terrain with no signal to the skier.
  Tignes' Leisse even carries `patrolled=no`, `piste:grooming=backcountry` **and**
  `note="Off-piste. Under your responsability."` — three explicit warnings, all ignored. It also
  manufactured phantom connectivity defects: the Balme couloirs and Leisse were both reported as
  trapped basins when nothing was missing from OSM. `NormPiste.offPiste` / `GraphEdge.offPiste` now
  carry the flag, `cost.ts` refuses those edges unless `Preferences.allowOffPiste` (default
  **false**), and `trappedBasins.ts` does not count them as stranded piste.
  **Do not widen the trigger to `piste:grooming=backcountry`.** Measured fleet-wide: freeride/extreme
  is 205 ways (2.5%), but backcountry-alone is another 169 ways and **17.4% of St. Anton** — that is
  how mappers tag a signposted *Skiroute*/itinéraire, which is marked, advertised terrain the user
  has already reviewed and kept. Grooming is corroboration, never the trigger.
- **A snap must never split a line at its own endpoint.** The dead-end→line snap pass projects an
  endpoint onto a nearby piste and splits it there. When the projection lands **on that line's own
  end node**, the "upper half" is zero-length, a later pass drops it as degenerate, and the surviving
  half then starts at the synthetic `s…` copy — orphaning the real node and taking everything above
  it out of the graph. At Monte Pana (sella-ronda) this happened **twice at 0.0 m**: `sn608511307`
  on top of `n461618303` (start of `w401909471`) and `sn608511305` on top of `n290213577` (start of
  `w47843680`), and the basin above ended up with **zero in-edges**. Fix: if the projection is within
  `Hmerge` of either endpoint of the target edge, **reuse that node and do not split** — `Hmerge` is
  already the project's definition of "same place". Recompute the link length afterwards, because the
  attachment point moves from the projection to the node.
- **`conveying` is a fourth way-family, and an escalator can be a sector's only way in.** OSM tags
  resort escalators and moving walkways `conveying=yes|forward|backward|both` on an ordinary
  `highway=steps`/`footway`, so queries for `piste:type`, `aerialway` and `railway` all miss them.
  Ortisei's **La Curta** (`w29910707`, `w29912017`, `w1123139686`) is the escalator chain from the
  village up toward the Alpe di Siusi side, and the outside node it should reach is literally named
  "La Curta (top)". It must be modelled as a **lift**, not a connector: `maxTraverseClimb` is 8 m and
  gates every connector path, while the La Curta chain climbs **56 m**. Hence `LiftType
  'people_mover'`, which is deliberately
  **absent from `ALL_LIFT_TYPES` and the prefs UI** and therefore **exempt from the
  `allowedLiftTypes` gate in `cost.ts`** — every returning user's persisted array predates the type,
  so gating it would silently re-strand the sector (the same class of bug as the `speeds` map).
  **Changing `buildQuery` does not invalidate the cache** (keyed by resort id + TTL), so this needs a
  full `data:refresh` before it does anything.
  **Do not expect the import to have freed Alpe di Siusi — it did not, and it cannot.** The escalator
  welds correctly (base → escalator → 18 m connector → escalator → the Ortisei–Furnes gondola base),
  but the trapped sector's ski-out ends **259 m away across Ortisei's pedestrianised main street**,
  and the fleet refresh that activated `people_mover` left the resort's trapped count unchanged
  (44 → 44). OSM **half-tags** that street chain: some segments of Streda Rezia / Streda Pedetliva
  carry `piste:type=connection` and are already in our graph, the rest (`w30633601`, `w114144111`,
  `w1028635548/9`, `w1351892632`) are untagged. **Reviewed by the user and signed off as an island**
  (`acceptedBasins` in `overrides/sella-ronda.json`, overlay `public/devtools/overlays/ortisei-gap.json`):
  no synthetic link is to be added — the honest fix is upstream in OSM.
- **Validate the probe before you believe the probe — including the argument order.** `near-point.ts`
  takes `<resortId> <lon> <lat> <radius>`; called with lat and lon swapped it reported **"0 ways
  within 260 m"** at a point where a way demonstrably *starts*. A confident zero is the most
  dangerous probe result there is. The same day, two Overpass mirrors returned HTTP 500/502 for a new
  query and the obvious conclusion — "my query syntax is wrong" — was also wrong: re-running a
  **known-good** query against the same endpoint failed identically, proving the servers were down.
  Always have a known-good control before blaming your own change.
- **Longest-run "doubling-back"** was winding piste edges (descend-then-climb) over-rewarded by
  raw length; fixed by scoring straight-line progress and penalizing internal uphill.
- **Islands / one-way sub-areas**: find via strongly-connected-component analysis, not just
  dead-end leaf checks; fix with `overrides/<id>.json` connectors. Some islands are legitimate
  (e.g. only reachable by a ski bus) and should be left disconnected.
- **Trapped basins** (`check:basins` / `check:trapped`): terrain you can ski *into* that can never
  get back to the resort's **main body** (the largest SCC). This replaced a narrower "one-way
  pocket" test (an absorbing SCC containing a lift), which was wrong in two directions — both
  found by a human eyeballing the overlay and saying *"everything I circled is trapped, not just
  the bit you painted"*:
  - it **demanded a lift**, so it missed stranded runs with no lift (Tignes' Balme couloirs, Leisse);
  - it painted only the absorbing **core**, hiding the upstream slopes that merely drain into it.
  Asking the honest question instead — *can this node get back to the main body?* — immediately
  found that the **entire Alta Badia half of Sella Ronda (437 nodes, 42 lifts) could be skied into
  and never left**, a defect that `check:trapped`, `check:resort` and the pocket test all passed.
  The original symptom class is still the loudest: Monterosa routed **1 of 72** bottoms because OSM
  placed the Punta Indren cable-car station ~280 m from the rest of the Passo dei Salati hub.
  Two lessons that must not be re-learned:
  - Never define the main body by **size rank** ("ignore the largest pocket") — that silently
    swallowed a real satellite area when it happened to be the biggest. Use the largest SCC as the
    main body and report `mainShare`, so a fractured mountain (Sella Ronda: 59%) announces itself.
  - A basin is only worth a human's time if **piste edges** are stranded. Filtering on that alone
    took the fleet from 122 noisy hits (lone dead-end nodes, goods ropeways, nursery drags —
    nobody could ski there anyway) to **29 real ones**.
  - **The proposed escape has two halves, and each was wrong on its own axis.** *Which basin node
    to leave from* is ranked by how many trapped nodes it **frees**, not by proximity (above).
    *What to aim at* must include **points along a run**, not just its endpoints: a run carries a
    node where it meets another run and nowhere else, so a node-only search is structurally blind
    to the entire middle of every run and always over-states the gap. Fleet effect: 48 of 72 basins
    improved, 8.8 km of phantom gap removed, the worst single case 1637 m → 146 m. Ground truth for
    the fix is Sella Ronda's Nives cat-track, where a human found by eye the line the detector could
    not (157 m as **interior vertex 6 of 25**); it now reports 156 m along that exact way. Two
    things this must never do: **lift edges are excluded** from the projection index — a cable is
    not a place, and including them handed St. Anton's Flühen basin a target 10 m away and 162 m
    **up**, the Rüfikopfbahn passing overhead (lift *stations* are still valid, they are nodes) —
    and it stays a **review aid**: it proposes, a human disposes, nothing is ever linked
    automatically. When you change it, re-diff the reported gaps against the accepted sign-offs,
    because a sign-off's stated gap is the number the human judged on and it goes stale.
- **bbox spill** (`pipeline/lib/bboxSpill.ts`, automatic in `build.ts`): Overpass returns a way in
  **full** if *any* of its nodes touches the bbox, so a neighbouring resort's terrain leaks in —
  Cervinia carried Monterosa's Sant'Anna–Colle Betta chair and its B1 run. The test must be
  **disconnected *and* majority-outside the bbox**; neither half works alone. "Wholly outside" is
  too weak (Colle Betta's top station sits **11 m** inside Cervinia's bbox, enough to keep the whole
  fragment), and "majority outside" alone would bite legitimate terrain, since a main body routinely
  spills past a hand-drawn bbox. Both together flag exactly 3 fragments fleet-wide, all genuine.
  When the leaked terrain is a whole *sector*, the honest fix is **tightening the bbox** — which
  declares what the resort *is* — not deleting pistes.
- **Not every lift is an `aerialway`.** Funiculars and cogwheel railways are tagged `railway=funicular`
  / `railway=rack`, so a query for `aerialway` alone silently misses them — for years we fetched
  **zero** of the 22 that exist across the fleet. They are ordinary ski lifts to a skier and several
  are a sector's **only** way back up: Les Arcs' Funiculaire Les Arcs' Express (the Bourg-Saint-Maurice
  valley return), Tignes' **Funival** to the Grande Motte glacier, Zermatt's Sunnegga, Courchevel's
  Croisette, Sella Ronda's Gardena Ronda Express. Without them the terrain above reads as a trapped
  basin you can ski into and never leave — which is exactly how this was found. `RAIL_LIFT_TYPES`
  in `overpass.ts` drives both the query and the lift/piste split; a rack railway is modelled as a
  `funicular` because for routing both are a fixed track carrying skiers both ways.
- **Changing the Overpass query does NOT invalidate the cache** — it is keyed by resort id (and TTL),
  not by the query text. After editing `buildQuery` you must `npm run data:refresh` **every** resort
  or they silently keep serving data fetched by the old query.
- The OSM cache is keyed by **resort id, not bbox** — after changing a bbox you must
  `data:refresh` to actually re-fetch.
- **False-elevation reversals** (arrows/ski-direction wrong): a mis-sampled DEM elevation at a
  junction flips a piste segment. `npm run check:audit` flags them as "reversal candidates"
  (a piste starts at a node reachable only via an *uphill* flat); fix with `setNodeElevation`
  in `overrides/<id>.json`. `npm run data` prints an `audit:` line when a resort has candidates.
  Most of this is now **automatic**: the **elevation-consensus pass** (`pipeline/lib/elevationConsensus.ts`)
  cross-checks every node against a second DEM (Terrarium, shared with `check:elevation` via
  `pipeline/lib/terrarium.ts`) and repairs the nodes whose piste edges reverse under both the point
  sample *and* a smoothed median. It runs **after** the overrides and **pins** every node a human
  set, because a hand fix often cures a reversal by correcting the *neighbour* — judging the raw
  field would make the pass re-solve a solved spot a second, different way. On a fresh Sölden with
  its 8 hand fixes removed it reproduces 5 of them unaided. Disable with `--no-elevation-consensus`.
  Two hard-won guards, each one a bug we shipped and measured:
  - **Adoption is guarded by reachability, not by elevation plausibility.** A node *becoming* the
    high end of its neighbourhood is legitimate (that's what a reversal repair looks like), so the
    only safe invariant is that nothing gets stranded from the lift network. Corrections that
    strand terrain are reverted, blaming the stranded node's own correction first and widening only
    if none is corrected — blaming the whole neighbourhood once cost 6 good repairs for 1 bad node.
  - **A monotonic reseat is a topology repair, not a measurement**, so it is capped at
    `RESEAT_MAX_M`. Uncapped it once fabricated a 76 m error to satisfy the slope constraint.
  Blind adoption of the second DEM is ~80% right and the other 20% is actively harmful, so the pass
  declines rather than guesses; whatever it declines still shows up in `npm run check:resort`.
- **Ski sinks** (second category of the same pass): a node every skiable edge *arrives* at and none
  leaves — you ski in and can only get out by riding a lift or climbing. Most are real (a valley
  station, the bottom of a bowl), so **topology alone cannot tell you**: a genuine bottom looks
  identical. The tell is that the node is an **isolated outlier** — it reads ≥`SINK_MIN` below the
  second DEM while *every* neighbour agrees with that DEM within `SINK_NBR_AGREE`. If the neighbours
  disagree too, it's a systematic offset between two datasets over the whole area, not one bad point,
  and we leave it alone. **Lift stations are deliberately included**: `repairPotholeElevations` skips
  them by design, so this is the only pass that can catch a mis-seated station — and a station is
  exactly where a sector's runs converge. Worked example: Sölden's Giggijoch read 2262 m against a
  true ~2274 m and single-handedly trapped a 13-node basin, because at −13 m over 44 m its cat-track
  is too steep to earn a reverse traverse while at −3 m it is flat enough to walk back up. Note the
  damage was **not** a reversed arrow — nothing flipped — which is why the reversal category missed
  it for so long.
- **Non-skiable / mis-tagged connections**: OSM `piste:type=connection` imports as an orange
  (unrated) piste with a forced direction. `check:audit` lists "long connections" (>250 m) to
  review — some are roads/ski-bus links (long + near-flat → `removePistes` by name/bbox), some
  are lifts mis-tagged as pistes (funicular, magic carpet → `reclassifyLift`), some are real
  runs (long + steady descent, e.g. a race stadium → keep).
- **A private hiking track is not a piste, and a hand-drawn bbox is the wrong tool for saying so.**
  `isPrivateHikingTrack` (`pipeline/lib/overpass.ts`) drops a way carrying **all four** of
  `piste:type=connection` + `highway=track` + `sac_scale=*` + `vehicle|access=private`. Each signal is
  load-bearing and the conjunction was tuned against a fleet census, not guessed: without
  `connection` it swallows the **619** `downhill` ways on forest roads (21.6% of Paradiski) that are
  genuine named runs — *Città dei Sassi*, *Réservoir*, piste *27*; without the private tag it takes
  two more that a human reviewed and kept, one a paved village path in Mayrhofen
  (`surface=paving_stones`). As tuned it matches **18 ways fleet-wide**, all Sella Ronda, all one
  thing: the Monte Pana gravel forest road plus the Saltria tracks. All 18 were eyeballed on
  `mapdebug` before adoption.
  The real lesson is *how the old fix failed*. That road was already being deleted by hand —
  `removePistes: {name:'Monte Pana'}` plus three bboxes — but a rectangle drawn on a map only caught
  the **middle** of it: the upper 1.8 km survived as a **7-node trapped basin with no entry edges at
  all** (nothing could even ski into it) and a 3-node stub hung off the main body. A tag rule cannot
  half-cover a feature the way a rectangle can. Removing the whole road cost nothing measurable —
  main SCC 1606 → 1605, and the only nodes losing reachability were that same road's stub — and took
  the fleet from **2 trapped basins / 188 stranded to 1 / 175**. The four now-redundant override
  entries were deleted, which is the point: a generic rule should *replace* the hand fix, not sit
  beside it.
  Two traps met while doing it: (a) **`removePistes` bbox filters built graph EDGES, not normalized
  ways** — it drops any *unrated* edge whose midpoint is inside the box, so my "is this override
  redundant?" probe, which tested the normalized piste list, said "redundant" while the box was in
  fact still deleting **6 synthetic connectors** at the Santa Cristina lift base (they turned out to
  be legitimate base-area links between adjacent stations, so dropping the box was still right —
  but the probe had lied). (b) The bisect that found the culprit is the reusable technique: run
  `buildResortGraph` **alone** on cached data, then re-apply `build.ts`'s passes one at a time
  reporting the watched edges after each. It showed the graph was built correctly and
  `applyOverrides` cut 7 edges → 2, which immediately killed a day's worth of hunting for a
  non-existent snap/direction bug.
- **Not every `aerialway=*` way is a lift.** We used to accept the tag wholesale, which routed skiers
  onto private cargo ropeways (`goods` — e.g. "Zmutt" above Zermatt, `access=private`), zip lines,
  avalanche-control and dismantled lifts. `isPassengerLift` in `pipeline/lib/overpass.ts` now filters
  `NON_PASSENGER_AERIALWAYS` + `access=private|no` (`permissive`/`customers` stay — a resort lift *is*
  "customers only"). This removed **401 bogus lifts** fleet-wide.
- **`aerialway=station` on a WAY is a building outline, not a line you travel along** — 322 of those
  401. Beware the second-order effect: a station polygon shares nodes with both the lift end and the
  pistes outside it, so it acts as **accidental glue**. Dropping it can orphan a fragment, and
  `bboxSpill` then discards it — which *looks* like losing a real lift. Both cases we hit
  ("Ortisei – Furnes" in Sella Ronda, "Sant'Anna – Colle Betta" in Cervinia–Zermatt, plus 9 Monterosa
  lifts) turned out to be **neighbouring resorts' lifts** that only ever appeared because a station
  polygon smuggled them in. **Always diff removed lifts by NAME and check each one's coordinates
  against the resort bbox before assuming a regression.**
- **A lift station with zero non-lift edges usually means a clipped bbox, not a missing connector.**
  Overpass returns a way in full when *any* node touches the bbox, so a lift straddling the edge
  arrives whole while the pistes at its far end are never fetched. Check the station's lon/lat
  against the resort bbox *before* reaching for `addConnectors` (this was Tignes' Le Fornet sector).
- **Piste names are not stored on graph edges' `name`** — grepping edges by piste name silently
  returns nothing. Names live on `pisteName`/`liftName` and in `graph.points`.
- **Never write temp probe scripts into the repo while `npm run dev` is running.** Vite's watcher
  dies with `EBUSY: resource busy or locked, watch '…/pipeline/_tmp*.ts'` and takes the dev server
  with it. Put throwaway scripts in the session artifacts folder and `process.chdir()` to the repo.

## Conventions
- Static, offline-compiled data; the app is read-only over `public/resorts/*`.
- All graph rules are shared/global — **never add per-resort routing code**; add a resort via
  `RESORTS` + `npm run data <id>` (+ an optional override). See README "Adding a resort".
- Synthetic/inferred edges are always marked and visually distinct.
- Comments explain non-obvious *why*, not *what*.

## Routing objectives & speed model
- **Find route is multi-objective.** `prefs.routeType` = `balanced` (one best route per objective,
  deduped) or a single objective (`fastest` / `fewest_lifts` / `preferred` / `longest`, ×3). Ranking
  is a lexicographic-with-tolerance comparator over a single **base order — Preference → Lifts →
  Skiing → Time** — with the active objective's key promoted to the front (`src/routing/ranking.ts`).
  Time is the *least* important key by default (skiing isn't driving).
- **Only piste metres count as "skiing".** The `skiing` rank key sums `kind === 'piste'` legs only.
  Counting connectors made a chain of app-inferred gap-fills look like extra skiing, so a 200 m
  twisty connector route outranked the 40 m direct line on the key meant to reward real terrain.
- **`distance` is an exact final tie-break** appended after all four keys. Every other key compares
  within a tolerance, so without it two "effectively tied" routes were ordered arbitrarily — which
  is the other half of how a needless detour won.
- **Two options are distinct only if they use different named terrain.** `terrainKey()` in `plan.ts`
  keys a route by its ordered sequence of named pistes and lifts, skipping connectors and collapsing
  consecutive legs of one run. Differing solely in which bridge or gap-fill is crossed is not a
  choice a skier can act on, so those options dedupe to one.
- **An objective badge is suppressed when its margin is noise.** Balanced only offers the `longest`
  candidate when its piste metres beat the best pool route's by more than the ranking layer's own
  skiing tolerance (`skiingTolerance`, 100 m or 5%) — otherwise a 40 m hop gets badged "Longest".
- **A tolerance belongs on secondary keys, never on the key the user asked for.** On a *secondary*
  key a generous tolerance says the right thing — "these are effectively the same, so prefer the
  nicer one". On the **promoted** key it produces a badge that contradicts the number beside it.
  Mount Hermon shipped 8 min / 2.5 km badged **"Fastest"** above a 7 min / 1.9 km option, because
  480 s vs 420 s is *precisely* the comparator's 60 s floor, so time tied and "Skiing" (more piste
  metres) decided the objective the user had explicitly asked be decided on time. `compareKey` now
  takes a `lead` flag: the promoted key ties only when the app **displays** the two values the same
  (whole minutes via `fmtDuration`, 0.1 km via `fmtDistance`). Fleet effect was not just cosmetic —
  `probe:plan` on les-deux-alpes went 1.054× → 1.044× with detours over 1.25× dropping 11 → 6.
- **A badge is assigned from the pool, but the cards are not the pool — reconcile at the end.**
  Balanced badges `bestOf(pool, objective)`, then *appends* the "Alternative" fallback drawn from a
  wider set (`pool ∪ longRoutes`). So a route the fastest comparator never saw can land on screen
  showing fewer minutes than the "Fastest" card. `reconcileLabels()` in `plan.ts` moves a label to
  whichever **shown** card actually wins on that badge's own metric, at display resolution.
  Widening the pool instead was rejected: that changes which routes are *offered*, not just how
  they are labelled. `npm run probe:badges all` is the standing guard (0 violations / 1481 plans).
- **The longest-descent search walks the graph directly, so it must be handed the preference gate.**
  `longestDownhillPaths`/`longestDownhillRuns` filter on `maxColorRank` alone and never call
  `edgeCost`, which quietly made them the only searches in the app ignoring closures,
  "avoid app-added bridges" and — a **safety** bug — the off-piste opt-out. They returned routes
  over unpatrolled freeride terrain with `allowOffPiste` false, and because `edgeCost` refuses such
  an edge (`allowed:false, seconds:0`) `buildRoute` charged **0 s** for it: a Paradiski card showed
  375 m of black off-piste as a **0-minute** route. Both now take an `EdgeAllow` predicate, passed
  from `plan.ts`. Any future search that bypasses `edgeCost` needs the same treatment — and note
  the 0 s is the tell: a leg with distance and no duration means an edge the cost model refused.
- **Longest** = max-km **lift-free** descent A→B, exact via a DAG longest-path (`longestStreak.ts`);
  only falls back to a lift if B is otherwise unreachable. The resort-wide "Longest runs" card is the
  only feature that ignores A and B.
- **Speed/time model** lives in `src/config/speedModel.ts` — see **docs/SPEED_MODEL.md**. Key idea:
  routing uses **progress speed** (down the centerline), the UI shows **true move speed**
  (`progress × snakeFactor`), and measured GPS speeds are true speeds divided back to progress. Base
  per-colour speeds are derived (never persisted) so stale localStorage can't override them.
- **A lift's ride time comes from OSM when OSM knows it.** `aerialway:duration` is a published fact
  that already includes terminal acceleration/deceleration, and **60% of our lifts carry it**, so
  the pipeline emits it as `GraphEdge.rideSeconds` and `cost.ts` prefers it over length÷speed. Only
  the *tagged* value is ever emitted — never a derived one, because baking our own estimate into
  `graph.json` would freeze it and silently override the speed settings. Our estimates were worth
  replacing: real÷estimated ride time ran median 0.82×, p10 0.50×, p90 2.16×.
- **Per-type lift speeds are measured, not guessed; per-type waits are the opposite.** The speeds in
  `DEFAULT_SPEEDS.liftSpeedByType` are medians derived from those duration tags — re-derive them any
  time with `npm run probe:liftspeed`. Chairs were long set to 2.5 m/s, which is the **fixed-grip**
  speed applied to every chair and 73% too slow for a fleet that is mostly detachable; the
  distribution is bimodal and `aerialway:detachable` cannot split it (only 11% carry the tag). The
  **queue waits** have no data behind them at all — they are deliberately *typical, not peak*,
  because guessing high would make every route pessimistic all day. Peak queues are a live-status
  problem, not a constants problem.
- **Lift speeds and waits are constants, not preferences — so they must be re-derived on load.**
  Nothing in the UI edits them, but `loadPreferences` spreads `speeds` shallowly, so a stored copy
  would replace the whole map and pin a returning user to the defaults from their first visit. Both
  maps are therefore force-reset in `state/preferences.ts`. Any future app-constant added under
  `speeds` needs the same treatment.
  `buildGraph.ts` assigns `connectorKind` by *direction* alone (`oneWayDown ? 'skiable_down' :
  'flat_traverse'`), so every bidirectional link is tagged a flat traverse however steep it is —
  and flat pace (1.875 m/s) against skiing pace (8.75 m/s) means a mislabel costs **4.7×**. That
  single mislabel was the main reason routes refused to stay on the polygon spines: a 12.3 m Val
  Thorens spine segment dropping 2.0 m (**16%**) cost 6.54 s and lost to a 14.7 m sidestep onto the
  parallel polygon copy at 4.71 s. `cost.ts` therefore treats a connector as skiing when
  `connectorKind === 'skiable_down'` **or** its measured grade reaches `flatGradeMax`. Direction
  semantics are untouched — a bidirectional link stays bidirectional, and going up it still pays
  `CLIMB_SECONDS_PER_M`.
- **Climbing costs the same on a piste as on a connector.** The climb charge used to apply only to
  connectors, so a route could gain height along a piste for free and a hairpin (up a piste, back
  down) beat the direct link into a destination. Both branches now charge `ascentM *
  CLIMB_SECONDS_PER_M`. Any new edge kind must charge it too.
- **The fix for a bad route is usually in the cost model, not in a new preference.** Both defects
  above looked like "the router prefers the wrong line" and were really one bug: a discrete label
  standing in for a physical quantity. Measure the competing options' actual seconds before adding a
  penalty or a toggle.

## UI / styling (see docs/STYLE_GUIDE.md)
- **UI = Material UI (MUI) + a shared light/dark theme.** Source of truth: `src/theme.tsx`
  (+ `src/theme-context.ts`), which builds the MUI theme AND mirrors it to CSS vars
  (`--bg/--panel/--text/--accent/--glass/…`) so MapLibre-coupled overlays follow the theme.
- **Going forward, new/changed UI uses MUI components + theme tokens (per the style guide),
  not ad-hoc CSS**, whenever possible.
- **Do-no-harm:** styling is presentational only — never change routing/graph/nav math, state,
  or module signatures for a visual result. Keep logic in pure modules; verify `npm run build`
  + `npm run lint` stay green and behavior is unchanged.
- **MUI owns the chrome** (AppBar, controls panel / mobile bottom sheet, cards, route options,
  nav banner, legend + layer selector, Snackbar/Dialog). **MapLibre visuals stay tokenized CSS**
  (location puck, on-map arrows, route lines, piste badges, pin hints) — they must read over the
  unchanging map tiles in both themes, so don't tie them to the light panel colour.
- Mobile = **bottom sheet** (≤820px), not a bottom-nav bar.
- **Global vs resort is an explicit MODE, not a zoom range** (`globalView` in `App.tsx`, threshold
  `RESORT_MARKER_MAXZOOM` in `MapView.tsx`). Zooming out past the threshold enters global view; the
  **only** ways out are picking a resort from the list or clicking its flag. Driving it off zoom
  alone was broken from both sides: zooming *in* made a non-selected resort's flag vanish with
  nothing in its place, and the A/B pins are drawn at a fixed pixel size, so they kept rendering
  *larger than the whole resort* once it shrank. Three things this needs, each a bug if omitted:
  - **A camera guard.** Leaving global view re-frames with an `easeTo` that *starts* at the
    zoomed-out level, so the zoom handler would see a low zoom with `globalView` already false and
    flip straight back. `cameraGuard` suppresses the transition during our own animations.
  - **A frame sequence number.** Clicking the flag of the resort you are already on changes no
    state, so nothing would re-frame. `resortFrameSeq` makes every selection distinct.
  - **One owner per layer.** Global view and the layer-picker toggles both set `visibility` on the
    piste/lift layers, so global view is folded *into* the toggle effect rather than fighting it —
    otherwise leaving global view leaves the pistes hidden.
  Pins get their **own, higher** threshold (`PIN_MINZOOM`): at the mode threshold a resort is
  already only ~30 px across. The route line is deliberately *not* gated — it stays readable when
  zoomed out, and hiding it could blank a long route that "fit to route" had just framed.

## Outstanding follow-ups (not in v1)
- Login/accounts; Strava integration for personal average speeds.
- Live lift status & queue/wait times; live GPS turn-by-turn; 3D terrain; offline/PWA.
- A few resorts have real-world dead-ends and genuinely disconnected areas: measured over the
  fleet, **9 one-way dead-ends** (ski in, no way back) and **9 true islands** (nothing connects
  at all) across **7 of 15 resorts**. All are reviewed and signed off in `acceptedBasins`, so
  `check:basins` reports 0 unexplained. Not all are small — Zermatt's Balmbrunnen dead-end is
  329 nodes and Sella Ronda's Alpe di Siusi island is 175 nodes / 23 lifts, i.e. whole sectors,
  not stubs. Never bridge one to make a number go down.
- Consider a license file before going public (see README).

### Sharing user-contributed data across users (closures + custom links/edges)
Today, closures and custom nodes/edges are **per-browser only** (`src/state/closures.ts`,
`customEdges.ts`, `customNodes.ts` → localStorage). Idea: let one user's contributions surface
to others as **suggestions** they can accept (which just writes into their own local store).
The UX is easy (pre-populate the existing Closed / Custom-link panels with dimmed
"community-suggested, unverified" items); the real work is a shared store + trust + freshness.
Phased plan:
- **Phase 0 — share by link (no backend):** encode a user's adds into a `?share=…` URL to send
  manually. Zero infra.
- **Phase 1 — read-only community list (admin-published):** a small serverless API + table; the
  app downloads a curated list; only an admin writes. Admin identity options: (A) edit the
  source/DB outside the app (no auth), (B) a secret admin key checked server-side, or
  (C) **Azure SWA built-in auth + an `administrator` role** (recommended — no password handling).
- **Phase 2 — two-way crowdsourcing:** anonymous/attributed writes with **confirmation-count**
  voting, **unverified** labelling, **difficulty-filtering for safety** (never suggest terrain
  above a skier's level), and **daily TTL** for closures (expire at end of day, resort timezone).
Safety note: a wrongly-suggested "skiable" connector can be dangerous, so community edges must
stay suggestions, be filtered by the user's ability, and never auto-apply.

### Live lift/piste status (assumed-open today → best-effort feed later)
The app assumes every lift/run is **OPEN** and shows a once-per-resort-per-day notice
(`src/state/statusNotice.ts`) with the resort's official `infoUrl` (in `RESORTS`) + a tip to mark
things closed. Making status *real* is a research-heavy follow-up; findings so far (Aug 2026):
- **No universal free API.** OnTheSnow/Mountain News Partner API has the broadest coverage
  (lifts+runs) but is **gated + likely paid** (contact sales for a key; 5k req/day). **bergfex /
  skiresort.info** cover the Alps incl. pistes but have **no public API**. **liftie**
  (`liftie.info/api/resort/<id>`) is free/open but **lifts-only**, ~7 of our resorts, and it just
  **HTML-scrapes** each resort (brittle CSS/`data-show`/SVG-fill-colour selectors).
- **Static-site is fine** — don't scrape client-side (**CORS blocks reading resort HTML**). Do it
  **server-side** via a scheduled **GitHub Action** (scrape → write `public/resorts/<id>/status.json`
  → build+deploy) or an **Azure SWA managed Function (timer)** writing to blob (decouples from code
  deploys). Server-side fetch has no CORS/auth problem.
- **Sölden recon (INTERMAPS platform, powers all Ötztal):** `GET
  https://www.soelden.com/en/nui/live-info/widget-data?documentId=<any>` returns clean JSON but only
  **summary counts** (`"8/9"` lifts, `"41.9/42.4km"`, huts) — `documentId` is ignored. **Per-lift
  detail is server-rendered HTML** on `/en/live-information/status?card=lifts` (no XHR), so
  knowing *which* lift is closed needs HTML parsing. Expect this "clean summary JSON + HTML-only
  detail" split at other resorts too.
- **Integration is cheap:** a feed just auto-populates a per-resort "closed today" set merged with
  the user's manual closures — `src/state/closures.ts` + existing Find-Route avoidance handle it,
  no new routing code. Model `status.json` as per-lift `{open, hours}` + per-piste `{open, groomed}`
  + a `fetchedAt` stamp; show a "best-effort, as of HH:MM" chip (default, no button).
- **Recommendation:** build the real adapters **closer to the season** (summer feeds are empty; HTML
  layouts will change by winter). Start with 1–2 resorts, prefer any that expose true JSON, and keep
  "assumed open" as the fallback where there's no data.

