# AGENTS.md — SkiWays

Handoff/orientation doc for humans and AI agents picking up this project. Keep it
**public-safe**: no secrets, no exact cloud resource names, no personal emails, no internal
URLs. Operational specifics live in `NOTES.local.md` (git-ignored).

## Local backlog
`BACKLOG.md` is the canonical **local, git-ignored** backlog. When listing, selecting or
updating backlog work, read that file first and preserve its stable B/F/V identifiers,
categories and statuses instead of reconstructing a list from historical notes.
Update the same entries as decisions or work progress; a session task database is only
a convenience mirror. Do not stage, force-add, commit or publish `BACKLOG.md`.
The file is not distributed with a clone or worktree. If it is missing, obtain the
user's local copy or the known main-checkout copy rather than inventing a replacement.

## What this is
**SkiWays** — "Navigate the slopes." Plan a route from point **A** to point **B** on a
mountain by combining downhill pistes and uphill lifts, respecting the skier's ability
(max difficulty), slope-color preferences, allowed lift types, and lift opening hours, with
realistic time estimates. There is also a **Longest skiable run** finder (longest lift-free
descent for your level). No login in v1 — preferences persist in the browser (localStorage).

**Branding:** the app name is SkiWays; the repository/package retain their existing
SkiWaze / `skiwaze` names. Keep the slogan "Navigate the slopes" and its existing
translation. Browser-storage keys are compatibility identifiers, not display
branding: do not rename them or lose returning users' saved settings.
The slogan stays visible on mobile too; compact its type and tracking rather than
hiding it or increasing the header height.

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
                         acceptedBasins, acceptedDeadEnds)
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
- **An explicit `oneway=no` on a piste grants the reverse traverse, whatever the gradient.** The
  `flatGradeMax` test is our *inference* about whether a skier can get back up; the tag is the
  mapper answering directly, and we were reading `oneway` for **lifts only** and discarding it on
  runs. Madonna's link from the Fortini gondola base to the Grostè carpet (`w1131930104`, novice,
  `oneway=no`) drops 4 m over 66 m — a **6.06%** grade that misses the 6% cut-off by a hair — so it
  shipped one-way against an explicit statement that it is not. Like the lift rule this is a
  deliberate minority signal, not an editor default: **349 of 9986** downhill/connection ways carry
  it against 1449 `oneway=yes`, and Alpe d'Huez settles what it means there — nine ways named
  *"zone plate"* (flat zone) all carry it. Same two guards as the aerial-lift rule: **grant-only**
  (`oneway=yes` is never honoured — on a piste it usually just restates the default, so believing
  it would strand terrain on no evidence), and it waives only the *gradient* half, so
  `maxTraverseClimb` still caps it and it can never turn a real descent into a free climb.
- **A pass that re-derives another pass's decision must use that pass's own constant.** The
  `oneway=no` grant above is decided in `buildGraph` under `maxTraverseClimb` (8 m), because the tag
  waives only the *gradient* half of the test. `applyOverrides` then re-derives direction after every
  elevation correction - and its flat->slope demotion branch re-asked the same question under
  `pisteFlatTolerance` (**3 m**), knowing nothing about the grant. So a tagged two-way run with a
  4-8 m rise lost its uphill half the instant anything corrected a neighbouring node's height,
  **including corrections that left the rise completely unchanged**: Madonna's `w395878130` sat at
  6 m before and after a 4-node hand pin and was deleted anyway. Both hand overrides and the
  **elevation-consensus** pass funnel through this branch (`build.ts` calls
  `applyOverrides(g, { setNodeElevation: c })`), so the damage was fleet-wide. `GraphEdge.taggedTwoWay`
  carries the grant onto both halves at build time and the branch now honours it, still capped by
  `maxTraverseClimb`. Three things worth knowing:
  - **`overrides.ts` already contained the correct mirror and still had the bug.** Its `addFlatReverse`
    helper - written for the Avoriaz case - uses `flatGradeMax` + `maxTraverseClimb` and its comment
    says outright *"same constants as buildGraph deliberately - this is that rule, not a second one"*.
    The demotion branch beside it was the older half that never got the same treatment. A file being
    *aware* of the discipline is not evidence that every branch in it follows the discipline.
  - **Grant-only, like every other minority-signal rule here.** It can only *keep* an edge buildGraph
    already emitted, never create one, so it cannot invent a climb.
  - **The census that measured it also explains its own residue, and that is the point.** 31 runs
    across 10 resorts looked one-way against an explicit `oneway=no`; the fix recovered **3**, and the
    other 28 turned out to be two non-defects: **16** are `area=yes` polygons, which reach the graph
    through the skeleton path and were never granted a reverse in the first place, and **12** are ways
    whose rise *over the whole way* exceeds `maxTraverseClimb` and only fall under it because a later
    split cut them in half - retro-granting those would violate the whole-feature rule stated in the
    lift-direction bullet above. A census is only finished when every survivor has a name.
- **Uphill is never inferred.** Skiable connectors are downhill-only or flat/bidirectional.
- **An unrated piste inherits the EASIEST colour that feeds INTO it** (`pipeline/lib/inferColors.ts`,
  called from `buildGraph`). OSM routinely tags a real run or link `piste:type=downhill|connection`
  with no `piste:difficulty`, so it imports as `unknown` - which `cost.ts` treats as *harder than
  black* and filters out for every skier, taking whole sectors with it when the unrated segment is a
  lift top's only ski-out. The domain rationale is the user's and is the part that cannot be
  re-derived: **an easy run cannot turn difficult mid-way with no way out**, so whoever is standing
  on this segment arrived on one of its feeders, and the *easiest* arrival defines who must be able
  to keep going. Three passes, and the ordering is the safety argument:
  1. **Feeder rule** - easiest rated run feeding in, to a fixpoint.
  2. **Guarded downstream fallback** - if only a lift or connector feeds it, inherit the run it feeds
     *into*, but **only when it is that run's sole skiable feeder**. A run that is independently
     reachable must not gain a second, harder access painted easy.
  3. **Ambiguous leftovers take the HARDEST neighbour**, so experts can still use them and easy
     skiers are never misrouted onto them. The asymmetry between 1 and 3 is deliberate: rule 1 is
     reasoning about who *is already there*, rule 3 is a guess, and a guess must fail safe.
  Rated runs are never changed, and freeride/backcountry already carries `piste:difficulty=freeride`,
  so the pass can never downgrade dangerous terrain. Fleet residue: **29 of 20 751 piste edges**
  still `unknown` (0.14%), spread over 10 resorts - i.e. nothing rated touches them at all.
- **A hut or restaurant apron is graded flat, so links there are two-way even where the terrain
  slopes.** Resorts bulldoze the ground around a mountain restaurant precisely so people can
  traverse in and out, so a node that reads a few metres higher than its neighbours at a hut
  entrance is **not** evidence that the link is one-way. This is a domain fact the DEM cannot
  supply, and it is the standing explanation for a class of "both arrows look right but the node is
  higher" cases that the elevation passes will otherwise keep re-flagging. Related but distinct
  from the merge rule above, which is about huts *close horizontally at different heights staying
  separate nodes*.
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
- **A near-flat lift is oriented by the OSM drawing, not by the DEM** (`liftFlatDirectionM`, 10 m).
  Lifts are otherwise emitted bottom = lower station, which is right wherever the drop is real and
  is decided by **pure noise** on flat ground — where it silently *inverts* a lift. Madonna's
  "Tapis Roulant Grostè Express - Fortini" (`w107120077`) is a magic carpet over a road viaduct,
  drawn east→west; its stations sample 1651 m and 1649 m, so **2 m over a 134 m bridge** flipped it
  west→east and handed skiers a free crossing in the one direction that actually needs the carpet
  (an A→B route across it reported "0 lifts"). The drawing is the better witness: measured
  fleet-wide, our elevation-derived direction disagrees with the drawn one for **23.1% of lifts
  under 2 m but only 0.8% over 20 m** (8 of 1026) — mappers draw a lift bottom→top ~99% of the
  time, so a disagreement on a flat lift is far more likely to be our error than theirs. Above the
  threshold elevation must keep winning, because those few big-drop disagreements are genuine
  top-down drawings (Trockener Steg–Klein Matterhorn 844 m, Dixence–Lac des Dix 232 m). Re-measure
  with `files/liftdir.mts` — and note its trap: the Overpass cache is `{savedAt, data: RawWay[]}`
  whose entries have **no `type` field**, so filtering on `type === 'way'` matches nothing and
  reports a confident, wrong zero.
  Two corrections the rule needed, each found by censusing what it actually flips
  (`files/liftflipcensus.mts`, which reads the shipped graphs and asks Terrarium about every flip):
  - **The near-flat test is decided ONCE PER LIFT, never per segment.** `segmentWay` splits a lift
    at every junction it shares a node with, so a long line arrives as short pieces that are each
    individually "near-flat" while the line as a whole climbs properly. Judged per segment, Sella
    Ronda's **Gardena Ronda Express funicular** — ~45 m of rise cut into ten pieces of 2-7 m — had
    every piece exempted and the whole funicular ran **downhill**. The premise ("this drop is DEM
    noise, not a slope") is a statement about the *lift's own rise*, so it must be measured over
    the lift's own length. Generalise it: **any threshold that describes a whole feature must be
    evaluated on the whole feature, not on the fragments a splitter produced.** Fix alone: fleet
    flips 57 → 39, of which corroborated 28 → 17.
  - **A corroboration gate vetoes the exemption where the drop is real** (`liftDirection.ts`, run
    from `build.ts` before the graph build and fed in as `rejectDrawnLiftDirection`). The exemption
    is a bet that our elevation is wrong; where a second raster agrees the drawn-first end is the
    higher one by >`CORROB_MARGIN_M` (2 m) on **both** its point and smoothed readings, that bet is
    against the evidence and we were emitting a magic carpet, rope tow or people mover **downhill**
    — handing out a free descent and removing the uphill service the lift exists to provide. It is
    a **veto, not a vote**: it can only ever *withhold* the exemption, never grant one, and never
    touches a lift over the flat threshold. Where the second raster disagrees or the margin is
    inside noise the drawing still wins, which is the case the rule was written for (Madonna's
    Tapis Roulant reads +1.3 m in our field, −0.5 m in Terrarium). Blast radius **18 lifts across
    9 resorts**; after it, fleet flips 39 → 23 with **0 corroborated**, `probe:trappeddiff` zero
    REGRESSED. Caveat to state whenever quoting it: Terrarium is **not fully independent** — our
    field averages skadi and Terrarium wherever they agree within 8 m — so it separates these cases
    cleanly but is not a second opinion in the strict sense. Published resort information about
    which way a carpet runs beats both rasters and belongs in an override.
  - **A descending lift edge is NOT on its own evidence of a flip.** A cable is straight while the
    DEM under it wiggles, so an interior segment of a perfectly contiguous ascending tow can dip:
    Paradiski's **Replat** runs 2288 → 2290 → 2295 → **2297 → 2293**, one unbroken rope tow whose
    last piece descends 4 m over a bump near the top station. Per edge that reads as a corroborated
    defect; per lift it is the flat rule doing its job, keeping the tow in one piece instead of
    severing it. The census therefore takes its verdict on the whole **chain's** net rise — which
    is also the second reason the exemption earns its keep, beyond the noise argument.
- **A surface lift proves its own direction is not self-propelled.** Nobody builds a carpet, rope tow
  or drag along a stretch a skier can glide, so a **flat traverse running a surface lift's uphill
  line between that lift's own two stations** contradicts the lift and is dropped
  (`surfaceLiftParallel.ts`, **47 edges** fleet-wide, most carrying the lift's own name — Grenouilles,
  Replat, Dromonts, Baby Wold, Slow Vallon). Elevation cannot reach this conclusion: Madonna's "Tapis
  Roulant Grostè Express - Fortini" crosses a road viaduct whose deck rises westward, but our field
  *and* Terrarium read the two ends within 1 m of each other, because a short abrupt step over 135 m
  is exactly what a 30 m DEM erases — so the parallel bridge footway (`w395885465`) earned a reverse
  traverse at 1.5% and an A→B route across the bridge reported **"0 lifts"**. Guards: **flat
  traverses only** (a `skiable_down` or `piste` edge along a lift's uphill line means one of the two
  is *misoriented*, and deleting it would hide that — 3 such cases exist, e.g. St. Anton's
  Furka-Steinmähder/Balmengratlift); **surface lifts only**, since an aerial lift overflies terrain
  and proves nothing about the ground under it; and **never strand** — only the uphill direction is
  removed, so the paired downhill traverse always survives.
  **Do not widen this to a proximity or reachability test.** Three versions were tried and all failed
  the same way — no knee, so no defensible threshold: "both ends within R of the two stations" gives
  45/110/558 edges at R = 1/20/40 m, and "arrives at the top from anywhere that reaches the base
  without a lift" gives 324/462/625 at a 100/200/400 m budget. Those are dominated by nursery slopes
  where a skier genuinely *can* step around a 20 m carpet. When a free crossing survives this pass,
  the cause is an elevation the DEM cannot see, not a rule that needs loosening.
- **The app may not invent a way across a road.** Every synthetic edge — dead-end snap, rescue link,
  lift-top ski-out, plateau bridge — claims "these two points are close, so a skier can get between
  them", which is pure geometry and blind to what lies in between. Where a public road lies in
  between the claim is false, and worse it is *plausible*: the link is short, near-flat, and lands
  exactly where the router wants to go. Madonna's Grostè hub is the case: the resort built a carpet
  and a footway on a **dedicated viaduct** (`w395885465`, `bridge=viaduct`) precisely because the
  road cannot be crossed on skis, and we had nevertheless minted three links straight over the
  carriageway, so east→west reported **"0 lifts"**. We could not see it because **roads were never
  fetched at all**; they now arrive under their **own cache key** (`fetchResortRoads`) rather than via
  `buildQuery`, so adding them does *not* invalidate the piste/lift cache. `roadCrossing.ts` drops
  **568 edges fleet-wide** (madonna 4.8%, sella-ronda 6.5%, val-thorens 3.3%, ischgl 0.7% of synthetic
  edges) and **keeps 45** that would strand terrain. Four guards, each a way it could delete real
  terrain: **synthetic only** (a mapped way crossing a road is evidence — mappers draw that where a
  bridge, underpass or crossing exists; user `custom` links are deliberate); **tunnels/covered roads
  are not barriers**; **road bridges are not barriers either**, the reverse case, since terrain passes
  underneath; and **service roads, tracks and paths are not roads** — resort access tracks and car-park
  aisles are skied across all day. This **replaced** the `setNodeElevation` override written for the
  same hub: with the rule in place the hand fix is provably redundant, and it was removed.
- **"Never strand" has TWO directions, and guarding one is a silent bug.** Walking edges *backwards*
  from the lift stations answers "can this node get back to a lift"; walking *forwards* answers "can a
  skier ever get here", which is what the build's `unreachable=` figure reports. They are different
  questions and a single link can be the only thing providing either. `roadCrossing.ts` first shipped
  guarding backwards only and silently stranded **12 nodes** fleet-wide (sella-ronda 9) that could
  still reach a lift but could no longer be reached from one — invisible in the trapped-basin count,
  visible only in `unreachable=`. Guard both. `surfaceLiftParallel.ts` still guards backwards only; it
  happens never to have tripped this, but the same latent gap is there.
- **Rescue pass**: any node that can't reach a lift is linked to the nearest reachable node
  within `rescueRadius`; large drops become one-way so they can't be abused to climb.
- **Lift-top ski-out pass** (`liftSkiOutRadius`): a lift top with no ski-out is projected onto
  the nearest downhill piste point, splitting it and adding a synthetic skiable_down connector.
- **A snap may not duplicate an edge OSM already drew, and the base of an ascending lift is not a
  dead end.** Two guards on the dead-end snap, both found at Mayrhofen's 6er Ebenwald base. The snap
  asks "can a skier ski onward from here", which a **lift bottom fails by definition** — the way out
  is the cable — so it was inventing a link back *up* the hill (13 m over 27 m) purely so the station
  would have an exit. Gated on the lift **gaining height**, not merely on a lift departing: a
  downloadable gondola also has a lift edge leaving its top, and a gondola top genuinely does need a
  ski-out. Nothing is lost inbound either, because `liftSkiIn.ts` is the pass that guarantees a base
  can be skied *to*. The second guard is the reuse branch: where the projection lands within `Hmerge`
  of an endpoint we adopt that node, and if a **real (non-synthetic) edge already joins the two**,
  the link is pure duplication — worse than useless, since the pair is emitted two-way and so also
  asserts a reverse traversal the mapped way denies (piste `w475122536` already ran 38 m down into
  that same station). Only the reuse branch can hit this; a fresh `s…` split node cannot already be
  joined to anything.
- **A station link that CLIMBS is redundant once the station can be skied away from, and a link
  arriving at the top of an up-only lift is unusable** (`stationAccess.ts`, run from `build.ts`). The
  dead-end snap marks the links it draws out of a lift station `stationAccess`, and it runs **before**
  the lift-top ski-out pass — so at snap time a lift top with no ski-out still looks stranded, the
  snap invents a ramp, the ski-out pass then adds the correct descending exit, and nothing removes the
  first answer. St. Anton's Kindlisfeldlift top is the case a user found by eye: two one-way descents
  onto the runs below (`e2364`/`e2365`) *and* beside them a two-way ramp climbing 9.6 m over 15 m
  (**64%**) to reach terrain you can already ski down onto. Their question is the rule — *if there is
  one that goes down, why do we also need the one that goes up?* Only the **climbing half** is
  dropped: its twin descends *into* the station, which is the ski-in `liftSkiIn.ts` exists to
  guarantee. Most `stationAccess` links are near-level (fleet median 0.0 m) and those are a station's
  ordinary attachment to the snow, so the rule must never touch them. The threshold is
  `maxTraverseClimb`, **not a swept number** — the sweep has no knee (0.5 m → 311, 2 m → 164,
  4 m → 62, 8 m → 13), so the honest choice is the constant the *builder* already uses for "can a
  skier get back up this", same discipline as `POTHOLE_CLIMB_TOL`. The sibling rule is directional:
  at the **top of an up-only lift the station is a source** — you cannot board there — so a
  `stationAccess` link *arriving* at it can never be used to reach the lift and only offers a dead
  end (Verbier's "en projet" chair top, `e1365` out / `e1366` back in). Guarded on the node being the
  `to` of an **ascending** lift and the `from` of **no** lift, so a downloadable gondola top and a
  node that doubles as another lift's base are both exempt. Fleet effect: **7 climbing links and ~280
  inbound links** dropped, `probe:trappeddiff` **0 REGRESSED on all 18**, and the `probe:stationclimb`
  review population fell **5 → 1**. Both rules live in `build.ts`, not `buildResortGraph`, for the
  same reason as `liftSkiIn.ts`: they ask about edge **direction**, which the overrides and the
  elevation consensus both re-derive afterwards. Both use the two-directional never-strand guard.
- **Areas** (OSM `area=yes` pistes): **kept in the routing graph** (open bowls need them for
  connectivity) but **excluded from the render lines** and emitted separately as polygon fills.
  Never drop areas from the graph — it disconnects bowls.
- **A polygon's class is decided per polygon, and a B′ rim is never deleted.** `area=yes` polygons
  are classified **A** (a real centreline already runs under the whole shape), **B** (a corridor
  with no centreline, so one is synthesised), **B′** (a *partial* twin — a centreline exists but the
  rim wanders off it where the ribbon widens), **C** (genuinely open terrain, below `BOWL_RATIO`;
  currently matches nothing) or **D** (inert — a closed ring sharing no node with any other way
  collapses to a self-loop that `segmentWay` drops, so it paints as a fill but the router could
  never enter it). Full definitions live in `pipeline/lib/areaSkeleton.ts`'s header. Two rules:
  **(a)** the call is made **per polygon, never per edge** — one ring's edges sit at legitimately
  very different distances from the centreline (a wide polygon's far side is 100 m+ away), so an
  edge-by-edge decision deletes half a ring and fragments the graph. **(b)** a **B′** polygon looks
  like an A and must not be treated as one: measured across all 73 of them the arc the centreline
  *doesn't* cover **always** carries portals — 371 in total, **zero exceptions** — so deleting that
  rim strands real connections. B′ is handled like B, except the existing centreline is reused as
  the spine rather than a second line being synthesised beside it.
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
  3.3–16 on that ratio; nothing observed sits between 2 and 3.3. Measured Aug 2026 over 18 resorts:
  **97 of ~1375 polygons pass the two shape gates, and 33 actually adopt the gateway termini** — the
  gap is by design, since the override only fires in the synthesis branch and only when two gateways
  sit ≥35% of the chord apart, so a squat polygon that already has a real centreline never reaches
  it. (An older "46 of ~1076" here was stale and contradicted the code's own "84 of 1076"; re-measure
  rather than trust either.)
- **A corridor must be graded gateway-to-gateway too, or the checker punishes it for its own design.**
  `check:spines` grades a spine on `drop` (descent over the polygon's fall line) and `cover` (extent
  over the polygon's long axis). Both presume the polygon **is a run** — precisely what a corridor is
  not. Measured before the fix: corridors scored a median `cover` of **0.74** against **0.96** for
  every other polygon, and 5 of 33 fell under 0.55, escaping the report only because they were too
  short to clear the 150 m axis gate — luck, not a clean bill of health. A corridor therefore gets
  **neither** test; it is judged on `gwCover`, how much of its gateway-to-gateway span the spine
  covers (`gatewayCoverage` in `_spinecheck.ts`, span gate `MIN_GW_SPAN_M` 30 m, below which the two
  gateways are the same place and the ratio is noise). On that yardstick the same corridors mean
  **0.976** with **none** under 0.75 — better than ribbons — which is the proof the old number was
  measuring the wrong thing rather than catching defects. `SPINEDUMP=1` dumps every row as CSV.
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
npm run check:graphdiff <id|all>  # structural diff of the WORKING-TREE graph.json vs a git ref
                             #   (default HEAD). It does NOT build - to see a pipeline code change
                             #   you must run `npm run data <id>` first, or it reports a confident
                             #   "IDENTICAL" about the old data. Matches nodes by position and
                             #   compares edges as a multiset, so a pure id change reports
                             #   "IDENTICAL (relabelled only)"
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
npm run check:spines <id|all>  # per-polygon spine health, three independent complaints:
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
                             #   gwCover — CORRIDORS ONLY, and they get neither test above. A corridor
                             #           is the join between its neighbours, not a run, so it is
                             #           judged on how much of its gateway-to-gateway span the spine
                             #           covers. `SPINEDUMP=1` dumps every row as CSV.

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
npm run probe:stationclimb   # every app-invented link that climbs > maxTraverseClimb out of a lift
                             #   station, with the second DEM's reading at each one. Writes the
                             #   station-climb overlay + a review round. NOTE the framing this probe
                             #   originally shipped with — "probable mis-seated station" — was
                             #   DISPROVED by its own Terrarium column (every survivor agrees within
                             #   1.6 m). Elevation is not the explanation; provenance is.
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
                             #   IT COMPARES VALUES, NOT EFFECTS, so "redundant" is a hint and never a
                             #   verdict: a 1 m pin sitting on a threshold changes the graph. Madonna's
                             #   n603385508 reads redundant (live DEM 2098 vs pin 2097) yet removing it
                             #   carried the 49 m run w562245685 from -4.0 m to exactly -3.0 m - onto
                             #   `pisteFlatTolerance` - flipping a one-way piste into a two-way flat
                             #   traverse. Always snapshot, remove, rebuild and diff the edge set.
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
> the main way to eyeball routing/elevation questions.
>
> **Arrows cover LIFTS too (magenta `#b5179e`), and that arrowhead is our whole claim about which
> way a lift carries skiers.** It is the only view that can show the near-flat lift-direction rule
> being right or wrong, and it did not exist until a user asked for it — the review recipes written
> before that asserted a feature that was not there. Two things it must get right, both found the
> hard way within minutes of shipping it:
> - **"Bidirectional" is judged WITHIN A CLASS.** A surface lift routinely has a *connector* running
>   back down its own line — that is `surfaceLiftParallel` working as designed, since it deletes only
>   the uphill traverse and keeps the downhill one (11–26 such lifts per resort). Judged across all
>   kinds, that pair collapses into one double-headed arrow and a one-way carpet is drawn as two-way
>   on someone else's evidence: 3 of the first 5 lifts a user reviewed were mislabelled this way. A
>   lift is two-way only when another **lift** edge runs the reverse (the `isDownload` twin). The
>   dedupe key is by class for the mirror reason: a two-way piste is emitted as a **piste + connector
>   pair**, so keying it per `kind` draws two overlapping double heads.
> - **The collapsed pair must draw the UPHILL geometry.** A download edge is the reverse polyline of
>   its twin, so using it renders a gondola's arrow backwards on a line that looks one-way.
>   `files/flowcheck2.mts` mirrors `buildFlow` and asserts every double-headed lift is a real
>   download pair — run it after touching the arrow code, and note it is what caught the one genuine
>   defect in the population (st-anton `e1865`/`e1906`, two magic carpets on the same node pair
>   pointing opposite ways, neither flagged download).
> - **Two distinct lifts can share both end nodes, so the dedupe key needs the lift NAME.** Paradiski
>   runs Vanoise Express 1 and 2 as separate cable cars between one pair of stations (and Funiculaire
>   1/2 likewise); keyed on class + node pair, the first claimed the key and the second was drawn with
>   **no arrow at all**. Fleet-wide that hid exactly those 2 lifts. The name still collapses the case
>   the dedupe exists for, since a download twin carries its own lift's name. **Do not extend the
>   discriminator to ground edges** - a two-way ground link's two halves do not reliably share a
>   `srcWayId`, and keying on it splits ~3000 double heads fleet-wide into pairs of overlapping
>   single arrows (measured: 37590 -> 40658).
>
> **Never send the user to this map without a complete recipe.** A bare "go look at X" makes them ask
> which controls to touch, every single time. State all four, always, even when the answer is "leave
> it alone": (1) **Base map** — topo / OSM / **Satellite** (satellite for "is this real terrain?",
> topo for shape and gradient); (2) **Investigation overlay** — name it, or say **none** explicitly;
> (3) **exactly which checkboxes**, by their on-screen labels — `areas`, `pistes`, `connectors`,
> `lifts`, `spines`, `arms`, `arrows`, `names`, `overlay`; (4) **what each possible answer looks
> like**, so the verdict is a thing they can see rather than a judgement they have to reverse-engineer
> from the code. A deep link `#lon,lat,zoom,resort,wID` frames and highlights the way, but it does
> **not** set any of the four — they are sticky UI state, so say them anyway.
>
> **Spines are a permanent layer, emitted by the pipeline.** `emitResort` writes
> `public/resorts/<id>/spines.json` from the `PolyResult[]` that `build.ts` already has in hand, and
> the map has `spines` / `arms` checkboxes beside areas/pistes/connectors. Three things about this
> are deliberate:
> - **It is emitted by the builder, not re-derived by a script.** A spine view that re-derives from
>   OSM cannot see `build.ts`'s synthesis passes — that is exactly how the deleted `check:areaskel`
>   ended up classifying every polygon class `D`. Emitting from `build.ts` means what
>   you look at is what shipped, and it can never drift.
> - **It is a sibling file, not part of `geo.json`.** `geo.json` is downloaded by every real user on
>   a phone; this is a review artifact (12.5 MB fleet-wide) that only the debug tool ever fetches.
> - **Colours come from the file, not the tool.** The builder is the authority on which line is an
>   adopted centreline: `#1560ff` adopted OSM centreline (class A/B'), `#4da3ff` synthesised spine
>   (class B), `#00e0d0` stitch, `#e11d9c`/`#7c3aed`/`#0ea5a4` arms, `#7ddb4a` gateway, `#ff8c1a`
>   portal, `#e11` stranded portal. `mapdebug` maps colour → `role` only to split spines from arms
>   into two toggles. The rim is dropped — the `areas` layer already draws it.
> - **Spine blue and blue-piste blue are the same hex, so spines are drawn CASED.** `SKEL_COLORS.spine`
>   and the tool's `COL.blue` are both `#1560ff`. With `pistes` ticked an adopted spine and an ordinary
>   blue run were indistinguishable, and that collision produced a wrong reading during a polygon
>   review — a run was reported as a spine. Recolouring was rejected: the colours are the builder's and
>   they read well. The discriminator is line **structure** instead — `r-spines-case` draws a dark
>   `#0b1b3a` line 3.5 px wider *underneath* `r-spines`, and no piste, connector or lift is cased, so
>   **an outlined line is always a spine whatever colour it is**. Casing must be added before the
>   coloured layer (MapLibre draws in insertion order) and must follow the same `spines` checkbox.
>   Near-miss to watch for the same reason: `SKEL_COLORS.stranded '#e11'` vs piste red `#e11d1d` vs the
>   area fill `#e11`.
>
> The file is absent until a resort is rebuilt, and the tool treats a 404 as an empty layer rather
> than failing to load.
>
> It also has a **review list** (dropdown +
> prev/next) driven by `public/devtools/overlays/review-list.json`, which `npm run check:basins`
> writes (AGENTS and the tool's own comment both used to call it hand-written — it never was). It
> holds only the **unsigned** basins, so the moment the last one is signed off in `acceptedBasins`
> a run legitimately produces nothing, and writing that `[]` takes the reviewer off the tool with
> no error anywhere (the box only renders when the file loads non-empty). `_basins.ts` therefore
> **refuses to write an empty list or an empty overlay** — the guard `_areaskel.ts` used to carry
> before it was deleted, and the reason that deletion was safe only once the spine layer replaced
> it. Keep both files committed, and keep one entry as a schema example.
>
> **A review round must name its own overlay, or two of your five reviews are worthless.** The review
> list and the investigation-overlay dropdown are **independent** controls, so stepping the list never
> switched the overlay and a reviewer judges each case against whatever was left selected. This cost a
> real round: a user reviewed two station-climb cases with "Over-rim critical arcs" loaded and the
> panel literally saying *"(no overlay data for verbier-4vallees)"*, and reported — correctly — that
> they had no idea what they were looking at. Every review-list entry therefore carries an
> **`overlay`** field which `gotoReview()` applies before framing. Any writer of a review round owes
> it. The same round taught the presentation half: an overlay must make **provenance** legible or the
> reviewer cannot answer the question. `mapdebug` draws app-invented links **dashed** and real OSM
> ways **solid**, and every overlay line is clickable for its edge id, direction, length, climb and
> either `w<id>` or "APP-ADDED - no OSM way behind it". Note `line-dasharray` is **not** data-driven
> in MapLibre, so the dashed subset needs its **own layer** with a filter on both — and that new layer
> must be added to `applyToggles()`, or unticking `overlay` leaves half the drawing on screen.
>
> **`check:areaskel` and `check:areaclass` are deleted.** Both re-derived polygons straight
> from OSM via `buildResortGraph` and so never saw `build.ts`'s synthesis passes — they classified
> every polygon class `D` and produced nothing. `check:spines` is the live gate, and the **`spines`
> layer** above replaced `_areaskel.ts`'s `area-skeletons.json` overlay: same geometry, same
> colours, but emitted by the builder for all 18 resorts instead of frozen at the commit a retired
> script last ran. Keeping the stale overlay beside the live layer was the real hazard — two
> similarly-named spine views on one map, one of them silently wrong. `_areaclass.ts`'s findings
> were not lost with it: the class taxonomy moved to `areaSkeleton.ts`'s header and its two
> invariants to the polygon-class bullet above.
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
- The committed `package-lock.json` resolves from **public npm**. CI uses `npm ci` to install
  those exact versions, then builds and uploads `dist/`. Keep registry URLs public when
  updating dependencies; machine-specific registry configuration belongs in the ignored `.npmrc`.
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
- **Before bridging or deleting a suspicious OSM way, ask whether it CONNECTS AT BOTH ENDS.** The
  user's own triage rule, from comparing two cases side by side: at Val Thorens the odd-looking runs
  *"all start at the same point or close to other slopes and also connect again at the bottom with
  others, and you can continue skiing until a lift"* - real terrain. At St. Anton the equivalent way
  *"was going to nowhere"* - a bad import. A run that begins near other runs and rejoins something
  from which you can ski to a lift is terrain whatever else looks wrong about it; a run that starts
  or ends in isolation is the import tell. This is the human check that belongs *before* the
  mechanical ones, because every automated test we have measures connectivity **after** assuming the
  way is real.
- **Sella Ronda: Arabba Fly was the LAST forced gap on the loop - stop hunting for more.** Skier
  ground truth, so it settles a question no probe can. Four named features come up repeatedly and
  **none of them is a missing edge**: the Selva/Wolkenstein overpass, the Plan de Gralba "Città dei
  Sassi" flats, the Lupo Bianco / Pian Frataces choke, and the Corvara/Colfosco gondola bridge
  (Borest lift, already in production and already bidirectional). All four are **momentum and
  flat-ground quirks** a skier notices on the snow, not gaps in the graph. Treat a report about any
  of them as a routing-cost or spine question, never as a connector to invent.
- **A basin "obviously" needing a lift may just have an unbuilt one.** Schröcken's village gondola is
  `w660999299 aerialway=proposed`, note "in Planung". Grep OSM for `proposed`/`construction` before
  assuming a data bug.
- **…and a basin obviously needing a lift may have had one that was torn down.** The mirror image of
  the case above, and the more common one. A **lifecycle-prefixed** OSM tag — `abandoned:aerialway=*`,
  `disused:aerialway=*`, `razed:`, `demolished:` — is the signature of a dismantled lift. Our Overpass
  query matches **bare `aerialway`** only, so a **prefixed** dead lift is excluded automatically (but
  see the next bullet - the prefix is only one of three shapes, and the other two needed real code).
  The stranded terrain below such a lift is
  **correct output, not a bug**. Portes du Soleil's Torgon sector read as 7 stranded nodes above the
  village until OSM itself supplied the proof: `w44538226` *Télésiège Jorette* and `w45666705`
  *Télésiège Grands Places* are both `abandoned:aerialway=chair_lift`, `w44538224` *Fignards* is
  `disused:aerialway=drag_lift`, and their coordinates land **on** our stranded chain — corroborated
  externally by the resort now running a shuttle bus to that side. **Query the lifecycle prefixes
  before assuming a data bug, and sign the result off (`acceptedDeadEnds`) rather than bridging it** —
  a synthetic link there would route skiers to a lift that no longer physically exists.
- **A dead lift is written THREE ways in OSM, and we only handled two of them.** The lifecycle idea
  appears as (1) a **prefixed key**, `abandoned:aerialway=chair_lift` - never fetched, so free;
  (2) a lifecycle **value**, `aerialway=proposed` - caught by `NON_PASSENGER_AERIALWAYS`; and (3) a
  **top-level lifecycle key beside a live type**, `aerialway=t-bar` + `abandoned=yes`. Shape 3 was the
  gap: those ways carry a perfectly ordinary lift type, so every existing filter waved them through
  and we shipped **12 rideable lifts that do not exist**, including two Passo Tonale gondolas named
  *"Progetto Cabinovia"* and a Verbier chair *"(en projet)"* - i.e. we were routing skiers onto lifts
  that had been torn down or never built. `LIFECYCLE_TAGS` in `overpass.ts` rejects a way carrying any
  of `planned|proposed|construction|disused|abandoned|razed|demolished` as a top-level key. Three
  things about it: `v !== 'no'` is required, since `disused=no` is a mapper stating the opposite; the
  **tag is the trigger and the name never is** (every one of the 16 hits happens to be corroborated by
  its name - *stillgelegt*, *Progetto*, *en projet* - but names are multilingual and a resort may call
  a live lift anything); and it runs on the **cached** raw ways, so a plain `npm run data <id>`
  applies it. Blast radius: 16 ways fleet-wide, 12 of them previously shipping, across 5 resorts.
  Stranding was almost nil because the dead lifts largely served terrain live lifts also reach -
  exactly **2** nodes fleet-wide lost their last way in (Sella Ronda's Sass del Mul top), and those
  are signed off in `acceptedDeadEnds` rather than bridged.
- **`probe:trappeddiff` is blind in one of its two directions.** `_trappeddiff.ts` computes both the
  trapped and the orphan sets but only ever prints a REGRESSED section for **trapped** - so "0
  REGRESSED" says nothing about whether a change made terrain **unreachable**, which is the half the
  `roadCrossing.ts` lesson above exists to warn about. The lifecycle filter's only real effect showed
  up purely as `orphan 13 -> 15` at sella-ronda, with the probe reporting a clean bill of health.
  Until it is fixed, diff the orphan sets by hand before believing a connectivity result.
- **Trapped/orphan is a DIRECTED property — never walk the component undirected.** A first pass at
  Torgon flood-filled ignoring edge direction and returned **the whole 1233-node resort**, i.e. "no
  problem here", which is the wrong question answered confidently. One-way pistes mean a sector can be
  fully *reachable* and still have no way back. Use SCC (Kosaraju/Tarjan) or a directed BFS in **both**
  directions from the lift network — the same trap the "largest SCC as main body" rule exists to avoid.
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
- **An `excludeBboxes` rectangle is drawn around the NEIGHBOUR, not clipped to your own bbox.** The
  instinct is to trim the exclusion so it sits inside the resort's own box — it feels tidier and
  avoids "overlapping" rectangles. It does not work, for the same reason bbox clipping is invisible
  (above): Overpass returns a way in **full** if *any* node touches the query box, so a neighbouring
  resort's run only needs to graze your boundary to arrive whole, with the bulk of its geometry far
  **outside** your bbox. An exclusion clipped to your own edge then covers the few metres that
  crossed and misses the body of the thing you are trying to exclude — the identical half-covered
  failure as `removePistes` bboxes on the Monte Pana forest road. Draw the rectangle generously
  around the *foreign* resort, extending well past your own bbox; the excess costs nothing because
  nothing of yours is there.
- **`check:overrides` reporting N stale does not mean your change caused them.** Triage each id
  against `git show HEAD:public/resorts/<id>/graph.json`: present-both / lost-today / already-stale.
  The last fleet run was 17 pre-existing vs 3 genuinely broken; chasing all 20 would have been wasted
  work. For a lost id, find the nearest node in the new graph — if it is ~0 m away the entry just
  needs repointing (record the reason in a `_why`).
- **"MISSING NODE — id gone" can be self-inflicted: an override that deletes its own target.**
  `check:overrides` decides staleness by looking for the id in the **built** graph, i.e. *after*
  `applyOverrides` has run — so an entry whose effect is to remove that very node reports as stale
  while being fully load-bearing. `setNodeElevation` does exactly this: push a node far enough and
  its adjacent `flat_traverse` clears `pisteFlatTolerance`, the uphill half is deleted (`overrides.ts`
  271-283), the node can lose its last edge and get dropped. Les Deux Alpes `n813524822=3366` was
  reported stale for exactly this reason and was suppressing a real 42 m blue piste. **Never
  bulk-delete "stale" entries on the report alone** — snapshot the graphs, delete, rebuild, and diff
  node sets: a target that *appears* after removal was never stale. Fleet-wide, 26 of 27 were
  genuinely inert and 1 was this. (That one still stayed deleted: it was a 4 m nudge to precisely the
  DEM value, i.e. inside noise, and `check:audit` is clean without it — but that was a *measured*
  decision, not the report's.)
- **Never anchor an override to a synthetic node — it is the app's own guess, and a rule change can
  delete it.** An `addConnectors` entry pointing at an `s…`/`k…`/`sn…` id is anchored to a link a
  pass invented, so the moment that pass stops firing (or fires differently) the override goes stale
  and its terrain drops out. St. Anton's `sn249417956` was exactly this and was repointed to the real
  `n249417956`, which is the node the entry always meant. **Point overrides at OSM-derived ids**
  (`n<osm>`), and if only a synthetic id is available, that is a sign the graph rule is the thing that
  needs fixing.
- **A `check:overrides` "load-bearing" connector is a HOLD, not a to-do.** Four survive fleet-wide
  (les-deux-alpes 410 m, monterosa 285 m, st-anton 317 m and 488 m); each strands 183-1068 nodes if
  removed. Their ids resolve, so repointing is unnecessary and *re-pointing* one would move terrain
  we never surveyed - a "never invent terrain" violation. Leave them.
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
  - **EXCEPTION — polygon-skeleton `n1000000000…` ids are NOT stable.** They come from an
    order-dependent counter, so the same id denotes a *different physical point* between builds.
    Any probe that joins two builds on node id must therefore also require the coordinates to match
    (~1 m) and report how many pairs it excluded. Skipping that guard made `dirdiff.mts` report 3
    piste "direction flips" involving elevation moves of **200–340 m** — not DEM disagreement but
    two unrelated places wearing one id. The tell is implausibility; the guard removed 10 pairs and
    2 of the 3 flips.
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
- **`expert` is the one difficulty that means different things alone and in company.** On its own it
  is a legitimate marked black — the hardest graded run on the hill. Combined with
  `piste:grooming=backcountry` it is how mappers record high-alpine ground, and the conjunction is
  the *only* sanctioned widening of the rule above. Found via Verbier's **Rosablanche**: one
  ski-mountaineering glacier descent (crevasse terrain, reached on skins, no lift within reach) is
  mapped as two ways — the lower `w55151514` `extreme`, correctly hidden, and the upper
  `w446319329` off the summit `expert` + `backcountry`, drawn and routed as an ordinary black
  piste. **Half a touring route rendered as a marked run** is exactly the safety bug the rule exists
  to prevent. The conjunction stays narrow and well separated from the Skirouten: 29 ways fleet-wide
  (tignes 12, paradiski 10, les-deux-alpes 4, then singles) against **182** backcountry-*without*-
  expert, which must never trigger. Measured effect of adopting it: **73 edges / 27.4 km**
  reclassified, `check:basins` still **0 trapped / 0 stranded** across 18 resorts — off-piste is
  excluded from stranded-piste counting, so widening the trigger can only ever *reduce* phantom
  defects, never create one. Note the census had to be redone once: the Overpass disk cache is
  `{savedAt, data:[...]}`, not `data.elements`, and the first run returned a confident zero.
- **The off-piste rule has a RENDERING half, and it was missing for as long as the routing half
  existed.** `offPiste` appeared only in `cost.ts` / `plan.ts` / `longestStreak.ts` and **nowhere in
  `MapView.tsx`**, so 359 edges / **310.6 km** fleet-wide (St. Anton 131 km, Verbier 46 km, Tignes
  40 km) were drawn as ordinary solid black pistes. The map therefore advertised unpatrolled
  avalanche terrain that the router itself refuses by default — found because a user reported
  Sölden's "Ötztal black run" (`w411503401`, one 10.7 km edge, 2921→1356 m) as a suspected hiking
  path. It is a genuine freeride descent; the data was right and the *drawing* was the bug.
  Three things this needs, each a separate trap:
  - **It must be its own layer.** MapLibre's `line-dasharray` is **not data-driven**, so no
    `['get','offPiste']` expression can dash a subset of `pistes-line`. Narrow that layer's filter
    and add a complementary dashed one, reusing `SLOPE_COLOR_EXPR`.
  - **Default OFF, behind the layer toggle.** Drawing it by default makes the map contradict the
    router (`allowOffPiste` defaults false). Showing it is opt-in, exactly like the preference.
  - **Labels and arrows come off the same source** and filter on `kind === 'piste'`, so hiding only
    the line leaves a run's name and direction arrows floating over empty snow. Their filter is
    driven by the same toggle via `setFilter`. Any future per-edge visual distinction needs to sweep
    the symbol layers too, not just the line layer.
  No data rebuild was needed — `geo.json` already carried `offPiste` in feature properties.
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
  **A people mover is the ONE surface lift that can run both ways, and OSM says so in its own
  vocabulary — `conveying=both`, not `oneway=no`.** A village escalator or a moving walkway in a
  pedestrian tunnel is a *pair* of belts, so modelling it up-only removes half the service it exists
  to provide, and the `oneway` family we already honour for aerial lifts never fires here because a
  mapper tagging a footway reaches for `conveying`. `bidirectionalFor` in `normalize.ts` therefore
  answers on `conveying` first, before the `DOWNLOADABLE_LIFT_TYPES`/`AERIAL_LIFT_TYPES` gate that
  a `people_mover` otherwise falls straight out of. Found by a user looking at the new lift arrows on
  `mapdebug` and saying of Ischgl's **Dorftunnel** (`w137094192`, 199 m under the village, no slope
  anywhere near it) "it goes both ways" — it is tagged exactly that. Three guards, each a way this
  could go wrong: **`both` only** — `yes|forward|backward` all state a *single* direction, and
  `reversible` (Mayrhofen `w320793573`) means one direction *at a time*, the opposite of both at
  once; **`people_mover` only** — a magic carpet is one belt and physically cannot reverse, so
  `conveying=both` on an `aerialway=magic_carpet` is contradictory tagging we decline to believe;
  and **grant-only**, like every other minority-signal rule here, so no value of `conveying` ever
  *removes* a direction. Fleet population is the whole of **3 ways** (Dorftunnel + both halves of
  La Curta), it needs only `npm run data <id>` (the tag is already in the cache), and it changes no
  connectivity at all — trapped/orphan flat at ischgl 12/1 and sella-ronda 30/13, zero REGRESSED.
  **Do not expect the import to have freed Alpe di Siusi — it did not, and it cannot.** The escalator
  welds correctly (base → escalator → 18 m connector → escalator → the Ortisei–Furnes gondola base),
  but the trapped sector's ski-out ends **259 m away across Ortisei's pedestrianised main street**,
  and the fleet refresh that activated `people_mover` left the resort's trapped count unchanged
  (44 → 44). OSM **half-tags** that street chain: some segments of Streda Rezia / Streda Pedetliva
  carry `piste:type=connection` and are already in our graph, the rest (`w30633601`, `w114144111`,
  `w1028635548/9`, `w1351892632`) are untagged. **Reviewed by the user and signed off as an island**
  (`acceptedBasins` in `overrides/sella-ronda.json`): no synthetic link is to be added — the honest
  fix is upstream in OSM. The one-off investigation overlay was not kept, since the question is closed.
- **Validate the probe before you believe the probe — including the argument order.** `near-point.ts`
  takes `<resortId> <lon> <lat> <radius>`; called with lat and lon swapped it reported **"0 ways
  within 260 m"** at a point where a way demonstrably *starts*. A confident zero is the most
  dangerous probe result there is. The same day, two Overpass mirrors returned HTTP 500/502 for a new
  query and the obvious conclusion — "my query syntax is wrong" — was also wrong: re-running a
  **known-good** query against the same endpoint failed identically, proving the servers were down.
  Always have a known-good control before blaming your own change.
- **An Overpass error code tells you *who* is wrong, and the shell may be the one lying.** The
  control-first rule above has now been needed twice more, with two different root causes that both
  *presented* as "my query is broken":
  - **HTTP 406 is the server rejecting your query text; 500/502 is the server itself failing.** Treat
    them oppositely — 406 means fix the query, 5xx means try another mirror and stop editing. Deciding
    which one you have costs one known-good control query and saves an afternoon.
  - **PowerShell silently strips the inner double quotes out of an inline query**, so
    `way["disused:aerialway"]` reaches Overpass as `way[disused:aerialway]` and comes back as a parse
    error naming the `':'` — pointing at the colon, which is *not* the problem, and sending you off to
    debug a perfectly good tag. Never inline a quoted Overpass query: write the body to a file and
    post it with `curl.exe --data "@file.txt"` (or `--data-urlencode`), and prefer single quotes plus
    a key-regex, e.g. `way[~'^(disused|abandoned|razed|demolished):?aerialway$'~'.']`.
  Same family as the `node -e` quoting trap: **if a command embeds quotes, put it in a file.**
- **Longest-run "doubling-back"** was winding piste edges (descend-then-climb) over-rewarded by
  raw length; fixed by scoring straight-line progress and penalizing internal uphill.
- **The longest-runs search optimises DESCENT SCORE while the card ranks and labels by LENGTH.**
  That gap is one defect behind two separate user reports. `makeDescentScorer` measures straight-line
  descent *progress* on purpose (that is the doubling-back fix above), so two branches spanning the
  same pair of points score identically however much extra real skiing one holds — and the tie falls
  to the **shorter** line. Proof from the app's own A→B search: `n11191566777 → n650868757` returned
  `0.56 km via 7` **ahead of** `1.51 km via 6, 7a`, same −183 m drop, zero climb. Sölden's run 7 forks
  to a longer 7a three times and only the lower two were taken; Zermatt–Cervinia's Plateau Breithorn
  is the top of both a 15.58 km descent to Zermatt and a 13.59 km one to Cervinia, and only the
  score-maximal one was ever *generated*. Fixed **without touching the scorer** — the pool already
  ranks by length and already gates on quality, so the search merely had to stop being forced into
  one answer per start: `VARIANTS_PER_START = 3` diverse re-solves reusing `longestDownhillPaths`'s
  0.55 diversity penalty. Effects: Les Deux Alpes slots 2–3 went 5.40/4.66 km → 11.11/8.48 km.
  Two traps inside it:
  - **The penalty must be sign-aware.** `scoreOf` goes negative on a climbing leg, so multiplying by
    0.55 makes it *less* negative — penalising an uphill leg would make it look **better**. Hence
    `s >= 0 ? s * p : s / p`. Any future penalty on this scorer needs the same treatment.
  - **Overlap must be measured in METRES, not legs.** A leg count treats a 2 km motorway edge and a
    12 m junction stub as equal votes, so two variants sharing the entire upper mountain read as
    "40% different" and both got a slot. Overlap is compared against the **union of already-accepted
    runs**, not pairwise — `longdiag.mts` prints pairwise, so a candidate can pass one and fail the
    other.
  - **The shared FRACTION is the wrong gate, however it is tuned — what decides is CONTIGUITY.**
    Two years of this were spent moving one number (0.35 → 0.50 and back) before measuring the
    *shape* of what each threshold admitted. Val Thorens' runner-up repeats **40%** of the winner and
    Cervinia's repeats **47%** — adjacent numbers, opposite value. Val Thorens' is 6.33 km of its own
    terrain in **one block** that then merges onto the valley exit (there is one way down the valley,
    so sharing it is unavoidable and not a defect). Cervinia's is a **weave**: own stretches of
    1.54/2.07/3.08/0.38/0.18 km interleaved with the winner's the whole way, sharing the entire
    4.6 km run-out — one line with wobbles, shown twice — and admitting it displaced a genuinely
    separate 8.79 km descent of the Italian side down a slot. What makes a second card worth showing
    is not how much it repeats but whether the part that **differs** is one stretch a skier can go
    and ski. Hence `MIN_OWN_BLOCK_FRACTION = 0.35`: the largest *contiguous* unshared stretch must be
    ≥ 35% of the candidate's own length, with `MAX_SHARED_FRACTION = 0.5` kept only as a loose outer
    bound. The two classes separate with room to spare (VT 58%, Cervinia 22%) where the shared
    fraction puts them 7 points apart. Fleet effect: 8 of 18 resorts drop exactly one slot each, all
    weaves — Les Deux Alpes interleaves six times (largest own block 26%), Paradiski shares a 5.36 km
    middle (29%), Sölden a 4.62 km middle (25%), Tignes 24%. Val Thorens changes not at all, which
    was the test. The one marginal call is **Gudauri at 34.9%** — two own blocks of 2.24 and 2.43 km,
    not really a weave, merely chopped in the middle; reviewed and deliberately left rejected,
    because 29% → 35% is where the shape actually changes and 0.30 exists only to save that one run.
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
  **The `<=` tie-break on line 67 is deliberate, and measuring it settled the question: leave it.**
  `outside * 2 <= ids.length` keeps a component that is *exactly* half outside. Fleet-wide that spares
  **3 components, and the 35–50% band is empty** — there are no near-misses, so it is not a knob worth
  tuning. More importantly the majority test **degenerates at small n**: for a 2-node component
  `outside * 2 <= 2` means it can only ever be dropped when *both* nodes are outside, so the tie-break
  is structurally incapable of judging a boundary-straddling lift either way. All 3 affected
  components are n=2, and all are **isolated lifts with no piste attached** — which `inertFragments`
  also refuses to touch by design. Tightening the comparison would delete them for the wrong reason.
  *Related observation, not yet acted on:* those isolated lifts are largely **not ski lifts** —
  Riddes–Isérables is public transport, Dixence–Lac des Dix and Fionnay–Plan du Tsenau are dam/hydro
  access cable cars. If they ever need removing, that is a **passenger-lift classification** question
  (the `NON_PASSENGER_AERIALWAYS` family), not a bbox question.
- **Inert fragments** (`pipeline/lib/inertFragments.ts`, automatic in `build.ts`): a disconnected
  component made **entirely of app-invented plumbing** — synthetic connectors, no piste, no lift, no
  OSM way id — is not terrain and is dropped. These arise when a snap/rescue/ski-out pass builds
  links around a piste that a later pass removes, leaving the scaffolding floating with **zero edges
  to the rest of the graph**. They cannot be skied to or from, but they still counted as trapped and
  orphaned nodes, which is noise a human then has to triage. Two guards keep it honest: never drop a
  component containing a **lift** or a **rated** piste, and `MAX_LEN_M = 500`. Fleet-wide it removes
  **6 fragments (15 nodes) across 2 resorts** and took sella-ronda from trapped 44 → 29, orphan
  32 → 17, with **no** other resort changing at all. Verify any change to it with
  `probe:trappeddiff` against a pre-rebuild snapshot — a count moving proves nothing, a REGRESSED
  section is the only signal.
  **Do not "improve" it by relaxing the all-synthetic test.** The rule is deliberately about
  *provenance*, not size or shape: the moment a real OSM way is in the component, the fragment is
  evidence of terrain and the honest fix is upstream or a sign-off, never a deletion. Note also that a
  dropped component can still carry a **name** (sella-ronda's "Serrai di Sottoguda (bottom)") —
  that is a `graph.points` node *label*, not a piste, so a name is not grounds to spare it.
- **A dead end that is real gets signed off, not bridged** — `acceptedDeadEnds` in
  `overrides/<id>.json`, the directional sibling of `acceptedBasins`: `{ nodes: string[]; why: string }[]`.
  `applyOverrides` deliberately **ignores** both — they are audit filters consumed by `_trapped.ts`,
  never graph edits, so a sign-off can never invent connectivity. The `why` is the deliverable: record
  the evidence (OSM way ids, coordinates, elevations, any external corroboration) **and the
  alternatives you rejected**, because the next person will otherwise re-litigate it. Useful property:
  `_trapped.ts` **warns when a signed-off node stops being trapped**, so a sign-off doubles as a
  tripwire — write one whenever the real fix is upstream in OSM and you want to be told when it lands.
- **A sign-off's node list must be PRUNED when the tripwire fires, or the tripwire stops working.**
  The WARN is per node, so a group sign-off covering a chain keeps warning about the one node that got
  better while the other six are still correct — and a warning that fires on every run trains the
  reviewer to skip the whole gate, which is exactly the failure the `check:audit`/`acceptedDeadEnds`
  bullet elsewhere exists to prevent. Torgon's two-raster elevation rollout freed
  `n14050186237`/`n565736424` out of a 7-node group; both were removed from `nodes` and **named in the
  `why`**, so the record survives and a future re-stranding lands back under the same verdict. Prune
  the ids, never the reasoning.
- **An unsourced OSM way beside sourced siblings is weak evidence, and weak evidence loses both ways.**
  Portes du Soleil's red "Pauvre Conche" (`w30751810`) dead-ends mid-face and carries **three tags and
  no `source`**, while the black `w8215594` (`source=GPS`, `piste:grooming=classic`) and the blue
  `w274898287/8` (`source=Bing 2014`) fork from the *same* top node `n340096712` @1904 and both reach
  `n616880` @1693. The user checked satellite imagery and the published piste maps: no snow in the gap,
  and **no resort publishes a red here at all**. So it is probably an OSM sketch — and that changes
  nothing about what we do. We do **not bridge** it (137 m of invented terrain on no evidence) and we
  do **not delete** it (a real OSM way is evidence; deleting on suspicion is the mirror of inventing on
  suspicion). It gets an `acceptedDeadEnds` sign-off, which is the only move that is honest in both
  directions. Provenance asymmetry between sibling ways is a good *tie-breaker* when you already have
  a decision to make; it is never on its own grounds to act.
- **`rescueLineRadius` stays at 130 m — re-measured 2026-09-07, do not re-litigate.** The sweep
  (`files/rescuesweep2.mts`) projects every trapped node onto the nearest reachable piste line under
  the pass's own rules, minus two filters the 2026-08-29 run lacked: nodes already in
  `acceptedDeadEnds`/`acceptedBasins` (a rescue there contradicts a reviewed decision) and nodes whose
  only real terrain is `offPiste` (not stranded piste since the off-piste work). Fleet-wide that is
  **139 trapped, of which 36 signed off and 48 off-piste-only**, leaving 21 with a legal projection
  within 400 m. Cumulative new rescues by radius: **140 → 1, 150 → 1, 175 → 1, 200 → 3, 250 → 10,
  400 → 20.** So 130 → 140 buys exactly **one** case (Pauvre Conche) with a **44 m dead zone** behind
  it, and the user rejected it on the merits — there is no snow in that gap. Note the histogram moved a
  lot since August (the second near-boundary case, cervinia `n2525940038`, drifted 138 m → **221 m**
  under the two-raster elevation rollout), so **re-measure before quoting these numbers**; and note the
  sweep is a *static* approximation, since the real pass is iterative and each rescue changes what is
  reachable.
- **Override JSON has been mojibaked before — check before you read a `why` as authoritative.**
  `portes-du-soleil.json` had been through a cp1252 round-trip, so every accent and dash was stored as
  the UTF-8 bytes of its own mojibake (`Châtel` → `ChÃ¢tel`, ` - ` → `â€”`) and `check:trapped` printed
  the sign-offs garbled. Two traps in repairing it: a whole-file re-decode is **lossy**, because the
  damage is not uniform (one genuine em dash had survived), so replace the *exact* sequences present
  and assert nothing unexpected is left; and the round-trip is **cp1252, not latin1** — the mojibake
  leans on 0x80-0x9F, which latin1 leaves as control codes. Cause was `Set-Content`; the standing rule
  (use the edit tool or `[IO.File]::WriteAllText`) is what prevents a repeat.
  **`[IO.File]::WriteAllText` is only half the rule - `Get-Content -Raw` corrupts on the READ.** It
  decodes a UTF-8 file as the ANSI codepage, so a read-modify-write round-trip mojibakes every
  non-ASCII byte *however carefully you write it back*. This bit `NavOverlay.tsx` (a regex to delete
  one dead helper), turning `🚡` into `ðŸš¡` on screen - the user reported it as "jibrish in the upper
  card" - and silently damaging a `—` in a returned string, a `·`, a `⚠` and an OSM name. The repair
  is the cp1252 reverse round-trip above, run per character with an **abort on any unmappable char or
  U+FFFD** so a partial decode cannot be mistaken for a fix. The real rule is simpler: **use the edit
  tool for source edits.** Never do PowerShell string surgery on a file containing non-ASCII.
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
- **Elevation comes from TWO LOCAL RASTERS that must agree, with a rate-limited third only as
  tiebreaker.** The earlier design took the median of three *API* DEMs (EU-DEM / SRTM / Copernicus).
  It was more accurate than the old first-answer-wins chain, but it was **unshippable across the
  fleet**: two of the three votes came from opentopodata's **1 000 calls/day** cap and Copernicus
  from open-meteo, whose cap turned out to be **daily** too (one resort exhausted it in under two
  hours). A full refresh penciled out at ~4 240 calls ≈ **5 days**, which meant resorts were being
  rebuilt piecemeal on different provider states — the user's objection, and the right one: an
  elevation model that cannot be applied to every resort at once guarantees inconsistency.
  `pipeline/lib/elevation.ts` now reads two **raw rasters from AWS Open Data**, downloaded once and
  sampled locally forever, and calls a capped third **only where they disagree**:
  - **skadi SRTM 1-arcsec** (`pipeline/lib/skadi.ts`) and **Terrarium** (`pipeline/lib/terrarium.ts`,
    already in the repo for `check:elevation`). Both uncapped, both offline after the first fetch.
  - Within `AGREE_M` (8 m) the two are **averaged**; outside it the point goes to `TIEBREAK`
    (aster30m). 8 m is chosen because a spread that small cannot flip a slope's direction, which is
    the failure the consensus exists to prevent.
  - **skadi is byte-for-byte opentopodata's `srtm30m` — but only under bilinear sampling.**
    Nearest-post disagrees by up to 10 m on a slope, which reads as a dataset difference when it is
    only a sampling one; bilinear reproduces opentopodata to **0.4 m** (their integer rounding). So
    the SRTM half of this change is a *hosting* change, not a data change.
  - **Terrarium is genuinely independent of SRTM — measured, not assumed.** It was twice asserted
    here to be "largely SRTM-derived over the Alps" and that was wrong: only 7.9–10.5% of nodes agree
    within 0.5 m, median difference 2.9–4.2 m, p99 ~20 m. Had it been a repackage, this design would
    be a median of one.
  - **The tiebreak must be batched across the whole pass, not per batch.** The first implementation
    called it once per `BATCH`; at a ~20% disagreement rate essentially every batch qualifies, so
    2 120 batches → 2 120 calls — the exact cap being escaped. Fix: `BATCH = 2000` (local raster
    reads are free) and chunk the disagreeing subset into `TIEBREAK_BATCH = 100`.
  - **The tiebreaker is ASTER, not EU-DEM.** Using our worst-measured DEM to decide precisely the
    hard cases is backwards — at five Plateau Rosa points ASTER scored 4.6 m MAE vs EU-DEM's 14.3 m.
  - `ELEVATION_SOURCE` is a **cache namespace**: bump it on any provider change or the rebuild
    silently reuses the previous DEM's values.
  **Fleet result: all 18 resorts rebuilt in 17 minutes** (was ~5 days), tiebreak rate 0.4–24%,
  ~450 capped calls total. 10 resorts unchanged; orphan nodes −11 net; badge invariant still 0
  violations over 1 904 plans. **Every "regression" it produced was a correction**, and they were all
  one mechanism: a near-flat traverse losing its uphill direction because the node moved and the
  climb crossed `maxTraverseClimb`. Verified individually — Cervinia's was an invented rescue link to
  a private hut off the piste; St. Anton's read as a **2 m** near-flat link before and **12 m** now,
  with the independent DEM saying **19 m**. Paradiski's headline longest run went 18.70 km → 11.91 km
  at the *same* 2 010 m vertical, because the old one padded the real Aiguille Rouge → Villaroger
  descent (Les Arcs advertise **2 026 m**) with 6.8 km of looping through Arc 1950 twice.
  **The remaining Plateau Rosa overrides are still load-bearing** (4 of 14, DEM still 9–25 m low over
  the glacier); this is a distribution and cost fix, not a cure for the hardest terrain.

- **A smoke test that starts from "the highest node" can report a false total failure.**
  `npm run routetest` picks the top point and routes to every bottom. St. Anton's highest node is
  **"Hochkar (top)"**, an island that reaches exactly **2 of 1087 nodes** — so the run reported
  **0/301 routable** on a completely healthy graph. It is elevation-sensitive, which is how it
  surfaced: the island sat at 2757 m against Valluga's 2759 m, and a DEM change moved it to 2790 m,
  flipping which node was "highest" with nothing in the terrain having changed. `_routetest.ts` now
  starts from the highest point **in the main body** (largest SCC, via the exported
  `mainBodyNodeIds`), giving 264/301. Any future check that picks a single representative node needs
  the same guard — a resort's extreme node is exactly the one most likely to be stranded.
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
- **When both DEMs agree AND are both wrong, no automated pass can help — only ground knowledge.**
  `elevationConsensus` fires on *disagreement*, so a systematic error shared by both sources is
  structurally invisible to it, and the residue lands in `check:audit` wearing the costume of a
  different defect. Passo Tonale's Sozzine chair base read 1315 m (our chain) and 1313 m (Terrarium)
  against a true **~1308 m**. The 7 m error put the station *above* the bottom of run 17 Pegrà
  (1309 m), so the 116 m link into it read as a climb and the valley bottom was reported as a
  **pothole sink** — an elevation fault correctly detected, but at the wrong node and with the wrong
  cause. The fix is a `setNodeElevation` override on the station (which the consensus pass then
  pins), **not** a wider tolerance in the detector. Tempting and wrong: the tolerance sweep offered a
  value that made the symptom vanish fleet-wide, which would have buried a real bad datum under a
  knob. When a user tells you a height is wrong and both sources agree with each other, believe the
  user — agreement between two DEMs is not independent evidence when both derive from similar data.
- **A "real bottom" is a lift you can reach, not only a lift you are standing on.** The pothole test
  exempts a node where a lift is boardable, but mappers routinely end a run a few metres SHORT of
  the station it serves, joined by a short flat link — so testing only the node's own out-edges
  reported ordinary lift bases as elevation faults, **82 flagged nodes fleet-wide against 37 real
  ones**. `POTHOLE_LIFT_WALK_M` (150 m) lets the test follow those links. Two traps:
  - **The walk must not climb.** `connectorKind` is direction-derived, so every bidirectional link
    is labelled `flat_traverse` however steep it is (the same mislabel that cost `cost.ts` 4.7×);
    trusting it let the walk gain up to **+14 m**. Exempting a node via a climbing walk is
    self-defeating — a pothole is *defined* as a dip you can only leave by climbing out, so that
    walk is the symptom, not a refutation. The gain is held to `POTHOLE_CLIMB_TOL`, and a climbing
    route to a lift does not end the search, since a flatter one may still exist.
  - **The distance cap has no knee** (25 m→72 flagged, 100→43, 150→37, 250→29, 400→26), so it is a
    judgement about what "at the base" means, not a discovered optimum. It is pinned to a *verified*
    case — Pegrà's real 142 m ski-out to the Sozzine base — rather than to a number that minimises
    the count. Beyond ~250 m the exemption starts reaching a different part of the mountain.
- **A human sign-off must silence every detector that can see the same node, or it silences none.**
  `acceptedDeadEnds` in `overrides/<id>.json` was honoured by `check:trapped`/`check:basins` but not by
  `check:audit`, so Portes du Soleil's three signed-off dead ends kept coming back as "DISCONNECTED
  tops" and kept `check:resort` amber forever — the exact failure mode that trains a reviewer to
  ignore the gate. `auditGraph` now takes the accepted set (`acceptedDeadEndNodes(id)`) and routes
  those nodes to a separate `disconnectedAccepted` list, printed below the counted line so the
  evidence stays visible and a sign-off can still be re-examined. Two deliberate non-features:
  the counted line's exact wording is unchanged because `_checkresort.ts` parses it with a regex that
  reports a false `ok` if it matches nothing; and this pass does **not** warn about stale accepted
  ids — a sign-off covers a whole trapped group, most of whose nodes never surface as disconnected
  tops, so only `_trapped.ts` sees enough to judge staleness. Fleet effect is exactly PdS 3 → 0; the
  other 29 disconnected tops are genuinely unsigned, which is the check that this did not over-suppress.
- **A lift's type tells you which way its runs must point — use it as a check, not a guess.** Domain
  rule from the user, and it is what caught the Avoriaz fault by eye when every automated detector
  passed:
  - **Out of a chairlift/drag TOP, routes go OUT, never in.** These lifts are up-only, so their top
    station is a *source*: a top with only incoming ski edges is a defect, not terrain.
  - A **gondola/cable-car top can be both** — those carry skiers down, so incoming edges are legitimate.
  - **At a lift BOTTOM, routes come IN**, and links between bottoms may be **bidirectional** where
    several bases sit close together at the same height.
  This is a stronger signal than it looks, because it is independent of elevation: it comes from
  `liftType`, which is published OSM tagging, while the arrow directions come from our DEM chain. When
  the two disagree, the DEM is wrong. `check:audit`'s "ski sink" category cannot substitute for it —
  a sink requires *every* skiable edge to arrive and none to leave, so a station with one ski-out and
  three ski-ins looks healthy while being 20 m mis-seated (Avoriaz `n4578135789`).
- **A run's colour is a published fact with a physical ceiling, so an impossible gradient proves a bad
  elevation — no second DEM required.** This is the **third** category of `elevationConsensus.ts`
  (`COLOUR_GRADE_CEILING`: green 0.35, blue 0.45, red 0.65, black 1.0). It exists because categories 1
  and 2 both fire on a **reversal**, and a contiguous patch that is uniformly *too low* stays perfectly
  monotonic — every arrow still points downhill — so nothing fired. Portes du Soleil's Nyon pocket was
  **76 m** wrong across 11 nodes and completely invisible: a near-flat blue traverse ("Bleue d'Arare")
  rendered as a gully with blue edges at **58–78%** gradient. Its only residue surfaced in `check:audit`
  as two unrelated "pothole sinks" — i.e. **detected at the wrong node with the wrong cause**.
  Three things make it safe, each learned the hard way:
  - **Rank by *excess drop*, never by gradient.** `excess = (grade − ceiling) × lengthM`. A 21 m edge at
    48% implies ~1 m of error (DEM noise); a 67 m edge at 75% implies ~20 m (a fault). The two
    populations separate cleanly, so `STEEP_EXCESS_M = 5` is a knee, not a guess. Ranking by gradient
    instead puts a harmless 21 m stub above a 20 m fault.
  - **The colour is only the *trigger*; the DEM still supplies the *value*.** The pass refuses unless
    adopting the second DEM (or its smoothed median) actually brings the grade under the ceiling **and**
    an endpoint disagrees by `STEEP_MIN_M`. Where it can't prove a value it **declines**. Declining is
    the feature; the residual keeps showing up in `check:audit`.
  - **It changes ski directions, so it must say so.** `applyOverrides` re-orients a piste that ends up
    climbing, which is correct but *user-visible*. `build.ts` therefore snapshots each piste edge's
    `from` before the repair and prints every edge that swapped, with run name and way id. **Any future
    pass that edits elevations owes the same report** — a silently reversed run is the worst possible
    regression, because the map still looks plausible.
- **Repair a whole elevation fault or none of it: half a repair is worse than none.** The colour-ceiling
  trigger fires where a sunken patch **meets sound ground**, so the seed is always on the patch's *rim*.
  Correcting only the seeds lifts the rim and drops a step into the untouched interior. Measured, not
  theorised: the first version of the rule repaired 5 nodes of Avoriaz's fault and left the other 17,
  which put the lift top `n4578135789` 20–34 m below the runs around it so that **every ski arrow
  pointed into it** — a defect the user spotted on the map within minutes, and one the pre-fix data did
  not have. `elevationConsensus.ts` therefore grows each seed to the connected set of nodes disagreeing
  with the second DEM by `PATCH_DISAGREE_M`, prices **every** touching edge under the fully-corrected
  field, and adopts only if all of them stay plausible. Two tests, and the second is the one that bites:
  a piste must stay under its colour ceiling, and a connector the builder emitted in **both directions**
  must stay under `PATCH_FLAT_CEILING` — a two-way connector is by construction a link the builder
  judged flat (`flatGradeMax`, 6%), so a correction that turns one into a real pitch has disproved
  itself. Fleet effect: the guard declines 22 nodes at Avoriaz, 12 at Mayrhofen and 5 at Sölden, and
  passes Paradiski's isolated 2-node fault untouched.
- **Where BOTH elevation sources are wrong, no rule can help — that is what `setNodeElevation` is for.**
  Avoriaz is the reference case and the reason the guard exists. Ground truth read off contours by the
  user: the Stade, Lac-Intrêts and Tour chair bases are all **~1737 m and level within 1–2 m**, and the
  Surf platter base is **~1745 m**. Our chain says 1731 / 1732 / **1748** / 1733; Terrarium says 1744 /
  1740 / 1746 / **1752**. So our source is 5–12 m *low* on three of them and 11 m *high* on Tour, while
  Terrarium runs 3–7 m *high* across the whole village — plausibly building tops on a built-up plateau.
  Adopting either source wholesale invents a 6–12 m spread between three bases that are physically
  level, which then forces the links between them one-way. **Do not widen a tolerance to make this
  patch pass**; it needs hand overrides from map readings. **Now done — 17 nodes pinned in
  `overrides/portes-du-soleil.json`**, after which the automatic pass has nothing left to decline
  here at all.
- **The atomic-patch rule binds a human too: pin the whole fault, or you will move the hole.** The
  Avoriaz overrides took *three* rounds, and rounds two and three were self-inflicted. Pinning the
  four lift bases left `n7012682590` (Stade Tête au Boeuf's bottom, 20 m away) at 1720 m while
  everything around it went to 1737–1745, so all four runs bottomed out there and it became a
  **22-node trapped basin that had not existed before the fix**. Pinning that left the same shelf's
  east end (`n7858239736` at 1720, `n1626744832` at 1728) as a 4-node basin. Only the third round
  reached 0. So: before writing any `setNodeElevation`, take the **whole connected patch** — the
  detector already prints its size, and here it said 22 from the start — and get a reading for
  every node in it, including the synthetic `sn…` twins. A twin sits at its parent's height; the
  user's own readings for `sn362907957` and `sn7021400781` matched their parents exactly, so pin
  them together. And re-run `check:basins` after **every** round: a partial elevation patch does not
  merely under-fix, it actively manufactures a basin, which is worse than what you started with.
- **An elevation override must re-run every direction rule, not just the ones it thought of.**
  `buildGraph` gives a near-flat piste a reverse traverse (`flatGradeMax` 6% + `maxTraverseClimb`
  8 m), but it runs on the **raw provider** elevations, and `applyOverrides` re-derives direction
  afterwards. That re-derive handled connectors in both directions (flat→slope demotion, and
  `skiable_down`→level promotion) but had **no mirror for a piste that a correction levels out** — so
  a pin fixed the printed heights and left the topology exactly as the bad DEM had built it. At the
  Avoriaz Stade/Lac-Intrêts/Tour hub that left five runs at **0.0 m drop / 0.0 % grade** one-way
  (`e1625`, `e1628`, `e1629`, `e2282`, `e4115`) while the connectors on the very same ground were
  two-way: you could ski from one lift base to the next and not back. The user spotted it by eye —
  "part of it is 2 ways and part is one way". `overrides.ts` now calls `addFlatReverse` on any piste
  branch, using **buildGraph's own constants** so this is that rule re-applied, not a second rule.
  Blast radius fleet-wide: **20 edges across 7 resorts**, all near-flat. The general lesson: any pass
  that edits a field another pass derived a decision from owes that decision a re-derivation, and the
  cheapest way to find the gap is to dump one neighbourhood and ask *why* of each one-way edge —
  `files/whyoneway.ts` prints exactly that, with the failing rule named.
- **A big lift station is a BUILDING, so the vertical between it and the piste beside it is stairs,
  not snow.** The DEM samples the ground at the station's footprint - often the boarding level, or
  the road outside - while skiers leave from the top floor. Paradiski's Vanoise Express base reads
  **1541 m** against **1550-1552 m** for the two runs that touch it, and *both* rasters agree, so
  this is not a bad datum to be overridden with `setNodeElevation`; it is the building, and pinning
  a guessed exit height would silently change the cable car's own drop as well. Charged as terrain
  it cost **10.9 m x 12 s/m = 131 s** of imaginary poling just to walk out of a major inter-sector
  cable car - easily enough to push routes off it. `GraphEdge.stationAccess` (set by the dead-end
  snap in `buildGraph.ts`) therefore tells `cost.ts` not to charge `CLIMB_SECONDS_PER_M`; the
  horizontal term still applies, pricing the walk through the terminal at flat-traverse pace.
  Three things keep it narrow, and the middle one is the whole rule:
  - **Gated on `DOWNLOADABLE_LIFT_TYPES`** - gondola, cable car, funicular - because that set is
    *exactly* the types that have a terminal building. A chairlift base or a drag top is an open-air
    ramp, so an apparent climb into one is evidence of a **mis-seated station** and must stay
    visible. Fleet-wide 13 station snaps exceed `maxTraverseClimb`; only **4** are downloadable
    (paradiski Vanoise Express 10.9 m, cervinia Gant-Hohtälli 11.0 m, cervinia Leisee-Shuttle
    13.0 m, val-thorens Pointe de la Masse 9.4 m). Of the other 9, **two are platter *tops***
    (st-anton Kindlisfeldlift 9.6 m over 15 m = 63%, Angerlift 8.3 m) - and our own lift-type rule
    says a drag top is a *source*, so a link climbing INTO one is a probable elevation fault.
    Exempting them would have hidden it.
  - **No new length constant is needed.** The whole 399-strong station-snap population maxes at
    **45 m** because `snapToLineRadius` is 45, so the station-footprint bound is already enforced by
    the snap radius. Measured: len p50 21 / p90 38 / max 45; climb p50 **0.0** / p90 4.5 / max 13.0.
  - **Grant-only, and topology is untouched.** It removes a penalty, never adds a direction. All 13
    over-climb links were *already* two-way, so there was never a gate to relax - the live defect
    was purely the cost. Fleet effect: **592 flagged edges, 264 of them climbing, 9 446 s** of
    imaginary poling removed, `probe:badges all` still **0 violations / 1904 plans**, and every
    resort's node/edge counts unchanged.
  Do **not** "fix" this class by capping the snap at `maxTraverseClimb`: that was the obvious move
  and it is backwards, deleting the four links that are physically real while leaving the nine that
  are suspect.
- **A lift base you can ski away from but never ski *to* is invisible to every existing guard.**
  `buildGraph` has a lift-**top** ski-out pass; there was no mirror for the base. Nothing else finds
  it: the rescue pass fixes nodes that cannot leave, the orphan pass fixes components with no
  entrance, and a lift base always has an exit (the cable) and belongs to the main component — so
  `check:basins` reports 0 while the router can never once put that lift in a route. `liftSkiIn.ts`
  projects such a base onto the nearest piste line within `liftSkiOutRadius`, splitting it, exactly
  as the ski-out twin does; the projected point must be at or above the base, and the link is
  one-way down past `maxTraverseClimb`, so it cannot become a free ascent. **It lives in `build.ts`,
  not in `buildResortGraph`, and that placement is the whole point:** "has a ski-in" is a question
  about edge *direction*, and direction is re-derived twice afterwards (by `applyOverrides` and by
  the elevation consensus). Avoriaz's Surf platter proves it — inside `buildResortGraph` the base
  looked fine because the raw DEM read the shelf below it too high and the runs pointed inward; the
  hand pins then flipped all three outward. Fleet-wide the pass fires on **~30 bases across 15
  resorts**, mostly 10–60 m. Watch the long ones (117–126 m at Zermatt, Verbier, Val Thorens): they
  are legal but worth an eyeball, and they are the reason not to widen the radius.
- **A detector must never accept the app's own plumbing as evidence about the mountain.** The pothole
  detector (`_phantoms.ts`) looks for a node every descent arrives at whose only way onward climbs,
  and it decided "the descent resumes over there" using *any* descending edge. Polygon **skeleton
  arms** are links the app invents for connectivity, so this let it manufacture its own proof that
  real terrain was broken. At Les Gets the Indiens/Trappeurs junction `n13535054703` was reported
  with a 7 m climb-out purely because the arm pair `e3141`/`e3142` hangs off it: the walk climbed
  `e3142` (+7 m), found `e3141` "descending" at the top — and `e3141` descends **straight back into
  the node under test**. Meanwhile the honest route (110 m down to the Grand Cry station, where
  Piste des Indiens really does continue 1513 → 1495 m) was never reached. Two guards: arms are out
  of both the flat-escape walk and the resume test, and a resume whose descent returns to the origin
  is not an escape. Fleet effect: **35 → 19 sinks, so 16 of 35 were phantom**. `spineDuplicate` is
  deliberately *not* excluded — that flag marks a real piste paralleling a spine, which is terrain a
  skier can actually ski. This is the mirror of the paradiski Kamikaze bug (an arm that *climbs*
  counted as a way out, hiding a real sink); when a detector walks the graph, ask of every edge class
  whether the app invented it. **A user's "the slope here is obviously fine" is the fastest way to
  find one of these** — that is exactly how this surfaced.
- **A search for "how bad is it" must take the BEST option, not the first one it stumbles on.** The
  same pothole walk was a BFS that `break`ed at the first node offering a descent and reported *that*
  node's height as the climb-out — so the verdict was decided by **edge storage order**. Paradiski's
  `n1000000002298` (1699 m, the foot of Route des Espagnols) has two flat outs: `e1892` → `n257077953`
  @1702 m is stored first, giving +3.0 m, which is *precisely* `POTHOLE_CLIMB_TOL`. One slot behind it
  in the same queue sat `e7724`, a **2 m** link to `sn1000000002298` @1700 m (+1.0 m), from which
  La Forêt continues down 35 m and then 179 m for −16 m. The node was visibly connected downhill on
  the map and was reported anyway. A pothole is *defined* as a dip you can only leave by climbing, so
  the honest measure is the **least** climb reachable; stopping early can only over-report. The walk
  now keeps expanding past a node that offers a descent, because a lower resume may lie beyond it.
  Fleet effect: **19 → 8 sinks**, clearing Val Thorens and Madonna's Panciana base entirely. Rule of
  thumb: any `break` inside a "measure the severity" search is suspect — `break` is for *existence*
  questions, `min`/`max` for magnitude ones.
- **A detector's threshold must not sit below the pipeline's own noise floor.** `POTHOLE_CLIMB_TOL`
  was a hard-coded `3`, while `Vmerge` is **4** — the vertical distance within which `buildGraph`
  declares two points to be *the same place* and merges them into one node. So the audit was
  accusing nodes of a height difference the builder one step earlier would have erased. Madonna's
  `n6200757170` on Skiweg Campiglio (1631 m) was reported for a **3 m rise over 33 m** of two-way
  flat cat-track onto the 5 Laghi blue — original data from the very first resort ever built, routed
  across in both directions for the app's whole life. Generalise it: before trusting any threshold in
  a checker, find the constant the *builder* uses for the same physical quantity and make the checker
  derive from it.
  **That rule then caught its own first application.** The fix reached for `Vmerge` — which is the
  right *form* (a builder constant) but the wrong *quantity*: `Vmerge` answers "are these two points
  the same place?", a statement about measurement noise, while the pothole test is asking "can a
  skier get back up out of here?", a statement about the skier. At `Vmerge` exactly **six** nodes
  survived fleet-wide, and every single one escaped along a reverse traverse the builder had itself
  created — total ascent 5.0/8.0/6.7/7.0/5.0/7.0 m at net grades 3.1/5.6/5.9/4.7/3.1/1.6%, all
  inside both `maxTraverseClimb` (8 m) and `flatGradeMax` (6%). `buildGraph.ts` emits such a traverse
  only when `gradeOk && Math.abs(drop) <= maxTraverseClimb`, and calls that constant *"more than a
  skate — that's a real slope"*: it is literally the pipeline's own answer to the question the
  detector was asking. Constant is now `= DEFAULT_GRAPH_CONSTANTS.maxTraverseClimb`. Fleet: **8 → 6
  → 0**. Verified non-vacuous by *injecting* a 15 m sink into a scratch resort and confirming it is
  still reported (climb-out 20 m) — a checker that reaches zero must be proven to still fire, or you
  have only proved it stopped looking.
- **Two checks that answer the same question must agree about off-piste.** `trappedBasins.ts` has
  excluded off-piste from "stranded piste" since the off-piste work, but `check:trapped`'s flat
  trapped/orphan lists never did — so `check:basins` called Verbier clean while `check:trapped`
  reported **18 trapped nodes**, and that disagreement parked L'Eteygeon on the review list for
  rounds. Every one of those 18 (plus both orphans) lies on L'Eteygeon / Itinéraire Bruson, and
  **every non-off-piste edge in the sector is `synthetic:true`** — rescue/snap connectors the app
  invented trying to save the itinerary. There is no real piste there to be cut off. A freeride line
  that descends to a valley and stops is not a defect, and `cost.ts` refuses those edges outright
  unless `allowOffPiste` is on, so by default a skier cannot even enter the terrain to get stuck in
  it. Fleet-wide this was **48 of 138 trapped and 23 of 57 orphan nodes across 7 resorts** — a third
  of the check's noise (Verbier 18→0, Tignes 11→1, St. Anton 26→15). Three deliberate constraints:
  judge **ignoring the app's own `synthetic` plumbing**, or the sector reads "mixed" on the strength
  of the app's guesses about terrain it cannot see; **report separately, never silently drop**, same
  contract as `acceptedBasins`; and **do not filter the BFS** — `check:trapped` still walks off-piste
  when deciding what can reach a lift, so a *piste* node whose only escape is a freeride line still
  counts as reaching one. That last one is arguably too generous, but it is what `trappedBasins.ts`
  does, and changing reachability semantics is a far bigger behavioural change than suppressing a
  report; measure it on its own rather than smuggling it in.
- **An overlay guard must key on "did we EXAMINE anything", not "did we FIND anything".**
  `writePotholeOverlay` refused to write when the merged result was empty, copying `_areaskel.ts` /
  `_basins.ts`. But it already deletes each examined resort from the merged file, so the truncation
  those guards exist to prevent was handled; all the empty check still did was make a *true* zero
  unwritable. The overlay then pinned to its last non-empty state, so all six already-cleared nodes
  kept their markers and got clicked and re-reviewed one at a time — the exact wear the fix was
  meant to end. A run that loaded 18 graphs and found nothing has produced a **result**; a broken run
  examines **nothing**. Guard on `ids.length`, and let a clean mountain write `{}`.
- **"The node is wrong" and "the marker on the node is wrong" are different claims — say which.**
  Every pothole the user opened turned out to be untouched original data that had always routed
  correctly; what was wrong was the *verdict* printed about it. Phrasing it as "these have been
  wrong since the detector was written" read as an accusation against their data and cost trust.
  When a checker and a user disagree, state plainly which of the two you think is broken.
- **`piste:name` beats `name`, exactly as `piste:ref` already beat `ref`.** `normalize.ts` had
  `name: tags.name || tags['piste:name']`, one line above the correct `ref: tags['piste:ref'] ||
  tags.ref`. Runs are routinely mapped on top of a road or forest track that carries the *road's*
  name, so we labelled pistes with road names: the Avoriaz → Les Lindarets blue showed as **"D 228
  Route des Lindarets"** when its `piste:name` is **"Parchets"**, which is why it read as a service
  road rather than a run. Fleet-wide **143 of the 256** downhill ways carrying both tags disagree
  (Zermatt "Moosstrasse" vs "Moos", "Riedweg" vs "Ried"; Alpe d'Huez "Lac Blanc" vs "Retour 1800").
  Takes effect only after `npm run data:refresh`.
- **A `piste:name` that merely repeats `piste:ref` is not harmless noise - it SPLITS the run's
  closure key.** The key is `piste:<ref>~<name>` when both tags exist and `piste:<ref>` when only
  the ref does, so a run whose ways are inconsistently tagged becomes **two** keys and closing one
  leaves the other half open. Ischgl and Sölden put `piste:ref=2` *and* `piste:name=2` on most of
  their runs - **1423 edges fleet-wide** - which is how a user reading the Closed picker found "2"
  and "2 · 2" listed as separate runs. `dropSelfRefName` in `normalize.ts` clears the name when it
  equals the ref (trimmed, case-insensitive). Three things about it:
  - **It needs no ambiguity guard, and its stronger sibling does.** Dropping a self-repeating name
    can only ever merge a key with the bare-ref key denoting *the same number*. Adopting a
    **different** sibling's name cannot claim that - see the Rule B caveat below.
  - **Verified as label-only**: rebuilding both resorts left the node id set and the whole edge
    signature (`from>to|kind|length`) **byte-identical**, with **zero** names dropped that were not
    a repeat of the ref. Keys fell 108 → 87 at Ischgl and 78 → 61 at Sölden.
  - **The tag is already cached**, so `npm run data <id>` applies it; no `--refresh` needed.
- **A piste ref does NOT identify a run - 115 of 852 refs name several.** The tempting fix for the
  split above is to key on the ref alone, since the number on the signpost looks like the run's
  identity. Measured, it is not: Sella Ronda's ref **6** covers **eight** unrelated runs (Pian
  Frataces, Ciampinoi 6, Ornella, Canazei, Ciampac, Cigolade, …) in different valleys, and Cervinia
  has 31 such refs. Keying on the ref would let one click close eight runs on other mountains.
  The safe residue is a **per-resort** rule (*"Rule B"*, not implemented): where a ref carries
  exactly **one** distinct real name, its bare-ref ways may adopt that name. Worth only 14 more keys
  (Mayrhofen 7, Sella Ronda 5, Monterosa 1, Val Thorens 1) and it has a genuine failure mode - a
  resort reusing a ref for a second run that is *entirely* unnamed would be silently labelled as the
  first - so it needs a **connectivity guard** (adopt only onto ways connected to the named part),
  which is the same "repair the whole feature or none of it" discipline as the elevation patches.
  Note the resorts worst hit by the split (Ischgl, Sölden) have **zero** ambiguous refs, so Rule A
  carries almost all the value.
- **Lift names that differ by a trailing number are usually NOT duplicates.** A crude prefix/suffix
  test reports 79 pairs fleet-wide and essentially all are real: `Poutran 1`/`Poutran 2` and
  `Pic Blanc 1/2/3` are separate stages of one gondola, and `Rif Nel 1`/`Tapis Rif Nel 1` is a
  carpet beside the chair it serves. Do not "de-duplicate" lift names.
- **A road can be a real piste, and OSM says so explicitly.** Before treating a run that follows a
  road as an import artefact, read its tags: the Route des Lindarets ways carry `piste:type=downhill`
  + `piste:difficulty=easy` + a `piste:name`, and `w327863773` adds
  `access:conditional = no @ (Oct-Apr)` — cars banned for the whole season. That is a mapper
  deliberately declaring a winter blue, not a road that leaked in.
- **A per-resort tool that writes a fleet-wide overlay must MERGE, not replace.** `check:audit <id>`
  examines one resort; writing its result whole dropped the other seventeen and took them off the
  debug map. Refusing to write an *empty* file (the `_areaskel.ts`/`_basins.ts` guard) does not catch
  this, because the file was not empty — just narrower. Delete the keys this run covered, then merge,
  so a fixed resort is still removed and stale marks cannot accumulate. `applyOverrides` builds a Map,
  so the **last** entry for a node beats every earlier one. A rationale-free `{"node":"n10722198686",
  "ele":1765}` sitting lower in `portes-du-soleil.json` quietly ate a freshly-written 1760 reading,
  and the build looked like it had ignored the fix. `check:overrides` now reports duplicates
  (conflicting values = stale, exact repeats = clutter); fleet-wide there were no others. Grep the
  array for the node id before adding an entry, and give every entry a `_why` — the entry without
  provenance was, predictably, the wrong one.
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
- **A detector that reads the field as it *arrived* is testing a state that will not exist.** The
  ski-sink test used the stored edge orientation and the raw elevations, but it runs in the same pass
  that is about to *move* nodes — and moving one end of a run re-orients it. Paradiski's
  `n1000000001983` is the worked example, found by a user's eye after every detector passed: while
  its neighbour `n669482305` still read 15 m low the node had two out-edges and was plainly no sink;
  the instant that neighbour was repaired it became one. So the sink test now reads the field through
  `cur()` (raw, plus everything already adopted), **implies** each piste's direction from those
  elevations rather than trusting `from`/`to`, and **iterates** (bounded at 4 rounds) because each
  repair can expose the next one downstream.
- **A link that climbs is not a way out — which is also how a skeleton arm hides a sink.** The same
  node was additionally masked by polygon plumbing: arm `e4897` leaves it *climbing 8 m over 39 m*,
  and any out-edge disqualified the node. Filtering on `skeletonArm` does **not** work here, because
  the flag is stamped by a later pass and the edge reaches the consensus pass unmarked. Test the
  physics instead: an edge rising more than `SINK_OUT_CLIMB` is not counted, since you cannot ski up
  it (`cost.ts` charges 12 s/m to push). That covers arms, mis-oriented connectors and anything else
  without depending on a flag's timing. Effect: the node was repaired 1998 → 2014 m, which
  simultaneously turned Kamikaze `e1927` downhill *out* of the junction and made `e4896`/`e4897`
  one-way toward `n2328038825` — three separate wrong arrows, one root cause.
- **One neighbour over the line does not make a disagreement systematic.** The isolation test used to
  demand that *every* neighbour agree with the second DEM within `SINK_NBR_AGREE`, so a single
  neighbour at 6 m vetoed a node reading 16 m low with a median neighbour at 1 m. That is not a
  systematic dataset offset, it is one noisy point next to a real fault. A node may now also pass by
  being a clear **outlier**: the median neighbour must still agree, and the node's own disagreement
  must be at least `SINK_OUTLIER_RATIO` (2×) the worst neighbour's. Do **not** fix this class of miss
  by raising `SINK_NBR_AGREE` — that weakens the test everywhere to rescue one node.
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
- **Nor is every `railway=funicular` a lift — `service=*` means a works track.** OSM's
  `service=yard|siding|spur|crossover` marks a non-revenue track that exists to move equipment, so it
  can never be a ski lift. Above Perrères in Cervinia the 600 mm dam-construction incline
  *Piano Inclinato* (`w167161897`) and two unnamed siblings are tagged `railway=funicular`, so the
  `disused`/`abandoned` ways drawn beside them — which we already skip — did **not** catch them; they
  arrived as three unnamed 0.9–1.6 km "lifts" in lift purple with direction arrows, touching no piste
  at all. Fleet census: `service=*` matches **exactly those 3 of 64** rail-lift ways, leaving every
  named passenger funicular (Funival, Sunnegga, Les Arcs' Express, Gardena Ronda Express, Rasciesa)
  untouched. Deliberately **not** keyed on `usage=industrial` (real funiculars carry `usage=tourism`,
  and it would take an unreviewed Verbier way) nor on `gauge=600` (coincidental — the genuine ones
  here run 1200–2000 mm). Note the filter runs on the **cached** raw ways, so a plain
  `npm run data <id>` applies it; no `--refresh` needed.
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
- **A dead glyph host fails with a 200, not a 404.** `fonts.openmaptiles.org` now answers every
  `{fontstack}/{range}.pbf` with an **HTML landing page under HTTP 200**, so MapLibre parsed HTML as
  protobuf and logged `Unable to load glyph range … Error: Unimplemented type: 4` once per codepoint,
  then silently drew every map label with its local fallback instead of the real font. The style now
  points at `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`, which serves the same Noto
  stacks as real `application/x-protobuf` including the Hebrew range (1280-1535) the RTL locale needs.
  When a tile/font URL "works" but the renderer complains, **check `content_type`, not just the
  status code**.
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
- **A route must answer the question that was asked, on the card the user is looking at.**
  `arrive_by` was fully implemented in the router — `plan.ts` back-solves `start = target −
  duration` — and looked broken because the answer never reached the eye: the floating preview card
  showed no clock at all, and the details card printed "Depart · Arrive" in identical grey in both
  modes, so the one number the user asked for sat next to an arrival time they had typed in
  themselves. The mode is recorded as `RouteStats.timingMode` **on the route**, not read from the
  app's toggle, so flipping the toggle after planning cannot relabel a route that already exists.
  Under `arrive_by` the departure is promoted (an `Alert`, and "Leave 15:10" on the preview);
  otherwise the preview shows the ETA. Before concluding a feature "does nothing", check whether it
  is the computation or the presentation that is missing — here it was entirely the latter.
- **Naming each lift with unknown opening hours is only useful as a contrast.** Only **63 of 2163**
  lifts fleet-wide (2.9%) carry `opening_hours`, so "hours unknown for X" was usually emitted once
  per lift on the route, saying the same thing 4 times — and since the card renders at most **four**
  warnings, those copies pushed out the ones that matter (a lift closing soon, a synthetic bridge).
  `buildRoute` collapses them to a single `warn.hoursAll` when **no** lift on the route has hours.
  Two deliberate limits: it needs **more than one** lift (with a single unknown lift the name is
  strictly more informative), and it never fires when *any* lift's hours are known — that is the
  case where naming the others is the whole point. Verified across 376 routes on three resorts: 0
  violations, and Sölden's single-lift routes correctly keep the name.
- **A long step list is usually an OSM naming artifact, not too many traverses.** Val Thorens
  averaged 24.9 steps per 13 km route, of which only **4.9** were traverses — `groupSteps` in
  `buildRoute.ts` already absorbs connectors under `SHORT_CONNECTOR_M` (40 m) and merges consecutive
  ones. The real cause was that OSM names a run way by way, so one descent arrived as
  `<unnamed> | 60 Menuires | <unnamed>` — three steps of ~60 m. `sameRunMissingName()` merges a
  piste step into its neighbour when exactly one side is unnamed **and the colour matches** (colour
  is the safety-bearing half of the label; an unnamed edge of a different colour is a different run),
  adopting whichever name exists. `bridgesSameRun()` additionally absorbs a traverse that leaves a
  run and rejoins **the same** run. Effect: 24.1 → 18.5 mean steps, same-run sandwiches 51 → 0,
  Sölden unchanged at 10.6 because it is fully named in OSM — same code, no data gap. Two things
  this must never do: **merge across different runs** (a traverse between two runs is often the only
  link and hiding it hides a required move), and drop the `fromLeg`/`toLeg` span, which is what lets
  a merged step still highlight all its edges on the map.
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
- **Two callers need that gate, and the resort-wide card is the one that gets forgotten.** `plan.ts`
  builds `allowForLongest` for the A→B search, but `findLongestRuns` — the resort-wide "Longest
  runs" card — builds its **own** predicate, and it silently omitted closures. `buildEffectiveGraph`
  folds in custom nodes/edges but **not** the closed set (closures are resolved per-plan from
  `closedKeys`), so the card was the single place in the app that would advertise, as the resort's
  longest run, a piste the user had just marked closed. It now takes `closedKeys` and resolves them
  the same way, and toggling a closure clears any computed runs — a stale answer to a changed
  question, exactly as the "allow poling" checkbox already did.
- **`allowPoling` is a *scoring* rule, not a *feasibility* rule — do not thread it into `edgeCost`.**
  It decides whether a shallow named piste still **counts as skiing** when maximising a descent; it
  never makes an edge usable that wasn't. Verified fleet-wide (`files/longestnav.mts`): replaying
  every resort's #1 longest run through `routeForEdges`→`buildRoute` yields **no zero-cost legs**
  under poling on *or* off, i.e. `edgeCost` already accepts every poling edge and simply charges
  flat pace or `CLIMB_SECONDS_PER_M`. So the "Longest, then navigate it" consistency worry is
  answered by **replaying the chain**, which `navigateToLongestEnd` does (`routeForEdges` over the
  run's own edges), not by teaching the cost model a new preference. Poling changes the answer in
  only 3 of 18 resorts: madonna 8.94↔7.40 km, paradiski 18.48↔13.52, ischgl 10.60↔8.64.
- **Longest** = max-km **lift-free** descent A→B, exact via a DAG longest-path (`longestStreak.ts`);
  only falls back to a lift if B is otherwise unreachable. The resort-wide "Longest runs" card is the
  only feature that ignores A and B.
- **A named run may roll over a rise and keep descending, and refusing that cost Paradiski 5 km.**
  `usableFrom` picks a node's onward edges: level/descending options win outright, and an "escape
  climb" (≤ `maxTraverseClimb`, 8 m) is only considered when *nothing* is level. That is right for a
  dead end and wrong for a run that crosses a saddle. Paradiski's **Villaroger** climbs **8 m over
  271 m** at Pré-Saint-Esprit with **2242 m / 120 m of descent immediately beyond**; the node also
  offers a 97 m drop into the lift base, so the level branch always fired and the run simply *ended
  at the rise*. That one refusal **is** the whole 18.70 → 13.52 km fall. Three things to know before
  touching it:
  - **The old 18.70 km was partly an artifact.** The pre-Skadi graph had `n11595373789` at 1794.5 m;
    the current pipeline and both DEMs put it at **1829 m** (DEM 1823). The old data turned an 8 m
    climb into a 21 m descent. The number did not regress — the elevations got *right*, and the
    honest way to recover the line is the user's explicit poling opt-in, not a looser rule.
  - **Test `pisteName` + `!synthetic`, never `kind === 'piste'`.** The edge that carries the rise is
    `e2314`, a `connector`/`flat_traverse` — because `buildGraph` assigns `connectorKind` by
    direction alone — yet it carries `pisteName: 'Villaroger'`. Its reverse `e2313` is the piste
    proper. A `kind` test misses exactly the edge that matters.
  - **`dropM` is negative for descent in the graph and in code, but `probe:hood` prints it flipped.**
    This has bitten repeatedly.
- **Poling is not additive on its own, so the longest search runs BOTH adjacencies and pools them.**
  Admitting escape climbs adds edges, which changes what DFS meets first and silently re-orients
  two-way flats *elsewhere on the mountain* — measured, Verbier lost 1.01 km for reasons having
  nothing to do with poling. `longestDownhillPaths` therefore builds `adj` twice (plain and poling)
  and searches both, offering every result into one pool. The plain pass reproduces the no-poling
  answer exactly, which is what makes the feature **provably non-regressive**: fleet-wide no resort
  fell below baseline, six improved on options 2–3, and Paradiski went 13.52 → **18.48 km / 2023 m**
  — more vertical than the old, wrong 18.70 km. Cost is one extra pass (~2 s/resort, browser-side).
- **The longest-descent DAG orients two-way flats by DFS arrival order. It is arbitrary, but every
  attempt to replace it lost distance** — and it was *not* the Paradiski cause (see above), which is
  what these two experiments were chasing. Near-level traverses are passable both ways, so the lift-free sub-graph is a knot of
  2-cycles and `buildDag` must drop one direction of each; today that direction is decided by
  whichever end DFS reaches first. It is genuinely arbitrary, and it *is* why a given chain can stop
  being expressible as a path after an elevation refresh reshuffles the roots. But replacing it costs
  distance. Both principled replacements were built and measured fleet-wide: orienting each flat by
  **skiing distance from the start** (drop the half leading back toward it) lost Verbier 0.86 km and
  Mayrhofen 0.20 km — a real descent does sometimes swing back toward a point reachable more cheaply
  another way, and cutting that half cuts the run; the **non-destructive** version, keeping every
  edge and only exploring nearer nodes first so DFS meets a flat from its near end, lost Ischgl
  0.83 km instead. Neither recovered the Paradiski line. Straight-line
  distance is worse still — a run curls back toward the summit while genuinely descending
  (Paradiski's Vallée de l'Arc swings north into Arc 1950), so an airline rule points exactly those
  flats backwards. **Do not re-attempt without a fleet `probe:longsum` diff.** What *did* survive
  from the work is `buildDag`'s optional `prefer` map (explore a chosen edge first, so a known
  chain's flats become tree edges and cannot be dropped), used by a strictly-additive refinement
  loop: solve, re-orient the flats the answer used in the direction it used them, re-solve, keep
  the best. Measured worth: a small gain on **9 of 18** resorts (best +0.30 km), never a loss, and
  it converges in **one** round — `REFINE_ROUNDS = 2` was live, reached, and changed nothing
  fleet-wide while costing ~20% of runtime.
- **"Allow a bit of poling" (`Preferences.allowPoling`, default on) is taste, not terrain.** Some
  skiers happily push along a flat to earn a longer descent; others count only what they skied. It
  does two things: waives the flat penalty in `makeDescentScorer` — full ski credit regardless of
  grade — and admits the escape climbs above in `usableFrom`. Both are gated on the edge being a
  **named run** (`isNamedRun`: has `pisteName`, not synthetic/arm/spine duplicate), which is what
  keeps the junction-mesh padding cheat closed: an *unnamed* level line is exactly the scrap this
  must never reward. **The two halves are not equally load-bearing, and the scorer half is not what
  fixed Paradiski** — disabling it fleet-wide moves exactly one number (St. Anton #2, 6.23 → 6.18)
  and leaves Paradiski at 18.48 km. It is kept for coherence, not for distance: with it off, a flat
  the skier explicitly opted into poling across still scores as negative padding, so the search
  would penalise the terrain the checkbox just allowed. The `usableFrom` half is worth the 5 km.
- **"No poling" has to mean no climbing anywhere in the run, including out of dead ends.**
  `usableFrom` has *two* climb doors, and only one was ever gated. The **dead-end escape** — no level
  option at this node, so take anything up to `maxTraverseClimb` — predates the preference and had
  no gate and no name/synthetic test, so an unticked skier was still served runs that climb, over
  links the app invented itself. Madonna's 8.94 km top pick pushes **60 m up a +8 m synthetic,
  unnamed connector** (`e978`, Pozza vecia → Skiweg Fortini) and Ischgl's 10.60 km does the same, so
  the app was refusing the real signposted Villaroger rise while serving its own uphill plumbing.
  The escape is now gated on `allowPoling` as well. Measured fleet-wide it costs the **ticked**
  (default) skier nothing — the only movement is Sella Ronda *gaining* 0.02 km — and costs the
  unticked skier exactly the runs that require pushing (madonna 8.94 → 7.40 with internal climb
  8.1 m → **0.0 m**, ischgl 10.60 → 8.64). The alternative of demanding named + non-synthetic here
  instead, with no poling gate, was measured and is wrong: it deletes Madonna's 8.94 km run for
  *everyone*, because the single link it turns on is synthetic. Out of a genuine dead end,
  connectivity outranks provenance — the thing that was missing was **consent**, not pedigree.
  Note `usableFrom` is reached only by the longest-run family, never by the A→B planner.
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
- **Preferred colours are a CONTIGUOUS band, and raising max ability drops what is above it.** Two
  UI invariants in `PreferencesPanel.tsx`, both from the user and both easy to "helpfully" undo:
  preferring green **and** black while skipping blue and red is not a coherent taste, it is a
  mis-click - a skier who likes greens and blacks likes everything between - so the selection is
  forced to a run with no gaps; and setting max difficulty to red must **auto-drop black** from
  preferred, because a preference for terrain the same panel has just declared off-limits is a
  contradiction the router then has to resolve silently. Max ability is the **ceiling** and preferred
  colours are a taste *within* it, never beside it.
- **The resort picker has no search box, on purpose.** It was removed at the user's request: on a
  phone, focusing a search field throws up the keyboard and covers the very list you are choosing
  from, and grouping by country is already enough to find 18 resorts. Do not add it back as an
  ergonomics "improvement" - it is one, on a desktop, for a list this short it is a net loss on the
  device the app is actually used on. Revisit only if the fleet grows past what a grouped list can
  carry.
- **The panel's two primary sections are pinned open; only the secondary four collapse.** The route
  form and its results are the panel's whole job, so they are `pinned` (header, no chevron, never
  collapses) and Longest runs / Custom links / Closed today / Preferences stay a normal exclusive
  accordion set below them. Before this, all six were peers in one exclusive set, so **finding a
  route closed the form that found it** — `setOpenSection('routes')` after a search was not a bug
  in itself, it was exclusivity applied to two things that must be visible together. Note the
  secondary four keep their collapsed one-line summaries ("All open", "None yet"): those carry
  state, so replacing that strip with bare icons would cost information to save ~150 px.
- **A card with too much in it gets TABS, and the tab value must be state that already exists.**
  Two cards outgrew a single scroll. Preferences became **Me / Route / Lifts**, and the Plan card
  became **Plan / Options** — the latter *replacing* the separate pinned "Route options" section
  above, so the two are now one card. Five rules came out of doing it:
  - **Reuse the existing selector; never add a parallel one.** The Plan strip's value **is**
    `openSection`, clamped to `plan|routes`. All seven `setOpenSection('routes')` call sites (after
    a search, after picking an option, reroute, the preview's Details, the options FAB) already
    meant "show me the results", so the strip inherited every one of them and cannot drift out of
    step. A second `useState` would have had to be threaded to all seven by hand. `mobileTab` still
    folds `routes` into `plan`, so the bottom nav is untouched.
  - **Clamp when the second tab cannot exist.** Options only render when
    `plan && (noLiftFreeRoute || routes.length)`. Without the clamp, clearing a route or changing
    resort while `openSection === 'routes'` leaves a blank card. The **strip stays put** and the
    empty tab is `disabled`, not hidden: a strip that appears when results arrive shoves the card
    down 40 px at exactly the moment the user is reading it, which is the same "nothing may jump"
    rule that gives the mobile sheet a single fixed height, and a greyed tab tells the user where
    the results are going to land. (Hiding a *lone* tab would still be right — this card always has
    two.)
  - **A tab strip owns the card's iconography, so the header gives its icon up.** Each tab carries
    the glyph of the mobile FAB that opens it — `SearchIcon` for Plan, `AltRouteIcon` for Options —
    so the button you tapped and the tab it lands on are visibly the same thing. That puts
    `SearchIcon` ~40 px below the header's copy of it, which reads as a mistake, so the Plan card's
    `AccordionSection` takes no `icon`. It is the only card with tabs, hence the only header that is
    a title over a labelled strip; the mobile sheet's title bar still shows the icon via
    `sectionHeader`, far from the strip. Use `iconPosition="start"` — `"top"` doubles the strip's
    height for no gain.
  - **A tab label carries its own state**, same convention as the collapsed accordion summaries:
    "Options (3)" shows the count, and each Preferences tab shows a dot when it holds a non-default
    value (`isTouched`). A dot, not a count — those settings are
    heterogeneous and have no natural number. Tabs hide state; the strip has to give it back.
  - **If a tab is hard to name, the GROUPING is wrong — do not go looking for a better word.**
    The third Preferences tab was "Terrain" and held the lift-type grid plus two strays, `allow
    off-piste` and `avoid app-added bridges`. No name worked, because two of its three settings are
    not terrain. Both strays are constraints on which **edges the router may use**, exactly like
    `prefer skiing`, so they moved to **Route** and the tab became simply **Lifts** — the most
    findable word on the card ("can I turn off drag lifts?"), and now literally true. `isTouched`
    moved with them. Two follow-ons: the lift grid's disclosure was deleted, since the chips *are*
    the tab and a collapse would leave it empty but for a count; and the Hebrew is **רכבלים**, the
    term already used fleet-wide for ski lifts — **מעליות** is elevators in a building, which is
    what a dictionary lookup hands you.
  - **Nothing may live outside a tab panel.** `MeasuredSpeedsPanel` was rendered by `App.tsx` as a
    *sibling* of `PreferencesPanel`, so after tabbing it sat below the strip and appeared under all
    three tabs. It is now passed in as `speedsSlot` and rendered inside **Me**, beside the skiing
    speed it calibrates — App still owns the sample store, the panel only decides placement.
  This does knowingly soften the bullet above: on desktop the form and its results were previously
  both visible at once. The old defect was **exclusivity across six peers** — a route search made
  the form vanish into an accordion set with no hint where it went. A two-tab strip is a different
  thing: the form is one labelled, permanently visible click away.
- **A disclosure toggle is not a link, and `underline="hover"` on one gets stuck.** Preferences'
  `Collapse` triggers were `Link component="button" underline="hover"`. Measured in
  the live page rather than guessed: the class list is identical before and after a click, there is
  no `focusVisible` class, and computed `text-decoration-line` is `none` — so MUI holds no state and
  the only rule that underlines is `:hover`. On desktop that means the cursor parked on the control
  after clicking; on touch it is **sticky `:hover`**, which persists until you tap elsewhere and
  reads as "this is a visited link". Affordance on a disclosure belongs in a chevron, which cannot
  get stuck, not in a decoration that depends on pointer state.
- **A setting whose default is nearly always right is collapsed, and its SUMMARY carries the state.**
  The Plan form's "When" was a label line plus a two-button toggle row - three lines of vertical
  budget for a control that reads "Now" on virtually every plan, sitting between From/To and the
  Find button that the user actually came for. It is now the same `Button` + chevron disclosure used
  in Preferences, labelled `"When: now"` / `"When: arrive by 09:15"`. Two rules: the label is a
  **single catalogue string with a param** (`app.plan.whenArriveBy`), never a concatenation, because
  Hebrew puts the time somewhere else in the sentence; and the time goes through `fmtClock`, whose
  bidi isolate stops `09:15` reordering against the surrounding Hebrew. `arrive_by` deliberately does
  **not** force it open - the summary already states the chosen time, and force-expanding would make
  the control uncollapsible in exactly the state where it is longest.
- **"Share my location" is a map FAB, not a form field.** It sat as a full-width outlined button at
  the foot of the Plan form, which made it read as a third action of that form (beside Find and
  Clear) when it has nothing to do with planning: it is a safety utility you reach for when you are
  *not* filling the form in, typically because someone is lost. It is now a `Fab size="small"`
  directly under Locate in the map stack - the two answer the same question ("where am I") - and,
  critically, that stack is the one place a **mobile** user can reach without opening a card, since
  the Plan and Options FABs are `!isMobile`. Its `Menu` moved with it and anchors bottom-right of
  the FAB. The stack's `position/top/right` stay an **inline style**, not `sx`, so the RTL emotion
  plugin cannot flip it away from the map's edge.
- **A card can be a HOME for a topic rather than one feature, and the coming-soon tab is what makes
  that honest.** "Longest runs" was a card for a single button. It is now **This resort**, with
  **Longest / Iconic routes / Stats** - the same tab mechanism as above, but the tab value is local
  `useState`, *not* `openSection`, because unlike the Plan strip nothing in the app navigates to a
  specific one of these. Three things came out of it:
  - **A tab may ship empty if the empty state is a promise.** Iconic routes renders a coming-soon
    note. That is not filler: it tells the user the resort's signposted circuits are a planned
    feature and stops the question being asked, and it reserves the slot so adding the feature is
    not another card. Do this only where the feature is genuinely designed (see the backlog section).
  - **Debug-ish numbers belong in a tab, not loose under the panel.** The node/edge counts were a
    desktop-only line under all the cards, invisible on mobile. They are now the **Stats** tab, which
    also made them reachable on a phone for the first time. `src/utils/resortStats.ts` derives them
    from the loaded graph, and it counts **lifts, not lift edges** - a lift is split at every shared
    node, so an edge count reports a number several times the one on the resort's own website.
  - **Stats are derived, so they say where they came from.** The tab carries a caption naming
    OpenStreetMap and the compile date, because a raw "212 runs" invites comparison with a published
    figure that counts differently.
  - **A vertical drop is a SKIING statistic, so it is measured over skiable ground - not over every
    node.** Scanning all nodes lets a valley station you can neither ski to nor ski from set the low
    point, and the offenders are exactly the lifts that are not ski lifts: Madonna read **790 m** at
    the Pinzolo gondola base and Verbier **483 m** at Riddes-Iserables, which AGENTS already records
    as public transport. `resortStats` therefore ranges over nodes touching a real mapped run -
    off-piste **counts** (terrain a skier descends, just unpatrolled), areas and the app's own
    synthetic plumbing do not. Fleet effect on the low end: verbier 483 -> 844, val-thorens
    626 -> 1117, alpe-dhuez 724 -> 1132, paradiski 808 -> 1198, les-deux-alpes 964 -> 1286,
    sella-ronda 1015 -> 1218, madonna 790 -> 851; **every top unchanged**. Note off-piste is
    load-bearing at the top end too - dropping it would cost st-anton 2790 -> 2635 and monterosa
    3250 -> 3022, where the highest lift serves freeride terrain only.
  It is deliberately called **Iconic routes**, not "Iconic circuits": a circuit (Sella Ronda) is one
  shape of the thing, and most resorts' iconic line is a point-to-point descent. Model it as
  `waypoints[] + loop: boolean`.
- **A duplicate JSON key silently deletes the earlier block, and nothing anywhere warns.** Adding a
  `"status"` object to a locale file that already had one produced **valid JSON**; `JSON.parse` keeps
  the *last* occurrence, so `app.status.loadingResorts` / `errorResort` and friends vanished and the
  AppBar's loading and error banners would have rendered raw keys. Build, lint and i18next were all
  green throughout. **Grep the catalogue for a block's name before adding it**, and treat a suddenly
  missing string as a duplicate-key symptom rather than a typo.
- **Occasional + spatial + list-shaped belongs in the AppBar overflow, not in a card.** "Custom
  links" held a whole panel card and, on mobile, one of five bottom-nav slots, for something a user
  touches perhaps once a season - while the card body is a list plus a form, i.e. exactly what a
  dialog does better than a 400 px sidebar. It moved to a `Dialog` behind the ⋮ menu, alongside a new
  **About**. Four things this needed:
  - **The ⋮ had to become permanent.** `AppBarOverflow` rendered only when `isNarrow` (it existed to
    fold the language picker and theme toggle away on a ~360 px screen), so on desktop there was no
    overflow to hang anything on. It now renders at every width, with the language/theme block still
    behind `compact`. The **resort picker stays out of it**: it is how you change mountain, so it
    must remain one tap. Inside the menu **every row is one line with one icon** - the language list
    was a subheader plus two permanent rows, three lines carrying no glyph, so it became a
    `LanguageIcon` row with a chevron and a `Collapse`. It re-collapses on close, and the label stays
    bilingual (`Language / שפה`) for the same reason the desktop control is a globe: someone who
    cannot read the current language still has to find their way out of it.
  - **`keepMounted` is mandatory, because pin mode closes the dialog.** Picking a point "anywhere on
    the map" closes the dialog and the map click reopens it - the same close/reopen contract
    `enterLinkPinMode` already had for the mobile sheet, now applied at all widths. Without
    `keepMounted` MUI unmounts `DialogContent`, `CustomLinkPanel` loses the local `adding` state, and
    the user comes back to a collapsed card with their half-filled form gone. The pinned point itself
    survives (it lives in `App`); the form around it does not.
  - **The menu item carries the count the card's summary used to.** A card gives state away for free
    in its collapsed one-liner ("2 links"); a menu item behind an icon gives nothing, so the item
    shows a `Chip` when `linkCount > 0`. Anything moved out of a card owes this.
  - **The About dialog links the GitHub PROFILE, not the repo.** `Chaim-Gluck/SkiWaze` is private, so
    a repo link 404s for every visitor and reads as a broken app rather than as closed source. One
    string in `AboutDialog.tsx` if that ever changes. Name and year are pinned `dir="ltr"`.
  `openSection` is plain `useState`, never persisted, which is what made deleting the `'links'` value
  safe - no returning user can hold a stale value and land on a blank sheet. Check that before
  removing any section id.
- Mobile (≤820px) = **bottom nav bar + bottom sheet**, and the two are not alternatives: the nav
  bar is the *only* navigator (4 fixed tabs - Plan / Resort / Closed / Filters; re-tapping the
  active tab closes the sheet) and the sheet is only a *container* for whichever section it
  selected. Both are MUI —
  `BottomNavigation` plus `PanelShell` (`SwipeableDrawer`). Three things there are load-bearing:
  - **The sheet has a fixed height, not `max-height`.** Content-driven height meant the panel
    jumped 458 px between tabs and the map behind it went 95 px → 537 px. There is exactly **one**
    height (`SHEET_VH`, 68), so switching tabs moves nothing at all. It started as two — a peek
    plus a tall one for Preferences, which needed ~930 px — and collapsing that section's
    measured-speeds diagnostics table removed the need for the second. If a section ever cannot
    fit, prefer a disclosure **inside** the section over a second sheet height: the second height
    is the thing that makes the panel jump. Preferences still scrolls ~54 px, deliberately —
    sizing the sheet to its densest section would cost every other tab 66 px of map.
  - **The sheet is non-modal, and sits ON the nav bar rather than behind it.** A sheet that stops
    short of the top exists so you can still work the map above it, so there is no backdrop. A MUI
    Modal's root covers the viewport even with `hideBackdrop`, so the root gets
    `pointerEvents:'none'` and the paper takes them back — without that the map is dead under a
    backdrop that isn't drawn. Anchoring the paper at `bottom: NAV_H` (rather than 0, with padding
    added back inside) reclaims 72 px that were permanently under an opaque bar.
  - **The nav bar sits at `zIndex.drawer + 2`.** A Drawer defaults to 1200 and would bury the bar,
    i.e. bury the navigator.
  On mobile the accordion header is dropped (`AccordionSection`'s `bare` prop): the tab you just
  tapped already names the section, so the header is a second copy of it above a chevron that
  expands something already expanded.
- **On mobile, "compute" must not steal the sheet from the result it just computed.** The Longest
  run flow had its two behaviours exactly **inverted**: `computeLongestRun` closed the sheet
  unconditionally, so asking for the three longest runs threw the user onto the map *before* they
  could compare them, while `onShowOnMap` — the button literally named "Show on map" — was the one
  that never revealed the map. Finding now keeps the list up and only `onShowOnMap` closes the sheet
  (mobile only; on desktop the panel is a sidebar and closing it is pure loss). Once the sheet is
  gone the run is an anonymous highlight, so `LongestPreview` mirrors `RoutePreview`'s floating card
  — prev/next, distance/descent, start→end, **Details** to reopen the sheet, dismiss, and a primary
  action that skis *that* run. Reuse the existing preview pattern for any future "we hid the panel
  to show you the map" case; the identity of what is highlighted has to survive the jump.
- **i18next must be initialised WITH the stored language — a provider effect is too late.**
  `changeLanguage` is async, so initialising `lng:'en'` and letting `LanguageProvider` correct it
  leaves a window in which `t()` still answers in English. Anything resolving a string *eagerly*
  during that window keeps the English copy for the whole visit: the once-a-day "statuses assumed
  open" notice freezes its text into React state on mount, so a Hebrew user saw it in English on the
  landing resort and correctly in Hebrew only after changing resort. `config.ts` now exports
  `storedLanguage()` and both `init({ lng })` and the provider's `useState` read it, so React and
  i18next agree on the first render. This is the *third* instance of the same bug (unit labels were
  the first) — when adding anything that captures a translated string outside render, check it.
- **A native `datetime-local`/`date`/`time` input is untranslatable and unthemeable — never ship one
  in a localized UI.** The calendar/clock popup is drawn by the browser, not by us: it takes its
  language from the **OS/browser locale**, so a Hebrew user got an English calendar, and no MUI
  theme or CSS of ours reaches it (it also looked nothing like the rest of the app on mobile).
  Anything the user must read has to be React we render. `ArriveTimePicker.tsx` replaces it with two
  MUI `Select`s and quick chips. Two details that are not obvious: the hour:minute row is pinned
  `dir="ltr"` because a clock reads HH:MM in every language and would otherwise mirror in Hebrew;
  and the minute list is 5-minute steps **plus the current value if it is off-grid**, because the
  default (now + 1 h) and the chips are relative to the clock, and snapping would silently change a
  time the user picked. The **date was dropped on purpose** — you plan an arrival while standing on
  the mountain, so it is always today, or tomorrow when the chosen time has already passed (the
  picker resolves that itself and says so). The wire format stays a `datetime-local` string, so the
  two `planRoutes` call sites are untouched.
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
- **The "Map" base is OpenFreeMap Liberty, a VECTOR style, and `tile.openstreetmap.org` is gone.**
  The decision and every reason for it, because the obvious reading of the OSM tile policy is the
  wrong one and will otherwise be re-litigated:
  - **It is not a rights problem.** The policy's own opening line is *"OSM data is free for everyone
    to use. Our tile servers are not"*, and §9 scopes the whole document to the raster tiles at
    `tile.openstreetmap.org`. Web-app use is **explicitly permitted** (*"normal interactive viewing
    by a human where the client requests only the tiles needed for the current viewport"*). None of
    this touches the **pipeline** - Overpass is a different service under a different policy, and
    the data itself is ODbL-free. Do not conflate the two.
  - **What actually decided it is §4: offline use is flatly prohibited** and *"will be blocked
    without notice"*. That kills the `offline-pwa` backlog item outright on raster tiles, and the
    policy's own recommended remedy is to move to vector tiles or a provider that permits caching.
    Secondary: §7 gives no SLA, reserves withdrawal at any time and singles out commercial or
    donation-seeking services.
  - **We had violated exactly one named rule, and it was invisible.** *"You must not set a
    restrictive Referrer-Policy that prevents the HTTP Referer header being sent"* - which is
    precisely the Azure `same-origin` default fixed in `staticwebapp.config.json`. Worse, the
    `Referer` and `User-Agent` are the **browser's** to send, so a privacy extension or an embedded
    webview can get a user blocked with nothing we can detect or fix. A dependency whose compliance
    we cannot guarantee per user is a dependency we do not control.
  - **Measured, not assumed** (one 1200x800 viewport at z14 over Madonna): Liberty **197 KB** of
    tiles against the raster's **617 KB**, 15 requests against 35, and because Liberty's vector
    source stops at `maxzoom: 14` and everything past it re-renders client-side, **zooming in to
    inspect a junction costs zero bytes** where raster needed a fresh set per zoom level. First view
    adds a 42 KB style and one sprite pair (48 KB at 1x, 116 KB at 2x) - **a browser fetches one
    pair, never all four**, which an early version of the measurement got wrong by summing them.
    Caveat to state whenever quoting this: **bytes were measured, wall-clock was not.** Vector moves
    work from network to CPU, so first paint on a low-end phone need not improve proportionally.
  - **It is SPLICED into the live style, never `setStyle`.** `setStyle` tears down every source,
    layer and `addImage` we add on load (the resort flags among them) and would require re-adding
    all of it on `styledata` - a do-no-harm violation for what is only a change of base map.
    `loadLibertyLayers()` fetches the style, adds its sources, calls **`map.setSprite()`** and
    re-adds each layer under a `lib-` prefix before `'hillshade'`, so shaded relief and every data
    layer still draw on top. `setSprite` is the thing that made this viable at all: `BASE_STYLE`
    sets only `glyphs`, and Liberty's icon layers draw nothing without a sprite.
  - **`BASE_STYLE` keeps a flat `base-void` background layer** so the moment before the 42 KB style
    arrives reads as a loading map rather than a white page, and `loadLibertyLayers` fails soft -
    a dead tile host leaves that background, not a crash.
  - Reshaping the `BaseMap` union was safe because `base` is plain `useState` in `MapView.tsx` and
    is **never persisted** - same reasoning as `openSection`. Check that before reshaping any union.
  - **Do not score a base map on whether it draws lift lines.** That was an early argument for
    staying on OSM raster and the user disproved it: we draw our own lifts from `geo.json`, so
    base-map lifts are duplicate ink - and a raster base paints **raw** OSM, including the 401
    non-passenger aerialways, 322 station polygons and 16 lifecycle-dead lifts (*"Progetto
    Cabinovia"*, *"(en projet)"*) the pipeline deliberately removes. A base map that shows lifts will
    therefore **contradict** our own layer by advertising a lift that was torn down. Terrain context
    is ours too (`dem` + `hillshade`), so the base map's real job is narrow - roads, buildings, place
    names, land cover.
- **ODbL attribution must follow OUR DATA, not whichever base map happens to credit OSM.** Our
  pistes, lifts and areas are compiled from OpenStreetMap and require attribution independently of
  the base. Until the `pistes` GeoJSON source carried an `attribution`, the credit rode entirely on
  the base map's own string - so selecting **satellite** left the map crediting only
  `Imagery © Esri, Maxar, Earthstar Geographics` while every run and lift drawn on it was
  OSM-derived. It was masked for as long as it existed only because 2 of the 3 bases happened to
  credit OSM. MapLibre lists a source's attribution only while that source is **in use**, which is
  what makes the source the right place to put it - and also makes the attribution control the one
  reliable oracle for *"did this base map actually load"*, far better than counting requests.
- **Two probe traps when measuring anything MapLibre fetches, and both produce a confident, wrong
  ZERO.** Chasing the Liberty verification cost an hour to these: **(a) MapLibre fetches vector
  tiles and glyphs in a Web Worker**, so they never appear in the main thread's
  `performance.getEntriesByType('resource')` - the count was 0 while the map was demonstrably
  drawing. **(b) That buffer caps at 250 entries** by default, and in dev Vite's own module requests
  exhaust it unaided, so even main-thread traffic can vanish. `setResourceTimingBufferSize` and
  `clearResourceTimings` help with (b) and cannot help with (a). Use the attribution control.
- **`symbol-placement: 'line-center'` gives a feature exactly ONE label, at its midpoint.** That is
  why lift names kept disappearing when the user zoomed in: past the midpoint the lift had no name
  *anywhere* on screen, and only zooming back out brought it into view. Pistes had the same symptom
  from a different cause — `'line'` placement is right, but a flat `symbol-spacing: 450` px is under
  one label per phone-screen width, and `text-max-angle: 40` then rejects further placements on a
  twisty run. Both layers now interpolate spacing by zoom (`12:400, 14:300, 17:200`); `symbol-spacing`
  *is* zoom-interpolatable in MapLibre. Judge label density at a **phone** width, not a desktop one.
- **`geometryForClosure` FLATTENS every matching edge into one coordinate array** — fine for its only
  original caller (`locateClosure`, which just fits bounds) and silently wrong for anything drawn: as
  a LineString it jumps in straight lines between disconnected segments. Measured on Madonna, 2 lift
  closure keys are **4 edges**, so it would have drawn 2 zig-zags between lift bases and tops. Use
  **`closedGeometries()`** (one polyline per edge) for any visual use. Closed terrain is now rendered
  (red dashed + repeating ⊘ badges) — before this, closing a run changed routing *silently* while the
  map still drew it as skiable.
- **Preview mode is a trigger, not a preference, and is never offered to someone who can really be
  followed.** Navigation used to enter and sit on `waiting for location` forever with no exit but
  Exit, for anyone who denied location or was off the mountain. Preview replays the route from a
  simulated position, offered **only** on a detected condition: geolocation error -> `noFix`, a good
  fix farther than `PREVIEW_FAR_M` (10 km) -> `far`, nothing at all within 12 s -> `noFix`. One offer
  per nav session (`previewAsked`), and it **auto-exits** the moment a real fix arrives at the resort.
  Being off-route is a **reroute, never a simulation**. Three implementation rules:
- **Declining Preview must LEAVE navigation, and a far fix must never reach the guidance code.**
  These are the same bug seen twice. "Not now" originally only closed the dialog, so navigation kept
  running off a fix we had just told the user was a thousand kilometres away: `snapToRoute` happily
  returns a nearest point on the route from anywhere on Earth, and the banner then printed a
  distance-to-turn and an ETA computed from it - fabricated numbers wearing the costume of live
  guidance, with nothing on screen admitting it (the off-route alarm is deliberately suppressed for
  a far fix, so that safety valve was closed too). Two fixes, and both are needed: `navData` returns
  **null** when `isFarFromResort(userPos)` and there is no `simPos`, so the overlay falls back to its
  honest waiting state (hence `waiting={!navData}`, not `!userPos`); and `declinePreview` exits
  navigation. It deliberately does **not** call `exitNav` - the computed plan, its options and its
  step list are exactly what is still worth reading without a position, so it keeps them and opens
  the panel on them. Generalise it: any surface that consumes a position owes a check that the
  position is somewhere the answer can be true. Three implementation rules:
  - **`isFarFromResort` measures to the nearest graph NODE, not the resort centre** — on a sprawling
    multi-valley resort you can stand on a piste 10 km from the centroid. The threshold is
    deliberately generous: a false "far" merely offers Preview to someone who is there (harmless),
    a false "near" withholds the only escape from the dead end.
  - **Preview must seed a position when it opens** (and re-seed on reset), or the overlay sits on the
    very "waiting for location" state it exists to escape. For the same reason the locate FAB only
    toggles camera-follow while in Preview — clearing `simPos` there re-creates the dead end.
  - **The follow camera may only fly to a position that is AT the resort.** Exiting Preview clears
    the simulated position while `following` is still true, so the camera handed itself back to the
    user's real fix and eased the map from Madonna to **Amsterdam**. `posAtResort` gates what is
    passed to `MapView`'s `following`, `exitNav` drops follow and stops the watch when no usable fix
    exists, and tapping locate while away from the resort now *says so* rather than lighting the FAB
    over a motionless map. A simulated position is at the resort by construction; a real one is not.
  - **The signal is a frame, and the puck is differentiated by SHAPE.** A puck recolour is weak: it is
    small, usually under the user's thumb, and often off-screen. The `--sim` amber `#ffb300` was
    forced, not chosen — red already means off-route (`error.main` banner) and orange `#ff6d00` is
    already the nav arrow. Simulated puck/arrow get a dashed ring, which survives colour-blindness
    and greyscale.
  - **Never override `position` on a MapLibre marker element.** MapLibre positions markers with a
    one-class `.maplibregl-marker { position: absolute }` rule, so a two-class selector like
    `.nav-arrow.simulated { position: relative }` wins on specificity, the arrow stops being
    absolutely positioned, and its `border-radius: 50%` ring stretches into a screen-wide flat
    ellipse **while the arrow itself drifts off the real position**. Size the element instead
    (`.nav-arrow` is an explicit 46x46 flex box).
  - **One skier, one marker.** Navigation draws `.nav-arrow` at the position *snapped to the route*
    while the raw `.user-loc` puck draws the *unsnapped* fix plus its accuracy halo, so both on
    screen at once reads as two skiers a few metres apart. `MapView`'s puck effect bails on
    `if (!userPosition || nav)`.
  - **A simulated position must never be sampled into the measured-speed store.** `App` feeds
    `userPos.speed` into `measuredSpeeds` on piste legs, and `userPos = simPos ?? live.position` —
    so every Preview tick was writing the *playback dial* into the per-colour averages, and "use my
    measured speeds" would then calibrate the router to a UI slider. Guarded with `if (simPos)
    return;`, which deliberately covers the DEV simulator too.
  - **Preview plays back at a MULTIPLE of the skier's own modelled pace, not an absolute m/s.** The
    old fixed 12 m/s "Normal" preset showed **43 km/h** on a red run to a skier whose model says 33.
    App derives `simPace` from the current leg: for a piste leg the display speed is
    `estimatedByColor[color]` (already TRUE) and the advance rate is that divided by
    `SNAKE_FACTOR[color]`, because the simulation moves along the **centreline** and using the true
    speed there would run Preview's clock ~1.3x fast. Off a piste there is no colour to model, so
    the route's own remaining pace (`rem.distM / rem.timeS`) is the fallback. **DEV keeps its raw
    m/s slider** — that path is a tool, not a user-facing estimate.
  - **"Off-route" is only a meaningful accusation against a fix that is on the mountain.** `offRoute`
    is `snap.offM > max(30, accuracy+20)`, and a fix 1000 km away is trivially more than 30 m off the
    line — so the same physical fact ("we cannot follow you") lit the Preview offer *and* a red
    "ski back to the blue line" alarm at the same time, each contradicting the other. Off-route means
    **you strayed**; being nowhere near the resort is a different condition with a different remedy.
    Gated on `!isFarFromResort(userPos)`, which forced `PREVIEW_FAR_M`/`isFarFromResort` above
    `navData` in `App.tsx`. Generalise it: before adding a warning, check whether an existing state
    already implies it, or the user gets two answers to one question.
  - **Bind a number to its unit in the CATALOGUE, not with `nowrap` on a span.** "1.8 km · 4 min
    left" broke between "4" and "min". Fixing it per-component fixes one place and leaves every other
    unit render to break later, so the NBSP (U+00A0) went into the `units.*` strings themselves
    (`{{value}}\u00A0km`) in **both** locales, plus binding "left" to the time in `nav.remaining`.
    Trap when verifying: `JSON.stringify` prints NBSP indistinguishably from a space — **dump
    `charCodeAt`**, never trust the printed string.
  - **The nav banner's hierarchy needs an arrow, not just a bigger font.** The manoeuvre
    block and the "Now" strip read as peers when the only difference was size. `turnAt()` in
    `navigation.ts` supplies a Waze-style arrow. (A "Next" caption sat above the run name for a
    while and was later removed - see the caption bullet below.) Three things about it: the arrow
    has **exactly three states** and both turning glyphs are
    the *slight* ones — a square 90° glyph reads as "turn at the junction", which is not what a
    piste does (it bends, and the arrow only has to say which side), and grading the angle finer
    just produces arrows that argue about the same bend; it measures the bearing change over a
    **±25 m window**, not between adjacent vertices, because OSM geometry is dense enough that one
    stray vertex at a junction would otherwise decide it; and it is computed at
    `path.legEndS[current.toLeg]`, the boundary where the next step begins, not at the snapped
    position.
  - **Icon-only in a corner beats a labelled button in the middle of a status bar.** The ETA bar's
    "✕ Exit" button was as wide as the text it sat beside and forced the remaining-distance line to
    wrap. It is now an absolutely positioned `IconButton` with the word surviving in the tooltip and
    `aria-label`, `insetInlineEnd` (logical property, so RTL flips it) and **vertically centred on
    the readings row** (`top: 50%` + `translateY(-50%)`) rather than pinned to the corner.
    Its inline-end inset is mirrored as padding on the ETA row, so a long remaining/ETA line
    cannot run under it.
  - **An off-route action gets its own row, not space stolen from the readings.** Re-route beside
    the ETA covered the clock and clipped the remaining text on phones. It now occupies a
    full-width row below the readings only while off-route. Exit is anchored to the readings
    row rather than the whole Paper, so the action's extra height cannot move the close control.
    Normal navigation keeps its single readings row.
  - **The whole nav overlay is FIXED dark chrome, and half-converting it is the bug.** Every piece
    of it - manoeuvre banner, ETA card, speed dial - reads over **map tiles, which do not change
    with the app theme**, so a fill taken from the light panel colour puts a white card on bright
    snow in exactly the conditions navigation matters most. That reasoning was written on the
    banner's own `NAV_BAR_BG` from the start and simply never applied to its two neighbours, which
    followed `background.paper` - so light mode drew one dark card beside a white one and a washed
    out dial, which is what a user reported ("pale like a sick person"). The colour is
    **`--nav-bar` in `App.css`, deliberately outside `TOKENS`**, exactly like `--sim`: it is one
    value for both modes, and listing it in the theme would imply it could differ. Three follow-ons,
    each of which bit:
    - **Accent and muted text have to be pinned too.** `primary.main` and `text.secondary` invert
      with the theme, so on a fixed background they are only right in one mode - light mode's
      `#1565c0` is near-invisible on navy. `NAV_BAR_ACCENT` is the *dark* palette's blue, so dark
      mode is unchanged and light mode stops inverting.
    - **Colour must go through `sx`, never the `color` PROP.** The `Paper` sets `color: '#fff'`,
      and `<Typography color={...}>` lost to that inherited value - both readings rendered plain
      white with no error anywhere. `sx` won. Suspect this whenever a Typography colour silently
      does nothing inside a coloured container.
    - **Dark mode is not byte-identical, and say so.** The card and dial were `#1b2733` (panel
      slate) and are now `#16233d` (nav navy). That shift *is* the fix - it is what makes them
      match the banner - but it is a change to the mode that looked fine, so it must be reported
      rather than described as a no-op.
  - **The manoeuvre card mirrors in RTL; the bottom bar does not. They are different kinds of
    thing.** The bottom bar is pinned to **physical map corners** in every language (the speed dial
    is bottom-left of the *terrain*, not of the reading order) - so it needs
    `flexDirection: rtl ? 'row-reverse' : 'row'` and `rtl ? insetInlineStart : insetInlineEnd` to
    defeat the inherited RTL order. The manoeuvre card is the opposite: it is a **sentence**
    spanning the full width with an icon leading it, and "leading" means where reading starts,
    which in Hebrew is the right. Waze and Google Maps both mirror their manoeuvre banner in Hebrew.
    The risk worth checking before accepting that is the arrow **glyph** flipping - "bear left"
    must stay left in the *world* whatever the language - and it does not: measured in Hebrew the
    SVG carries `transform: none`, because `stylis-plugin-rtl` rewrites CSS properties and not SVG
    path data. The column moves to the right, the arrow inside keeps pointing where the terrain
    goes. Note `direction: 'ltr'` is **not** available as an escape hatch: the plugin rewrites it to
    `direction: 'rtl'`, producing the exact opposite of what the code says.
  - **The bottom bar is two objects in two corners, and the empty slot is load-bearing.** Speed dial
    bottom-left, ETA card bottom-right, no hairline between them - a single centred bar made the
    two readings look like one instrument when they answer different questions. Implemented as a
    full-width `justify-content: space-between` row, which means **an empty `<Box />` placeholder is
    required** when there is no speed: with a single child, `space-between` parks it at the *start*,
    so the ETA card silently jumps to the wrong corner while waiting for a fix. The dial also needs
    its `.standalone` rule once free-standing - the default translucent green fill has nothing
    behind it over snow or satellite imagery.
  - **Optical corner parity is not numeric parity.** The dial sits at 10 px from both edges and the
    ETA card at 14. A circle's corner-most point is a single tangent; a rounded rectangle's whole
    corner arc crowds the edge, so at equal insets the card reads as falling off the screen. The
    extra 4 px is `mb: 0.5` plus a direction-aware `marginInline*`.
  - **A caption that repeats what a glyph already says is deleted, and a badge is centred in
    PIXELS.** Two trims to the manoeuvre card. "NEXT" went because the arrow already states "this
    is ahead of you" - but the 62 px `minWidth` on that column stayed, or the instruction shifts
    sideways as the distance string changes width. And the inline shield was reproportioned
    (38x22, font 15) then measured against the text line's centre: `vertical-align: middle` centres
    an inline-block on **baseline + half x-height**, which is not the line box's centre, so it sat
    **1.6 px low**. The correction is `position: relative; top: -1.5px` in **px, not `em`** - `em`
    on the badge resolves against the badge's own 15 px, while the sentence around it varies 14-18 px
    via `bannerFont()`. `.pbadge.big` is used only in this banner, so it has no blast radius.
  - **On the ETA card the arrival CLOCK leads and the countdown is the caption.** "19:47" is the
    reading you act on - you compare it against a lift closing time or a lunch booking - while
    "36 min left" is the same fact relative to now and only says how long to keep going. Distance
    and countdown share the caption line because they are two readings of one thing; splitting them
    would assert there are three facts on the card.
  - **A weight that looks right in Hebrew is shouting in English, because the cap only applies to
    one of them.** `App.css` caps Hebrew at 600 under `:lang(he)`, so a literal `fontWeight: 800`
    rendered the two languages **200 apart** and only English was heavy - worst on "ETA", which is
    all-caps and so carries no descenders or lowercase to break up the mass. Dropping the base to
    700 closes most of the gap and leaves Hebrew untouched, since the cap still catches it. Check
    the *computed* weight in both languages before and after; the authored number is only the
    English one.
  - **SUPERSEDED - the run you are ON is a chip on the map, not a strip on the manoeuvre card.**
    This bullet used to say the opposite ("the run you are ON belongs under the run you are heading
    FOR, on the same card"), and the reasoning was sound as far as it went: the two names are the
    same kind of fact and were separated by the whole map. What it missed is that they are *not*
    the same kind of **instruction**. The manoeuvre card answers "what do I do next"; the current
    run answers "where am I". Putting the second inside the first made a card whose job is one
    question carry two, and paid ~32 px of map for the second one on every frame - including the
    frames with nothing to say, because the strip reserved its height unconditionally. It is now a
    single minimal pill, and it lives **on the map as a MapLibre marker anchored under the nav
    arrow**, not in the overlay at all.
    - **It is a marker, not a floating div, and that is the whole point.** "What am I on" is a fact
      about a *place*, so it belongs at the place. A first pass parked it at the foot of the screen
      and the user rejected it for the same reason the strip was rejected: the eye has to travel
      away from the puck to read a label about the puck. Anchored at `nav.lon/lat` with
      `anchor:'top'`, `offset:[0,36]` it sits directly under the arrow and **goes with the skier
      when the user pans**, instead of continuing to caption a spot that is no longer on screen.
      `rotationAlignment` and `pitchAlignment` are both `'viewport'`, so the pill stays upright and
      legible while the arrow rotates under it.
    - **A marker's box has no parent width**, so its `max-width` must be in viewport units (`46vw`).
      A percentage resolves against a content-sized box and silently does nothing - the pill then
      grows to whatever a long OSM name needs and covers the terrain ahead.
    - **It is handed in as data, not as JSX.** `navRunChip(step)` returns `{ text, color } | null`
      and lives in its own `src/components/navChip.ts`, because exporting a non-component from a
      `.tsx` file trips `react(only-export-components)` (fast refresh). `NavOverlay` imports
      `COLOR_HEX` back from it so the colour vocabulary exists once; `App.tsx` passes the result to
      `MapView` as `navLabel`; when it is `null` the marker is **removed**, never emptied - an empty
      pill is a visible white crumb under the arrow.
    - **No verb, and the name only.** No "Ski"/"Take"/"Traverse" prefix, no colour word, no
      sentence - `DisplayStep.name`, which is the raw mapped name and so is never translated.
      **Nothing at all when the step has no name**, which is the honest answer for an unnamed
      traverse rather than a pill reading "traverse".
    - **This retires the `nav.now` caption and the rule that defended it.** That caption existed
      *solely* because Hebrew has no genderless present participle (`גולש`/`גולשת`,
      `רוכב`/`רוכבת`) and we have no user gender, so an English-style self-labelling "Skiing 89
      Nambino" could not be translated. A bare name has no gender to get wrong, so the problem is
      not worked around - it is gone. `nav.now` is deleted from both catalogues. (`nav.next` was
      later deleted too, for a different reason - see the caption bullet above. The manoeuvre card
      keeps its two-column geometry.)
    - **Colour is the app's existing vocabulary, never a new one.** The slope's own colour from
      `COLOR_HEX` for a piste, and for a lift the same slate `#37475a` that `.pbadge.lift` already
      uses in the step list. A skier learns the mapping once and it holds in the step list, on the
      map and here. Inventing a separate lift colour would have been a second vocabulary for one
      fact.
    - **The reserved-height rule dies with the strip, and is solved better.** The old `minHeight: 32`
      existed because `--nav-banner-h` drives where MapView's controls sit, so a strip that appeared
      and disappeared moved them mid-run. A chip floating over the map is in no card, measures into
      no variable, and can therefore come and go freely. The paired `gap: 1.5` / 62-wide-caption
      alignment constraints go with it.
  - **The navigation camera looks AHEAD, not at the skier.** Centring the puck spends half the map
    on terrain already skied. Both heading-up `easeTo` sites pass
    `offset: [0, containerHeight * NAV_LOOKAHEAD_FRAC]` (0.22), which by MapLibre's definition
    ("offset of the target center relative to real map container center") places the puck **below**
    centre - measured live at ~73% of the map's height. Three things:
    - **Use `easeTo.offset`, never map `padding`.** Padding is global camera state and would
      silently skew every unrelated `fitBounds` in the component.
    - **A fraction of container height, never a pixel constant**, so it holds on a phone and on a
      desktop map pane alike.
    - **Heading-up only.** North-up has no on-screen "ahead" to bias toward, so the offset is
      applied at the two heading-up sites (the follow effect and the post-gesture recentre) and
      nowhere else.
  - **3D terrain is the DEM paid for TWICE, and the second payment buys nothing.** The 3D toggle
    used to switch the `hillshade` layer **on** alongside `setTerrain`, which is the same elevation
    tiles consumed once to displace the mesh and again to shade a raster draped over that mesh. The
    relief is already in the geometry, so the shading layer is redundant ink at full per-frame cost,
    and it was the heaviest thing in the state a user reported rendering **black** on both a phone
    and a desktop. It is now explicitly `'none'` in **both** branches of the effect. Two siblings
    from the same investigation, and the order they were found in is the lesson:
    - **Zoom is capped at `MAX_ZOOM_3D` (16) while terrain is on**, restored to 22 on the way out.
      The `dem` source stops at `maxzoom: 15`, so every level past it meshes and drapes at a detail
      the elevation data cannot supply - the cap removes no relief a user could ever have seen. The
      trigger the user actually reported was *"zoom in a lot and then switch to 3D"*, with no
      navigation involved at all, which is what took the follow camera off the suspect list.
    - **`freezeElevation: true` on every follow `easeTo`.** With terrain on, an ease re-queries the
      centre's ground height on **every frame**, so the camera's altitude moves under it while DEM
      tiles are still arriving. The follow effect fires once per position tick, so each new ease
      interrupted the last mid-flight and the view bucked and lost the skier. It is a no-op without
      terrain, so it is set unconditionally rather than behind an `is3D` test.
    - **`opacityWhenCovered` defaults to 0.2**, so MapLibre fades *any* marker sitting behind 3D
      terrain - which is right for a pin on a real place and wrong for app chrome. The nav arrow
      vanishing in 3D was entirely this. All markers spread `MARKER_ALWAYS_VISIBLE`; it is a no-op
      in 2D, where nothing is ever occluded.
    - **MapLibre's default `maxPitch` is 60**, so `NAV_PITCH_3D = 62` had *always* been clamped and
      only ever read as a larger number than the camera actually used. Check a pitch against the
      clamp before treating it as a real value anywhere.
    - **The camera-inside-the-mesh theory was DISPROVED, and stating that is the point.** It is the
      obvious explanation for a black map and it is wrong here: camera altitude is derived from
      **zoom**, not from terrain, so clearance measured ~240 m at zoom 17.5 whether exaggeration was
      1.0 or 1.4. Exaggeration was still dropped to 1.0 (honest heights, no cost), but not for that
      reason. What was actually reproducible was **saturation** - `evaluate_javascript` timed out
      repeatedly the moment terrain rendered at nav zoom and never did in 2D - while DEM tiles
      fetched 200 as real PNGs, the WebGL context was never lost, no style error fired, and every
      sampled pixel came back light. A probe that cannot reproduce the symptom has still measured
      something; say which half you verified and which half you did not.
  - **A row levelled by `alignItems: 'flex-end'` is levelled by BOTTOM EDGES, so a bottom margin on
    one child is a misalignment.** The ETA card kept an `mb: 0.5` from when it and the speed dial
    sat in opposite corners; centred and flanked, that 4 px lifted it off the dial's line and the
    pair read as crooked. When two objects are aligned by an edge, nothing may inset that edge.

- **The A/B pins distinguish by PATTERN, not hue, and the panel shows the pin rather than its
  colour.** They were MapLibre's stock teardrop in green and red - the generic start/stop
  convention, chosen by nobody - which is wrong here twice over. Green and red are this app's
  **slope-difficulty vocabulary** (piste lines, step shields, legend, nav chip, Preferences chips),
  so on a map covered in green and red lines the two pins read as "easy run" and "hard run" rather
  than start and finish; and red/green is the **worst possible pair for colour-blindness** (~8% of
  men) applied to the one pair a user must tell apart at a glance. Every other hue is spoken for too
  (magenta is lifts on the debug map), so the honest fix is not a different colour - it is the same
  navy `#16233d` drop for both, with a **chequered flag** filling the finish. That survives
  greyscale, glare and colour-blindness, and it is a symbol a skier already knows instead of a code
  they must learn. Same discipline as casing the polygon spines rather than recolouring them.
  Four things it took three rounds of mockups to get right:
  - **A chequer needs square SIZE and square COUNT, and the first attempt bought one with the
    other.** MapLibre's marker has a white disc of r=5.5 at (14,15) in its 27x41 viewBox - an 11 px
    hole - and chequering *that* gives 2x2 at 5.5 px, right on the floor where a pattern dithers to
    flat grey. Growing the disc to 15 px buys 7.5 px squares and still only 2x2, which the user
    rejected in exactly the right words: *"not enough checkers to understand it is a finish point"*.
    **Dropping the hole inverts the problem** - the body is 27 px wide, so a 4x5 grid over the whole
    drop gives ~5.4 px squares *and* 20 cells. At 2x2 the eye reads "a shape with squares on it"; at
    4x5 it reads "flag". If it ever mushes on a low-DPI phone the remedy is 4x5 -> 3x4, one pair of
    numbers in `pinGlyphs.ts`, not a redesign.
  - **The silhouette is MapLibre's own geometry lifted verbatim**, body path, border path and the
    stacked ground-shadow ellipses, so the familiar shape is unchanged and **the tip is still the
    anchor**. Supplying `element` makes MapLibre drop the default marker's offset, so `pinOffset()`
    re-applies its own `-14` - derived from the tip sitting at the shadow ellipse's centre, not at
    the foot of the 41 px box. Reuse the number rather than deriving a second answer to it.
  - **Custom-link endpoints are the SAME pins, smaller.** They were a separate dot marker whose
    comment said "deliberately distinct from the nav pins", which is backwards: a from and a to mean
    the same thing in both places, so two shapes for one concept is a second vocabulary for one
    fact - the same mistake as inventing a separate lift colour. They are drawn at `LINK_PIN_SCALE`
    (0.72) only so the two *pairs* stay separable when both are on screen. Note the dot version had
    a sharper form of the colour bug than the map did: `CustomLinkPanel` uses green and red a few
    lines below to pick the link's **slope colour**, so one panel was spending red on two unrelated
    meanings.
  - **The panel labels carry the glyph, not the colour.** `PointPicker`'s `accent` prop existed for
    exactly one thing - tinting the From/To label text - and is deleted. Showing the marker teaches
    the symbol the user is about to hunt for on the map, the same reasoning as the Plan tab strip
    carrying the FAB glyphs. The artwork lives in `src/components/pinGlyphs.ts`, a plain `.ts` for
    the same reason as `navChip.ts`: exporting a non-component from a `.tsx` trips
    `react(only-export-components)`.
  - **A navy marker needs a WHITE HALO, and the two places it vanishes look unrelated.** Every
    slope hue is spoken for, so the drop is the nav-chrome navy - which is also the dark-theme
    panel's own background, so in the Plan card only the start pin's white disc survived, and the
    same pin would have disappeared over dark satellite imagery on the map. One halo fixes both.
    It is a **stroked copy** of the body path under the body, never a stroke on the body itself,
    which would be centred and eat 1 px of the artwork; the `viewBox` therefore gains 2 units of
    padding on every side, with `width`/`height` grown to match so one unit is still one pixel and
    `pinOffset()` is unchanged (the box grew symmetrically, so the centre and the tip both moved
    down 2).
  - **The drop shadow is dropped in the panels, not recoloured.** It is black ellipses at 4%
    opacity, so it is invisible on a dark background *by construction*. On the map that is correct
    and must stay - it lifts the pin off the snow, and the tiles never follow the app theme - but
    in a panel the only way to make it show is to make the glyph theme-aware, which would mean two
    different rules for one drawing. `pinSvg(kind, scale, shadow)` lets the two inline call sites
    pass `false`, so they render identically in both themes; at 0.62x the shadow was a few pixels
    of grey smudge and nothing was lost.

- **A reservation for a bar must be conditional on the bar existing.** `App.css`'s
  `@media (max-width: 820px)` rule gives the MapLibre bottom-corner controls
  `margin-bottom: calc(64px + safe-area)` to clear the bottom nav bar - but that bar is rendered
  `isMobile && !navRoute`, so during navigation it is **gone** and the 64 px was still being held.
  The zoom/compass and the ODbL credit floated ~64 px off the corner for the whole run, which the
  user reported as "as if the navigation card is not open". `.app` carries `data-nav` while
  navigating and the rule is undone under `.app[data-nav]`. Generalise it: any layout that subtracts
  space for a conditionally-rendered element owes the same condition, and the tell is an offset that
  looks right in the state you developed in and wrong in the other one.
- **Every map control column owes the `--nav-banner-h` dodge, not just the left one.** The
  Layers/Legend column in `MapView.tsx` has dodged the manoeuvre card since nav shipped; the
  locate/share FAB column in `App.tsx` (~L1808) did not, so on a phone the share button sat under
  the card. Same pattern: `top: navRoute ? 'calc(var(--nav-banner-h, 0px) + 6px)' : '12px'` in `sx`
  with a `@media (min-width: 821px)` override, `position`/`right` left **inline** so the RTL plugin
  cannot flip them. Keyed on `navRoute`, **never** on the variable's own fallback - `calc(0px + 6px)`
  would silently lift the buttons from 12 to 6 whenever not navigating.
  The left column must also key off navigation **mode**, not the `nav` position data:
  waiting has no usable fix but still renders the banner. Its mobile rule uses the
  existing `.app[data-nav]` attribute; desktop and ordinary browsing keep the original inset.
- **A styling attribute attached to a layout SLOT follows the slot when rows are reordered.** The
  ETA clock turned blue with nobody having asked for it, via two compounding steps: a
  `<Typography color="primary.main">` had been **silently losing** to the parent `Paper`'s
  `color: '#fff'` for months (the same value in `sx` wins - suspect this whenever a Typography
  colour does nothing inside a coloured container), so the decision sat dormant; a later row flip
  moved it onto different content because it was attached to the bold line, not to the clock; and
  the prop-to-`sx` fix then made it render for the first time, on the wrong reading. It is now plain
  white - `#4aa8ff` on `#16233d` is ~3.4:1, under the 4.5:1 body-text bar, and blue already means
  "interactive" in this app.
- **The ETA card is centred with equal-width flanking slots, not `justify-content: center`.** The
  bottom row is dial | card | spacer under `space-between`. With `center` the card would drift
  horizontally the moment the speed dial appears or disappears (waiting for a fix, or no speed yet).
  The two spacer widths **must track `.nav-speed-circle`'s width in `App.css`** - they live in two
  different files with no shared constant, so both carry a comment saying so. Dial is 48x48 against
  the card's measured 45 px.

- **A portalled overlay centres on the VIEWPORT, and on desktop the map is not the viewport.** A MUI
  `Dialog` or `Snackbar` renders into `<body>`, so "centred" means centred on the window - but the
  desktop layout puts a 400 px sidebar beside the map, leaving anything centred over the map 200 px
  out. Both offenders were overlays that appear *before* the user has touched anything (the
  assumed-open status notice on loading a resort, and the Preview offer), which is exactly when a
  misplaced element reads as a layout bug rather than as a choice. `mapCenteredSx`
  (`src/utils/mapCentered.ts`) is the one rule; three things about it are deliberate:
  - **The shift is `padding-inline-start`, never `left` or `transform`.** It *composes* with MUI's
    own positioning instead of overriding it, so it cannot break when MUI changes how it centres a
    Dialog container. One mechanism covers both shapes: a flex centring container
    (`.MuiDialog-container`) shrinks its content box by the padding, and a `left:50%;
    translateX(-50%)` root (the Snackbar) grows by it - both move the content by **half**, which is
    exactly the half-sidebar wanted.
  - **It is a logical property, so it flips itself.** The sidebar is the flex row's first child, so
    in Hebrew it renders on the *right* and the map centre moves the other way; a physical
    `paddingLeft` would push RTL the wrong way. (The RTL plugin also rewrites MUI's own `left:50%`
    to `right:50%`, and the arithmetic works out the same in both directions - check both.)
  - **The width is `--sidebar-w`, a `:root` variable `.sidebar` itself uses**, so the offset can
    never drift from the layout it is compensating for. Returns `{}` on mobile, where the panel is
    a bottom sheet and the map spans the full width.
  Menus are exempt - they anchor to their trigger, not to the window.
- **A destructive-ish state the user already knows about must be reachable without first performing
  an unrelated task.** "Closed today" could only be populated by planning a route *over* the thing
  and clicking ⊘ on the step, so a skier who arrived knowing a lift was shut had to first ask for a
  route across it, and a run no route happened to use could not be closed at all. `closableItems()`
  (`src/routing/closures.ts`) feeds two searchable pickers in the card. Two rules it must keep:
  it emits the **name-based** keys (`lift:<name>`, `piste:<ref>~<name>`), never `edge:<id>`, which is
  order-dependent and orphans on a rebuild; and it excludes **synthetic/custom** edges as a *source*
  of names, so the app's own invented plumbing is never offered as if it were signposted terrain (a
  name that also exists on a real edge still appears, and closing it still closes the synthetic
  copies, because `resolveClosedEdgeIds` matches the key rather than this list). Measured over all
  18 resorts: 9-181 lifts and 16-393 runs each, with **zero duplicate labels**, so the picker never
  shows two identical rows.
- **The Closed card is ONE grouped list with multi-select pickers - not tabs, and never filtered on
  tick.** Three decisions, each the opposite of the obvious one:
  - **Subheaders, not tabs.** Every other overgrown card here got a tab strip (Preferences, Plan,
    This resort), and this one must not: the card's whole job is answering *what is shut right now*,
    so a total you can read at a glance is the feature. Tabs would hide half the answer behind a
    click and put a count where the items should be. `ListSubheader` per group (Lifts / Runs /
    Other), and a **lone group draws no subheader at all** - a heading over the only section is
    noise. Groups come from the key prefix (`groupOf()`), never from a lookup into `closable`, so a
    key whose item has since vanished from the graph still lands somewhere.
  - **The picker is `multiple` + `disableCloseOnSelect`.** Closing a sector means closing several
    neighbouring runs, and reopening the list for each one is the entire friction the pickers were
    added to remove.
  - **Already-closed options stay in the list, ticked - they are never filtered out.** Removing an
    item on tick makes the list reflow under the finger that is about to tick the *next* one, which
    is precisely the adjacent-items case this exists for. It also makes the control do both jobs:
    unticking is a reopen. And it needs `renderValue={() => null}` (MUI 9's rename of `renderTags`),
    because every closed item is already listed below with a reopen button, so chips in the input
    would be the same fact twice in a field that grows without limit.
- **When a feature adds a second way to do something, every place that teaches the first one is
  stale.** Adding the pickers left `app.statusNotice.tip` still saying only "⊘ on a route step" -
  and that notice fires on *landing*, before any route exists, so it was advice the user could not
  act on yet. Grep the catalogue for prose describing the old path, not just the component.

## Internationalisation (English + Hebrew/RTL)
- **Stack:** i18next + react-i18next. `src/i18n/config.ts` (catalogue registration, `LANGUAGES`,
  `RTL_LANGUAGES`, browser detection), `src/i18n/LanguageProvider.tsx` (owns the language, the
  emotion cache and `document.dir`), `src/locales/{en,he}.json`. The provider sits **outside**
  `ThemeModeProvider` in `main.tsx`: the RTL emotion cache must wrap MUI's `ThemeProvider` or the
  style plugin never sees MUI's styles.
- **Names are never translated.** Piste, lift and resort names come from OSM and must match the sign
  at the top of the run. Only the app's own wrapper words are translated. Base-map `attribution`
  strings (legal text), `Logo.tsx` (brand) and `ErrorBoundary.tsx` (it renders *after* React has
  crashed — calling into i18n there could fail twice) are deliberately left alone too.
- **Routing modules emit keys, not prose.** `buildRoute`/`cost`/`closures`/`plan` are pure and also
  run under Node in the pipeline probes, where there is no `t()` and no language. They therefore
  return a `TextRef { key, params }` (`src/types/domain.ts`) and only the UI turns it into words,
  via `tr(t, ref)` in `src/utils/text.ts`. A param may itself be a `TextRef` (a run's label nested
  inside a leg sentence), resolved one level at a time — that keeps the catalogue flat instead of
  exploding combinatorially, while still letting Hebrew reorder the sentence around the name.
- **A discrete fact must never be recovered from display prose.** Three separate bugs were this one
  mistake, and each silently degrades the moment the prose is translated:
  1. Route badges were the English words on the card, so `reconcileLabels` compared display text —
     hence `RouteLabel` keys.
  2. The notice Snackbar picked its `severity` by regex-matching English words in the message
     (`/could not|no route/` → warning) — hence an explicit `severity` field on `PopupNotice`.
  3. `NavOverlay.stepText()` stripped a trailing `(blue)` with a regex over the colour names —
     hence `DisplayStep.labelShort` (colour-free, built in routing) and `DisplayStep.name` (the raw
     mapped name, which `pisteNumber()` reads instead of scraping the label).
  A fourth instance would look the same: state held as a finished English sentence. The
  loading/error banner was exactly that, and is now a `StatusState` discriminated union translated
  at render.
- **Whatever a badge says, the sentence beside it must not repeat — and the de-duplicated label is
  built in ROUTING, never by trimming the prose.** `labelShort` already existed because the colour
  shows as a shield; the nav banner then printed the slope *number* twice as well ("89" in the
  shield, "Ski 89 · Nambino" beside it). `DisplayStep.labelBadge` drops both, via `pisteLabelBadge`
  in `buildRoute.ts`. A third badge-backed fact would need the same treatment - do not reach for a
  regex over the label.
- **The badge is placed by the CATALOGUE, not by cutting the sentence.** The shield reads best
  inside the sentence ("Ski [89] Nambino"), but routing is pure and cannot emit a React node, and
  the UI must not split a translated string at a fixed offset - Hebrew puts the name somewhere
  else. So `pisteLabelBadge` interpolates `SHIELD_SLOT` (`src/utils/text.ts`, a private-use
  codepoint that can never occur in an OSM name) as an ordinary param into `step.piste.badgeName` /
  `badgeOnly`, and `NavOverlay.stepNodes` splits on it. The unquoted `{{name}}` is deliberate: the
  shield already delimits the name, so `step.piste.name`'s quotes would be a second frame. A step
  with **no** slot (a lift, a traverse) falls back to badge-then-text, which is right - inlining a
  gondola glyph mid-sentence adds nothing. **Lifts get the same treatment** (`step.liftUpBadge`
  etc.), and the badge form additionally drops the lift *type*: the glyph already says "lift", and
  "Take "Tapis Roulant Grostè Express - Fortini" (gondola) up" is exactly what forced an ellipsis.
  The type survives in the step list, where the detail belongs.
- **A mapped name is data, so the nav cards shrink or wrap rather than ellipsing it.** The run or
  lift name is the one fact those cards exist to carry, and "Tapis Rou..." fails at that job. The
  banner sizes its type by label length (`bannerFont`, 20/17/15 px) with a 3-line clamp, and the
  "Now" band wraps to two lines. Both keep the card a stable height, which is what the ellipsis was
  really protecting - so protect it that way, not by cutting the name.
- **The map is pinned `dir="ltr"`.** Geography does not mirror — north is up and west is left in
  every language — and `stylis-plugin-rtl` only rewrites *emotion* CSS, so our MUI overlays would
  flip while MapLibre's own controls (its stylesheet) would not, putting them on top of each other.
  The prose drawn over the map (`.pin-hint`, `NavOverlay`, `RoutePreview`) is handed the document
  direction back explicitly with `dir={dir}` in `App.tsx`.
- **Plain CSS needs logical properties.** `src/App.css` is not emotion, so the RTL plugin never sees
  it: use `border-inline-end` / `margin-inline-end`, never `border-right` / `margin-right`. Inside
  MUI `sx` the physical props are fine — the plugin flips those.
- **Measurements are LTR-isolated at the source.** `src/utils/format.ts` wraps every result in
  U+2066…U+2069 when the document is RTL, otherwise the bidi algorithm reorders "5 m – 3 km" against
  the dash. The unit words are **injected** (`setUnitLabels`, called from `LanguageProvider`) rather
  than imported, because these helpers also run under Node in the probes — where the guard on
  `document` also keeps the isolate characters out of probe comparisons.
- **Hebrew has a dual.** `Intl.PluralRules('he')` returns `one` / `two` / `other`, so every counted
  string needs a `_two` variant as well; a missing one is easy to overlook because English never has it.
- **Guarding it:** `npm run probe:badges all` must stay **0 violations / 1834 plans** after anything
  touching labels or ranking. There is no automated catalogue check yet — the useful ad-hoc one
  compares flattened `en.json` vs `he.json` for missing keys, extra keys and `{{param}}` drift.
- **Hebrew is capped at weight 600, and the cap belongs in the CATALOGUE of MUI classes, not on the
  element.** Hebrew has no case, so it carries none of the visual variety that lets a Latin heading
  absorb 700-800 without shouting, and `system-ui` resolves to Segoe UI on Windows whose Hebrew is
  markedly heavier and blockier than its Latin at the same weight. Two mechanisms: `theme.tsx` swaps
  the whole stack to `HEBREW_FONTS` (Arial first - the most neutral face that ships everywhere, so
  no webfont download), and `App.css` caps weight under `:lang(he)`. The cap must list the MUI
  typography classes **including `body1`/`body2`**: it was originally headings-and-captions only, so
  any element setting `fontWeight: 800` through `sx` on a plain Typography slipped straight through
  it, which is how the nav banner's instruction and the remaining-distance line shipped shouting in
  Hebrew. Keyed on `:lang`, not `[dir]`, and `!important` because `sx` is emotion and outranks a
  stylesheet rule. One documented exception, `.num-hero`: an element holding **digits only** carries
  no Hebrew glyphs, so the cap's reason does not apply while the cap would visibly weaken the
  reading the user is navigating by. Use it only where the text can never contain a word.
- **The Hebrew weight rule RAISES as well as caps, so any line left at a lower default renders in two
  different weights.** `App.css`'s `:lang(he)` block is `font-weight: 600 !important` on a list of MUI
  typography classes - stated as a cap, but it is an absolute, so a `.MuiTypography-caption` (MUI
  default **400**) comes out heavier in Hebrew than in English rather than lighter. The nav card's
  remaining/ETA line was exactly this and the user read it as English being "thinner and a bit
  smaller" - Arial's larger x-height compounding the 200-weight gap. The fix is to state 600 on the
  element, which levels English and leaves Hebrew untouched because its own rule already forces that
  value. **Check any Typography under 600 against that class list before assuming both languages
  match.** (`"Grostè (top) · 2496 m"`) are composed
  **by the pipeline** in English, so they stay English in Hebrew. Fixing it means emitting the parts
  structurally (`name` + `side` + `ele`) and composing them in the UI, plus a data rebuild.

## Outstanding follow-ups (not in v1)

### Iconic routes (Sella Ronda clockwise/anti-clockwise, and friends)
A third routing mode beside "A → B" and "longest run": follow a resort's **signposted iconic line**.
Designed, not built. Model it as `waypoints[] + loop: boolean` - a circuit (Sella Ronda) is the
`loop: true` case, and most resorts' iconic line is a point-to-point descent, which is why the
feature is **not** named "circuits". The design decisions that matter:
- **A circuit is DATA, not routing code** — which is what keeps it inside the "never add per-resort
  routing code" rule. Model it as a small ordered **ring of waypoints** (Sella Ronda is literally the
  four passes: Pordoi, Sella, Gardena, Campolongo) and plan each consecutive pair with the **existing**
  `planRoutes`. That inherits closures, `maxDifficulty`, lift-type gating and the off-piste opt-out
  for free, because every leg still goes through `edgeCost`.
- **Anti-clockwise is the same ring reversed**, and joining at a different valley is a **rotation** of
  the ring — so one dataset serves every variant. Note the two directions are **not symmetric** (pistes
  are one-way, so the reverse uses genuinely different terrain) and must be validated independently.
- **Solving A → A directly cannot work** — it returns the trivial empty route. The waypoints are
  precisely what makes the cycle well-posed.
- **Anchor waypoints by COORDINATE, not node id.** Coordinates survive an OSM refresh; ids can move if
  OSM deletes the node a cluster was named after. Resolve to the nearest node at build time and **fail
  a `check:circuits` if the nearest node is beyond a tolerance** — same tripwire discipline as
  `check:overrides`, so a stale circuit is caught at build time and not in the browser.
- **Do NOT auto-detect loops from the graph.** "Iconic" is a signage/cultural fact, not a graph
  property; there are unlimited legal cycles and generating them would be inventing routes nobody
  skis — the routing equivalent of inventing terrain. Only ever add a circuit that is officially
  signposted, and record the `source` in the data file. Auto-detection is legitimate only in *reverse*,
  as a validator that our planned line matches the published one.
- **Known gap: waypoints under-constrain the route.** Between two passes several legal ways exist and
  the planner takes the fastest, which need not be the signposted one. Add an optional `via` hint
  (a named piste/lift) **only** where validation shows divergence — don't pre-emptively over-specify.
- **Report feasibility per leg, honestly.** If the skier's `maxDifficulty` can't do leg 3, say so;
  never silently substitute or drop it. Same discipline as badge reconciliation.
- **The feature that makes it worth building: "latest start time."** A circuit is time-critical and
  resorts publish exactly this warning. `minutesUntilClose()` + per-lift hours already exist, so
  working backwards from each leg's last lift gives *"leave by 13:20 to finish"*. It also yields a free
  correctness check — our estimate vs the published duration (Sella Ronda ≈ 6 h, ~26 km skiing) is a
  natural **`probe:goldenroutes` fixture**.
- Suggested staging: (1) data format + `check:circuits` + Sella Ronda both ways; (2) leg-by-leg
  planning + total time, reusing `RouteOptions`; (3) latest-start-time; (4) more circuits (Portes du
  Soleil tour, Tour du Mont Fort, 3 Vallées traverse).
- Open question deferred: whether a circuit is **fixed** (follow signage, warn when a leg is closed) or
  **adaptive** (reroute around closures, may deviate from signage). Start fixed-with-warnings.

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
