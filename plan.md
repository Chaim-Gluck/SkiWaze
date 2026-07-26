# SkiWaze — Plan & Roadmap

"Waze for ski resorts": route A→B across pistes + lifts, respecting ability, slope-color
preferences, allowed lift types, and lift hours, with realistic time estimates and live
navigation. React + TypeScript + Vite + MapLibre GL over offline-compiled OSM data.
See `AGENTS.md` for architecture, data model, and invariants; `README.md` for usage.

## Status legend
✅ done · 🚧 in progress · ⬜ planned

## Done
- ✅ Core routing (fastest + alternatives) across pistes/lifts with skier-level, preferred
  colors, allowed lift types, closures, opening-hours, and arrive-by timing.
- ✅ Longest-run finder (clean descents; straight-line-progress scoring + internal-uphill
  penalty to avoid doubling-back).
- ✅ Offline data pipeline (OSM/Overpass + elevation → per-resort static graphs), 5 resorts,
  per-resort `overrides/<id>.json` for connectivity fixes (e.g. Monte Vigo plateau).
- ✅ Map UX: base-map switch (Map/Topo/Sat), 3D terrain, pistes/lifts/areas toggles, route
  options with step highlighting, custom links, closures, accordion sidebar.
- ✅ Branding: teardrop-pin ski logo (header lockup + favicon), "Navigate the Slopes" tagline.
- ✅ Skiing-pace selector (Cautious/Average/Advanced/Expert) scaling ski speeds.
- ✅ Repo hygiene: AGENTS.md, MIT LICENSE, OSM/ODbL attribution, secret/history audit,
  git-ignored NOTES.local.md for ops specifics.
- ✅ **Live nav Phase 1** — live location arrow + accuracy circle + follow-me (watchPosition).
- ✅ **Live nav Phase 2** — Start navigation along a selected route: snap-to-route arrow,
  traveled/remaining split, next-step banner, remaining distance/time, current-speed badge,
  off-route re-route, heading-up tilted follow-camera, screen wake-lock, dev GPS simulator.
- ✅ **Measured speeds** — record real GPS speed per piste color while navigating; "Use my
  measured speeds" applies them to the per-color speeds (self-calibration).

## In progress / next
- 🚧 (none active — Phases 1–2 + measured speeds landing)

## Planned / backlog
- ⬜ **Live nav Phase 3 polish:** voice/haptic cues, auto-advance between legs, lift-closing
  "hurry" cues integrated into the nav banner, run recording/history.
- ⬜ **Auto-pick skill level** from measured data (suggest Cautious/Average/Advanced/Expert),
  and per-color confidence over a season (decay old samples).
- ⬜ **Sharing user contributions** (closures + custom links) across users — see AGENTS.md
  follow-ups. Phase 0 share-by-link → Phase 1 admin-published list (Azure SWA auth + roles)
  → Phase 2 crowd-sourced with confirmation-count voting + daily TTL for closures.
- ⬜ Login/accounts; Strava integration for personal average speeds.
- ⬜ Live lift status & queue/wait times; 3D terrain nav; offline/PWA.
- ⬜ A few real-world dead-ends and one legitimate disconnected island remain (documented).

## Conventions & gotchas (quick)
- Validate with `npm run build` (`tsc -b`), not `tsc --noEmit`.
- Add a resort via `RESORTS` + `npm run data <id>` (+ optional override); never per-resort
  routing code. `data:refresh` renumbers node ids — re-check overrides after.
- OSM areas kept in graph, excluded from render lines. Elevation noise on flat plateaus is
  fixed via override flat_traverse connectors, not a blanket auto-connect.
