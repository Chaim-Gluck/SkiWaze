# SkiWays UI & UX Style Guide

The SkiWays UI uses **React + TypeScript (strict) + Vite + Material UI (MUI)** with a shared
light/dark theme. This guide describes the look & feel to keep. It is about **presentation
only** — read §0 first; it overrides everything else here.

## 0. Non-negotiable: do not harm functionality, algorithms, or logic
Visual/UX work is **purely presentational**. When styling, you MUST:
- **Never change** routing/graph/geo/ETA/navigation math, geolocation, state transitions, or
  module public signatures to make something look a certain way. Styling wraps/re-arranges
  existing output; it does not rewrite what produces it.
- **Keep logic in pure modules** (`src/routing`, `src/state`, `src/hooks`, the `pipeline/`).
  Components render and dispatch; they do not contain algorithms.
- Make **surgical, reversible** changes; don't refactor unrelated code "while you're there".
- **Verify behavior is unchanged**: `npm run build` (tsc -b + vite) and `npm run lint` must
  stay green, and routing/nav must behave exactly as before.
- If a visual request seems to require a logic change, **stop and ask**.

## 1. Going forward (convention)
**New or changed UI uses MUI components + the theme tokens, following this guide, whenever
possible** — not ad-hoc CSS. Prefer the theme + `sx` prop over new CSS files/classes.

## 2. What MUI owns vs. what stays CSS
MUI can only style **React DOM**. The map visuals are **MapLibre GL** and are *not* reachable
by MUI — style those with tokenized CSS.
- **MUI ("chrome")**: top `AppBar`, the left controls panel / mobile bottom sheet, the 5
  `Accordion` cards and their contents, Route options, the floating **nav banner** (`Paper`),
  the map **legend** and **layer selector** (`Paper` overlays), and notifications
  (`Snackbar`/`Alert`, `Dialog`).
- **CSS, tokenized** (MapLibre-coupled, drawn on the map): the **location puck**, **nav
  arrow**, **accuracy circle**, on-map **direction arrows**, **route lines**, **piste
  badges/shields**, and **pin hints**. These must read over the *unchanging* map tiles in both
  themes (white borders / shadows / bright accent) — do **not** tie them to the light panel
  colour or they vanish over a light map.

## 3. Theme & tokens
- Single source of truth: `src/theme.tsx` (+ `src/theme-context.ts`). It builds the MUI theme
  **and** mirrors the palette onto CSS variables (`--bg`, `--panel`, `--panel2`, `--text`,
  `--muted`, `--line`, `--accent`, `--primary`, `--glass`) so the map-overlay CSS follows the
  theme. Use `useThemeMode()` for the light/dark toggle (persisted to `localStorage`).
- **Light + dark** both supported. Default is dark. `--glass` is the translucent panel used by
  map overlays so they stay legible over the map.

## 4. Visual language
- **Clean, flat, modern.** Cards are `Paper elevation={0}` + a `1px solid divider` border +
  rounded corners. Reserve elevation/shadow for genuinely floating things (nav banner, map
  overlays, bottom sheet).
- **One accent** (brand blue `primary`) for primary actions; the **orange `--accent`** is the
  route/warm highlight. Slope colours (green/blue/red/black) are **semantic** — keep them, and
  keep black legible (a colour dot + normal text, or a ring, not black-on-dark).
- **Big, glanceable numbers** for what a skier reads at a glance (next distance, ETA, speed).
- **Icons**: MUI icons, consistent, paired with a text label where space allows.

## 5. Layout
- **Map-first.** The map fills the screen; UI floats over/beside it.
- **Desktop/tablet (>820px)**: persistent **left panel** + top `AppBar`.
- **Mobile (≤820px)**: full-screen map + a **bottom sheet** (slide up, drag handle, scroll) for
  the controls — **not** a bottom-navigation bar (SkiWays has one map + contextual tools, not
  3–5 top-level destinations).
- **Feedback**: `Snackbar`/`Alert` for transient messages, `Dialog` for important explainers.
  English only — no i18n/RTL.

## 6. What NOT to do
- ❌ Don't change algorithms/data/behavior for a visual result (§0).
- ❌ Don't add i18n/RTL, or a bottom-nav bar.
- ❌ Don't tie map-drawn overlays to the light panel colour (they disappear over a light map).
- ❌ Don't hide the map behind large opaque panels on mobile — use the bottom sheet.
- ❌ Don't add ad-hoc CSS when an MUI component + `sx` will do.
