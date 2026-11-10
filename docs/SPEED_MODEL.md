# Ski speed & time model

How SkiWays turns a route into a **time estimate**, and why there are two different "speeds".
Single source of truth: [`src/config/speedModel.ts`](../src/config/speedModel.ts).

## Progress speed vs. true move speed

Times are computed as `piste_centerline_length ÷ speed`. But a skier never skis the centerline —
they make S-turns, so their real path is **longer** than the centerline, and **steeper runs need
more turns**. So there are two distinct speeds we must never mix up:

| Speed | Definition | Used for |
|---|---|---|
| **Progress speed** | centerline metres advanced ÷ time | **Routing** (`time = length ÷ this`) |
| **True move speed** | real GPS path metres ÷ time | **Display** ("your speed") |

They are bridged by a per-colour **snake factor** = real-path ÷ centerline (≥ 1, bigger for
steeper runs):

```
trueSpeed = progressSpeed × snakeFactor(colour)
```

Everything the **router uses** is a progress speed; everything the **user sees** is a true speed.

## Why progress speed is a hump, not a ramp

Because harder runs are snakier, effective *progress down the fall line* peaks in the middle:

- **Green** – gentle, some pushing on flats → slow.
- **Blue** – the cruising sweet spot → **fastest progress**.
- **Red** – steeper, more turns → a bit less.
- **Black** – lots of snaking + caution → back down, ≈ green (for an average skier).

Base **progress** speeds (average skier, km/h): **green 19, blue 27, red 25, black 20.**

## Skill: pace *and* steep-flattening

Skill has two knobs, not one uniform multiplier:

- **Pace** – overall scaling: cautious 0.85, average 1.0, advanced 1.12, expert 1.22.
- **Steep-lift** – better skiers snake blacks *less*, so their steep penalty flattens; cautious
  skiers snake *more*: cautious −0.25, average 0, advanced +0.35, expert +0.7.

```
progress(colour, skill) = BASE_PROGRESS[colour] × pace(skill) × (1 + steepness(colour) × steepLift(skill))
```

with `steepness` = green 0, blue 0.1, red 0.3, black 0.5. So for an expert, black nearly catches
red; for a cautious skier, black drops well below red.

## Snake factors

`green 1.05, blue 1.15, red 1.30, black 1.45` — global (a property of the terrain, same for
everyone).

## Measured (GPS) speeds

Live navigation records the user's **true** GPS move speed per colour. When the user opts in
(`useMeasuredSpeeds`), each measured true speed is **divided by the snake factor** to get a
progress speed override (`measuredTrueToProgressMps`) that feeds the router; the raw true speed is
what's shown in the "My measured speeds" panel. The measured/estimated columns there are therefore
both **true** speeds (same units).

## Persistence / self-healing

Base per-colour speeds are **never persisted** — they're always derived from the model, so stale
cached values can't get "stuck" in `localStorage`. `SpeedConfig.skiSpeedByColor` is only a
(usually empty) override slot; on load it's cleared unless `useMeasuredSpeeds` is set
(see [`src/state/preferences.ts`](../src/state/preferences.ts)).
