# SkiWaze — Plan & Roadmap

"Waze for ski resorts": route A→B across pistes + lifts, respecting ability, slope-color
preferences, allowed lift types, and lift hours, with realistic time estimates and live
navigation. React + TypeScript + Vite + MapLibre GL over offline-compiled OSM data.
See `AGENTS.md` for architecture, data model, invariants and **every pitfall we have hit**;
`README.md` for usage and the add-a-resort runbook.

## Status legend
✅ done · 🚧 in progress · ⬜ planned

## Done

### Routing & planning
- ✅ Core routing (fastest + alternatives) across pistes/lifts with skier-level, preferred
  colors, allowed lift types, closures, opening-hours, and arrive-by timing.
- ✅ Longest-run finder (clean descents; straight-line-progress scoring + internal-uphill
  penalty to avoid doubling-back).
- ✅ **Multi-objective route options** — balanced mode offers one best route per objective
  (fastest / fewest lifts / preferred / longest), ranked by a lexicographic-with-tolerance
  comparator, deduped by real named terrain rather than by which bridge they cross.
- ✅ **Badges that cannot contradict their own numbers** — the promoted objective ties only at
  display resolution, and labels are reconciled against the cards actually shown. Guarded by
  `npm run probe:badges` (0 violations / 1481 plans fleet-wide).
- ✅ **Preference gate applied to the longest-descent search** — it walks the graph directly, so
  it now takes the same `EdgeAllow` predicate as everything else (closures, avoid-bridges, and
  the off-piste opt-out; previously it could return illegal 0-second routes).
- ✅ **Speed model** — routing on progress speed, UI on true move speed, per-type lift speeds
  derived from OSM `aerialway:duration`, published ride times preferred over estimates.
  Documented in `docs/SPEED_MODEL.md`, gated by `npm run probe:goldenroutes` against real
  recorded runs.

### Data pipeline
- ✅ Offline pipeline (OSM/Overpass + elevation → per-resort static graphs) across **15 resorts**,
  with per-resort `pipeline/overrides/<id>.json` for corrections.
- ✅ **Stable node ids** derived from OSM, so `data:refresh` no longer renumbers anything and
  id-based override entries survive a re-sync. (Edge ids are still order-dependent.)
- ✅ **Automatic elevation repair** — a second-DEM consensus pass fixes mis-oriented piste
  segments and mis-seated "ski sink" nodes, replacing the bulk of hand-written
  `setNodeElevation` work.
- ✅ **Polygon spines** — `area=yes` bowls routed via synthesised interior centrelines with
  gateways, arms and stitching, instead of their rims.
- ✅ **Trapped-basin detector + human sign-off** (`check:basins` / `acceptedBasins`), including
  escapes aimed at points *along* a run rather than only its endpoints. Fleet now reports
  **0 unexplained basins**, with every genuine island signed off with its evidence.
- ✅ **Hand-fixed defects generalised into build-time rules** — coincident-but-unshared OSM
  junctions, non-passenger aerialways and station outline polygons, private hiking tracks,
  bbox spill, off-piste/freeride flagging, funicular & rack railways, and `conveying`
  escalators/moving walkways imported as `people_mover` lifts.
- ✅ **One-command acceptance gate** — `npm run check:resort <id>` runs the whole battery and
  prints a single ok/REVIEW/FAIL table, plus a suite of report-only `probe:*` diagnostics.

### App & UX
- ✅ Map UX: base-map switch (Map/Topo/Sat), 3D terrain, pistes/lifts/areas toggles, route
  options with step highlighting, custom links, closures, accordion sidebar.
- ✅ MUI + shared light/dark theme; mobile bottom sheet (see `docs/STYLE_GUIDE.md`).
- ✅ **Global vs resort view as an explicit mode** — country-flag markers when zoomed out, with
  a camera guard and a single owner per layer.
- ✅ Resort picker with grouped country headers; assumed-open status notice once per resort
  per day, linking to the resort's official info page.
- ✅ Branding: teardrop-pin ski logo (header lockup + favicon), "Navigate the Slopes" tagline.
- ✅ Skiing-pace selector (Cautious/Average/Advanced/Expert) scaling ski speeds.
- ✅ **Live nav Phase 1** — live location arrow + accuracy circle + follow-me (watchPosition).
- ✅ **Live nav Phase 2** — Start navigation along a selected route: snap-to-route arrow,
  traveled/remaining split, next-step banner, remaining distance/time, current-speed badge,
  off-route re-route, heading-up tilted follow-camera, screen wake-lock, dev GPS simulator.
- ✅ **Measured speeds** — record real GPS speed per piste color while navigating; "Use my
  measured speeds" applies them to the per-color speeds (self-calibration).
- ✅ Debug map (`/devtools/mapdebug.html`): overlays, flow arrows, area fills, node finder and
  a review list for eyeballing candidates.
- ✅ Repo hygiene: AGENTS.md, MIT LICENSE, OSM/ODbL attribution, secret/history audit,
  git-ignored NOTES.local.md for ops specifics.

## In progress / next
- 🚧 (none active)

## Planned / backlog
- ⬜ **Live nav Phase 3 polish:** voice/haptic cues, auto-advance between legs, lift-closing
  "hurry" cues integrated into the nav banner, run recording/history.
- ⬜ **Auto-pick skill level** from measured data (suggest Cautious/Average/Advanced/Expert),
  and per-color confidence over a season (decay old samples).
- ⬜ **Sharing user contributions** (closures + custom links) across users — see AGENTS.md
  follow-ups. Phase 0 share-by-link → Phase 1 admin-published list (Azure SWA auth + roles)
  → Phase 2 crowd-sourced with confirmation-count voting + daily TTL for closures.
- ⬜ **Live lift status & queue/wait times** — research done (no universal free API; scrape
  server-side via a scheduled job into `status.json`); build the adapters closer to the season.
- ⬜ Login/accounts; Strava integration for personal average speeds.
- ⬜ Offline/PWA; 3D terrain during navigation.
- ⬜ Debug-map research aids: OpenSnowMap base layer + skimap.org deep link.
- ⬜ Some resorts keep real-world dead-ends and genuinely disconnected satellite areas —
  measured: **9 dead-ends + 9 islands across 7 of 15 resorts**, the largest being Zermatt's
  329-node Balmbrunnen and Sella Ronda's 175-node Alpe di Siusi. These are **reviewed and
  signed off** in `acceptedBasins`, not defects — never bridge one to make a number go down.

## Conventions & gotchas (quick)
Full detail lives in `AGENTS.md`; these are the ones that bite most often.
- Validate with `npm run build` (`tsc -b`), not `tsc --noEmit`.
- Add a resort via `RESORTS` + `npm run data <id>` (+ optional override); **never per-resort
  routing code**. If a future resort could hit the same defect, make it a build-time rule.
- Node ids are **stable** across `data:refresh`; run `npm run check:overrides` anyway, since an
  id changes if OSM deletes the exact node a cluster was named after.
- The OSM cache is keyed by **resort id — not the bbox and not the query text**. After changing
  either, `data:refresh` is mandatory or you keep serving the old fetch.
- Stop the Vite dev server before any `npm run data*` (its watcher on `public/` breaks writes).
- OSM areas are kept in the graph, excluded from render lines, and routed via interior spines.
- Never invent terrain: a link goes in only with real evidence, never to silence a check.
