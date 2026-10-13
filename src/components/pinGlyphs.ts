/**
 * The A/B marker artwork, in one place.
 *
 * It lives in a plain `.ts` (not `.tsx`) so the panels can import the SVG builders without tripping
 * `react(only-export-components)` - the same reason `navChip.ts` exists.
 *
 * Why these markers look the way they do. They used to be MapLibre's stock teardrop in green and
 * red, which is the generic start/stop convention and is wrong here twice over: green and red are
 * this app's SLOPE DIFFICULTY vocabulary, used in the piste lines, the step-list shields, the nav
 * chip, the legend and the Preferences chips - so on a map covered in green and red lines the two
 * pins were saying "easy run" and "hard run" rather than "start" and "finish" - and red/green is
 * the worst possible pair for colour-blindness, on the one pair a user must tell apart at a glance.
 *
 * So the distinction is PATTERN, not hue: both markers are the same navy drop, and the finish
 * carries a chequered flag while the start is blank. That survives greyscale, glare and
 * colour-blindness, and "chequered flag" is a symbol a skier recognises rather than a colour code
 * they have to learn. Same discipline as casing the polygon spines rather than recolouring them.
 *
 * The silhouette is MapLibre's own default-marker geometry lifted verbatim, so the familiar shape,
 * border and ground shadow are unchanged and THE TIP IS STILL THE ANCHOR - nothing about marker
 * positioning moves.
 */

/** Teardrop body, from maplibre-gl's default marker (27x41 viewBox). */
const BODY_PATH =
  'M27,13.5 C27,19.074644 20.250001,27.000002 14.75,34.500002 C14.016665,35.500004 12.983335,' +
  '35.500004 12.25,34.500002 C6.7499993,27.000002 0,19.222562 0,13.5 C0,6.0441559 6.0441559,0 ' +
  '13.5,0 C20.955844,0 27,6.0441559 27,13.5 Z';

/** The darker inner border maplibre draws over the body, same source. */
const BORDER_PATH =
  'M13.5,0 C6.0441559,0 0,6.0441559 0,13.5 C0,19.222562 6.7499993,27 12.25,34.5 C13,35.522727 ' +
  '14.016664,35.500004 14.75,34.5 C20.250001,27 27,19.074644 27,13.5 C27,6.0441559 20.955844,0 ' +
  '13.5,0 Z M13.5,1 C20.415404,1 26,6.584596 26,13.5 C26,15.898657 24.495584,19.181431 ' +
  '22.220703,22.738281 C19.945823,26.295132 16.705119,30.142167 13.943359,33.908203 ' +
  'C13.743445,34.180814 13.612715,34.322738 13.5,34.441406 C13.387285,34.322738 13.256555,' +
  '34.180814 13.056641,33.908203 C10.284481,30.127985 7.4148684,26.314159 5.015625,22.773438 ' +
  'C2.6163816,19.232715 1,15.953538 1,13.5 C1,6.584596 6.584596,1 13.5,1 Z';

/** Marker navy. The app's nav chrome colour, chosen because every slope hue is already spoken for. */
export const PIN_NAVY = '#16233d';

const PIN_W = 27;
const PIN_H = 41;

/**
 * 4x5 chequers. Finer than is comfortable at this size (~5.4px squares), chosen deliberately: at
 * 2x2 or 2x3 the eye reads "a shape with some squares on it" rather than "a flag", which is the
 * whole point of the change. If it ever softens to grey on a low-DPI screen the remedy is this one
 * pair of numbers, not a redesign.
 */
const CHECK_COLS = 4;
const CHECK_ROWS = 5;

/** maplibre's stacked ground-shadow ellipses, so our markers sit on the map like the stock one. */
function shadowSvg(): string {
  const rx = [10.5, 9.5, 8.5, 7.5, 6.5, 5.5, 4.5];
  return (
    '<g transform="translate(3,29)" fill="#000000">' +
    rx.map((r) => `<ellipse opacity="0.04" cx="10.5" cy="5.8" rx="${r}" ry="${r * 0.5}"/>`).join('') +
    '</g>'
  );
}

/** The dark squares of a chequerboard over the given box. */
function checksSvg(cols: number, rows: number, w: number, h: number, fill: string): string {
  const sw = w / cols;
  const sh = h / rows;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0) continue;
      out.push(`<rect x="${c * sw}" y="${r * sh}" width="${sw}" height="${sh}" fill="${fill}"/>`);
    }
  }
  return out.join('');
}

let clipSeq = 0;

/**
 * The A/B marker as an SVG string.
 *
 * `scale` sizes it against maplibre's native 27x41; the panels render it small and inline, the map
 * draws it at 1. The clip id is uniquified because several of these can be in one document at once
 * and a duplicate id would silently clip the wrong element.
 */
/**
 * The drop shadow is a stack of black ellipses at 4% opacity, so it is invisible on a dark
 * background by construction. That is right on the map, where it lifts the pin off the snow and
 * the tiles never follow the app theme, and wrong in a panel, where it would have to be
 * theme-aware to survive. The inline glyphs therefore pass `shadow: false` and render identically
 * in both themes; at 0.62x it was only ever a few pixels of grey smudge.
 */
export function pinSvg(kind: 'start' | 'finish', scale = 1, shadow = true): string {
  const id = `pinclip${clipSeq++}`;
  const inner =
    kind === 'finish'
      ? `<defs><clipPath id="${id}"><path d="${BODY_PATH}"/></clipPath></defs>` +
        `<g clip-path="url(#${id})">` +
        `<path d="${BODY_PATH}" fill="#ffffff"/>` +
        checksSvg(CHECK_COLS, CHECK_ROWS, PIN_W, 35, PIN_NAVY) +
        '</g>'
      : // Start is the same drop left blank, with maplibre's own white disc in the head.
        `<path d="${BODY_PATH}" fill="${PIN_NAVY}"/>` +
        '<circle cx="13.5" cy="15" r="6" fill="#ffffff"/>';
  // A white halo under the body, so a navy drop still reads on dark ground. It is needed in two
  // places that look unrelated and are the same problem: over satellite imagery on the map, and on
  // the dark-theme panel, where the start pin's navy is the panel's own colour and only its white
  // disc was surviving. Drawn as a stroked copy of the body path rather than a stroke on the body
  // itself, which would be centred and so eat 1px of the artwork.
  const halo =
    `<path d="${BODY_PATH}" fill="#ffffff" stroke="#ffffff" stroke-width="2.4" ` +
    'stroke-linejoin="round"/>';
  // The viewBox gains 2 units of padding on every side so the halo is not clipped at the silhouette
  // edge; width/height grow with it so one SVG unit is still one pixel at scale 1. The offset is
  // unaffected: the box grew 4 units taller, so the centre and the tip both moved down 2.
  return (
    `<svg display="block" width="${(PIN_W + 4) * scale}" height="${(PIN_H + 4) * scale}" ` +
    `viewBox="-2 -2 ${PIN_W + 4} ${PIN_H + 4}">` +
    `<g fill-rule="nonzero">${shadow ? shadowSvg() : ''}${halo}${inner}` +
    `<path d="${BORDER_PATH}" fill="#000000" opacity="0.25"/>` +
    '</g></svg>'
  );
}

/**
 * The same artwork as a DOM element for `maplibregl.Marker({ element })`.
 *
 * Supplying an element means maplibre stops applying the default marker's own offset, so the caller
 * must pass `offset: pinOffset(scale)` or the pin floats half its height above the point.
 *
 * Custom-link endpoints use this too, at `LINK_PIN_SCALE`. They were originally a separate dot
 * marker "deliberately distinct from the nav pins", which was backwards: a from and a to mean the
 * same thing in both places, so two shapes for one concept is a second vocabulary for one fact.
 * They are drawn smaller only so that the two PAIRS stay separable when both are on screen.
 */
export function pinEl(kind: 'start' | 'finish', scale = 1): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'cursor:pointer;line-height:0;';
  el.innerHTML = pinSvg(kind, scale);
  return el;
}

/** Custom-link endpoints, drawn smaller than the route's A and B so the two pairs read apart. */
export const LINK_PIN_SCALE = 0.72;

/**
 * maplibre's own default-marker offset, reused verbatim and scaled.
 *
 * Its source derives -14 from the tip sitting at the centre of the shadow ellipse rather than at
 * the foot of the 41px box; since we reuse that exact geometry we reuse the number with it, instead
 * of re-deriving a second answer to the same question.
 */
export function pinOffset(scale = 1): [number, number] {
  return [0, -14 * scale];
}
