// Canvas-drawn country flags, used both as MapLibre marker icons (ImageData) and as small
// picker chips (data URL). Emoji flags are avoided on purpose: Windows renders them as letter
// pairs and MapLibre can't draw emoji at all, so we paint the flags ourselves for a consistent,
// correct look everywhere. Only the countries SkiWaze currently covers are implemented.

const COUNTRY_CODE: Record<string, string> = {
  Austria: 'AT',
  France: 'FR',
  Italy: 'IT',
  Switzerland: 'CH',
  Israel: 'IL',
  Georgia: 'GE',
};

/** Country codes we ship a flag for (plus '' as a neutral fallback). */
export const FLAG_CODES = ['AT', 'FR', 'IT', 'CH', 'IL', 'GE', ''] as const;

/** Map a single-country name to its 2-letter code (first country if a multi-country string). */
export function countryCode(country: string): string {
  return COUNTRY_CODE[country.split('/')[0].trim()] ?? '';
}

/** Flag key for a resort: a single code (e.g. 'AT') or a hyphen-joined pair for cross-border
 * resorts (e.g. 'IT-CH'), which renders as a diagonally split flag. */
export function resortFlagCode(country: string): string {
  return country
    .split('/')
    .map((c) => COUNTRY_CODE[c.trim()] ?? '')
    .filter(Boolean)
    .join('-');
}

const BASE_W = 30;
const BASE_H = 20;
const PAIR_GAP = 3;

function strokeTriangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot: number): void {
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = rot + (i * 2 * Math.PI) / 3;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

function smallCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, t: number): void {
  ctx.fillRect(cx - t / 2, cy - s / 2, t, s);
  ctx.fillRect(cx - s / 2, cy - t / 2, s, t);
}

function paint(ctx: CanvasRenderingContext2D, code: string, w: number, h: number): void {
  const third = w / 3;
  switch (code) {
    case 'AT': // red / white / red, horizontal
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, h / 3, w, h / 3);
      break;
    case 'FR': // blue / white / red, vertical
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#002395';
      ctx.fillRect(0, 0, third, h);
      ctx.fillStyle = '#ed2939';
      ctx.fillRect(2 * third, 0, third, h);
      break;
    case 'IT': // green / white / red, vertical
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#008c45';
      ctx.fillRect(0, 0, third, h);
      ctx.fillStyle = '#cd212a';
      ctx.fillRect(2 * third, 0, third, h);
      break;
    case 'CH': { // red with white cross
      ctx.fillStyle = '#d52b1e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      const t = Math.min(w, h) * 0.2;
      const a = Math.min(w, h) * 0.34;
      const cx = w / 2;
      const cy = h / 2;
      ctx.fillRect(cx - t / 2, cy - a, t, a * 2);
      ctx.fillRect(cx - a, cy - t / 2, a * 2, t);
      break;
    }
    case 'IL': { // white with two blue stripes + Star of David
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0038b8';
      const sh = h * 0.13;
      ctx.fillRect(0, h * 0.17, w, sh);
      ctx.fillRect(0, h * 0.7, w, sh);
      ctx.strokeStyle = '#0038b8';
      ctx.lineWidth = Math.max(0.8, h * 0.045);
      const r = h * 0.2;
      strokeTriangle(ctx, w / 2, h / 2, r, -Math.PI / 2);
      strokeTriangle(ctx, w / 2, h / 2, r, Math.PI / 2);
      break;
    }
    case 'GE': { // white with red St George cross + four Bolnisi crosses
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff0000';
      const t = Math.min(w, h) * 0.16;
      ctx.fillRect(w / 2 - t / 2, 0, t, h);
      ctx.fillRect(0, h / 2 - t / 2, w, t);
      const s = Math.min(w, h) * 0.13;
      const ct = s * 0.42;
      for (const [qx, qy] of [
        [w * 0.25, h * 0.25],
        [w * 0.75, h * 0.25],
        [w * 0.25, h * 0.75],
        [w * 0.75, h * 0.75],
      ] as const) {
        smallCross(ctx, qx, qy, s, ct);
      }
      break;
    }
    default:
      ctx.fillStyle = '#90a4ae';
      ctx.fillRect(0, 0, w, h);
  }
}

/** Draw one bordered rectangular flag at the given x offset in an already-scaled context. */
function drawOneFlag(ctx: CanvasRenderingContext2D, code: string, x: number): void {
  ctx.save();
  ctx.translate(x, 0);
  paint(ctx, code, BASE_W, BASE_H);
  // Thin dark border so light flags read against the map/menu.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, BASE_W - 1, BASE_H - 1);
  ctx.restore();
}

/** Rectangular flag canvas (single, or side-by-side for a pair). Used for DOM chips (picker). */
function makeRectCanvas(code: string, px: number): HTMLCanvasElement {
  const codes = code ? code.split('-') : [''];
  const totalW = codes.length * BASE_W + (codes.length - 1) * PAIR_GAP;
  const c = document.createElement('canvas');
  c.width = totalW * px;
  c.height = BASE_H * px;
  const ctx = c.getContext('2d')!;
  ctx.scale(px, px);
  codes.forEach((cd, i) => drawOneFlag(ctx, cd, i * (BASE_W + PAIR_GAP)));
  return c;
}

const ROUNDEL_R = 11;

/** Draw a circular flag "roundel" badge (flag clipped to a circle + white ring), sports-broadcast
 * style. The flag is painted square so it fills the circle (the Swiss flag is officially square). */
function drawRoundel(ctx: CanvasRenderingContext2D, code: string, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.translate(cx - r, cy - r);
  paint(ctx, code, 2 * r, 2 * r);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 0.7, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

/** Circular-badge flag canvas for map markers: one roundel for a single country, two overlapping
 * roundels for a cross-border resort (the first country's badge sits on top). */
function makeRoundelCanvas(code: string, px: number): HTMLCanvasElement {
  const codes = code ? code.split('-') : [''];
  const r = ROUNDEL_R;
  const pad = 1.5;
  const step = 2 * r * 0.72; // overlap the badges of a pair
  const totalW = 2 * r + (codes.length - 1) * step + pad * 2;
  const totalH = 2 * r + pad * 2;
  const c = document.createElement('canvas');
  c.width = totalW * px;
  c.height = totalH * px;
  const ctx = c.getContext('2d')!;
  ctx.scale(px, px);
  // Draw right-to-left so the first (left) badge ends up on top.
  for (let i = codes.length - 1; i >= 0; i--) {
    drawRoundel(ctx, codes[i], pad + r + i * step, pad + r, r);
  }
  return c;
}

/** Flag as ImageData for MapLibre `addImage` — a circular badge (2× for crispness). */
export function flagImageData(code: string): ImageData {
  const c = makeRoundelCanvas(code, 2);
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

/** Flag as a PNG data URL for a rectangular <img> chip in the DOM (e.g. the picker headers). */
export function flagDataUrl(code: string): string {
  return makeRectCanvas(code, 2).toDataURL('image/png');
}
