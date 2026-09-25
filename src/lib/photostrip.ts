/**
 * The final artefact: a 1200 × 1800 vertical photobooth strip, composed
 * entirely in the browser. Nothing is uploaded; both peers can independently
 * rebuild the exact same strip from the frames they already hold.
 *
 * Two knobs change the result: a template (where the photos sit) and a theme
 * (which palette paints them). See `src/lib/style.ts`.
 */

import { getTheme, type StripStyle, type ThemePalette, type TemplateId } from './style';

export const STRIP_WIDTH = 1200;
export const STRIP_HEIGHT = 1800;

/** Aspect the local capture should target so cells paste in without cropping. */
export const STRIP_CELL_WIDTH = 800;
export const STRIP_CELL_HEIGHT = 522;

const PAD = 56;
const FOOTER = 104;
const GAP = 16;
const BORDER = 3;
/** Total photo rows every template is planned around. */
const ROWS = 4;

export interface StripFrames {
  /** Data URLs, object URLs or blob URLs — whatever decodes into an image. */
  you: string[];
  them: string[];
}

export interface StripConfig {
  frames: StripFrames;
  roomCode?: string | null;
  dateLabel?: string;
  title?: string;
  tagline?: string;
  caption?: string;
  width?: number;
  height?: number;
  style?: Partial<StripStyle>;
}

/** One drawn photo. Coordinates are in 1200 × 1800 space. */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  src: 'you' | 'them';
  label: string;
  frameNo: number;
  /** Mount board thickness around the photo; `film` uses 0. */
  mat: number;
  /** Thin outer stroke on the cell. */
  stroke?: boolean;
}

interface TemplateGeometry {
  header: number;
  titleSize: number;
  sprockets: boolean;
}

const GEOMETRY: Record<TemplateId, TemplateGeometry> = {
  grid: { header: 136, titleSize: 76, sprockets: false },
  film: { header: 92, titleSize: 44, sprockets: true },
  hero: { header: 136, titleSize: 76, sprockets: false },
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatStripDate(date: Date = new Date()): string {
  const day = String(date.getDate()).padStart(2, '0');
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Adds a rounded rect to the current path — `roundRect` is missing pre-Safari 16. */
function pathRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function loadImage(src: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image-decode-failed'));
    img.src = src;
  });
}

let noisePattern: HTMLCanvasElement | null = null;

function getNoise(): HTMLCanvasElement {
  if (noisePattern) return noisePattern;
  const size = 180;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = 120 + Math.random() * 135;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }
  noisePattern = canvas;
  return canvas;
}

async function ensureFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  try {
    await Promise.all([
      document.fonts.load('400 76px "Anton"'),
      document.fonts.load('700 76px "Anton"'),
      document.fonts.load('400 18px "Space Mono"'),
      document.fonts.load('700 18px "Space Mono"'),
      document.fonts.ready,
    ]);
  } catch {
    /* system fallbacks are fine */
  }
}

function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: CanvasTextAlign = 'center',
): void {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + tracking * (chars.length - 1);
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cursor, y);
    cursor += widths[i] + tracking;
  });
  ctx.textAlign = previousAlign;
}

/* --------------------------------------------------------------- layouts -- */

function planGrid(count: number): Cell[] {
  const cellW = (STRIP_WIDTH - PAD * 2 - GAP) / 2;
  const rowsAvail = STRIP_HEIGHT - PAD * 2 - GEOMETRY.grid.header - FOOTER;
  const cellH = (rowsAvail - GAP * (ROWS - 1)) / ROWS;
  const top = PAD + GEOMETRY.grid.header;
  const cells: Cell[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      cells.push({
        x: PAD + col * (cellW + GAP),
        y: top + row * (cellH + GAP),
        w: cellW,
        h: cellH,
        src: col === 0 ? 'you' : 'them',
        label: col === 0 ? 'YOU' : 'THEM',
        frameNo: row + 1,
        mat: 14,
      });
    }
  }
  return cells;
}

function planFilm(count: number): Cell[] {
  const geo = GEOMETRY.film;
  const rail = 28;
  const left = PAD + rail;
  const width = STRIP_WIDTH - PAD * 2 - rail * 2;
  const cellW = width / 2;
  const rowsAvail = STRIP_HEIGHT - PAD * 2 - geo.header - FOOTER;
  const cellH = rowsAvail / ROWS;
  const top = PAD + geo.header;
  const cells: Cell[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      cells.push({
        x: left + col * cellW,
        y: top + row * cellH,
        w: cellW,
        h: cellH,
        src: col === 0 ? 'you' : 'them',
        label: col === 0 ? 'YOU' : 'THEM',
        frameNo: row + 1,
        mat: 0,
      });
    }
  }
  return cells;
}

function planHero(count: number): Cell[] {
  const cellW = (STRIP_WIDTH - PAD * 2 - GAP) / 2;
  const rowsAvail = STRIP_HEIGHT - PAD * 2 - GEOMETRY.hero.header - FOOTER;
  const heroH = 700;
  const smallH = (rowsAvail - heroH - GAP * (ROWS - 1)) / (ROWS - 1);
  const top = PAD + GEOMETRY.hero.header;
  const cells: Cell[] = [];

  const heroIndex = count - 1;
  if (heroIndex >= 0) {
    for (let col = 0; col < 2; col += 1) {
      cells.push({
        x: PAD + col * (cellW + GAP),
        y: top,
        w: cellW,
        h: heroH,
        src: col === 0 ? 'you' : 'them',
        label: col === 0 ? 'YOU' : 'THEM',
        frameNo: heroIndex + 1,
        mat: 14,
      });
    }
  }

  for (let row = 0; row < ROWS - 1; row += 1) {
    if (row > heroIndex - 1) break;
    const y = top + heroH + GAP + row * (smallH + GAP);
    for (let col = 0; col < 2; col += 1) {
      cells.push({
        x: PAD + col * (cellW + GAP),
        y,
        w: cellW,
        h: smallH,
        src: col === 0 ? 'you' : 'them',
        label: col === 0 ? 'YOU' : 'THEM',
        frameNo: row + 1,
        mat: 14,
      });
    }
  }
  return cells;
}

function planLayout(template: TemplateId, count: number): Cell[] {
  if (template === 'film') return planFilm(count);
  if (template === 'hero') return planHero(count);
  return planGrid(count);
}

/* ----------------------------------------------------------------- paint -- */

function drawCell(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  cell: Cell,
  palette: ThemePalette,
): void {
  const { x, y, w, h, mat } = cell;

  if (mat > 0) {
    ctx.fillStyle = palette.mat;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  const ix = x + mat;
  const iy = y + mat;
  const iw = w - mat * 2;
  const ih = h - mat * 2;

  if (image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.drawImage(image, ix, iy, iw, ih);
    ctx.restore();
  } else {
    ctx.fillStyle = palette.placeholder;
    ctx.fillRect(ix, iy, iw, ih);
  }

  if (cell.stroke !== false) {
    ctx.strokeStyle = withAlpha(palette.ink, 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
  }

  // label chip
  ctx.font = '700 16px "Space Mono", ui-monospace, monospace';
  const padX = 10;
  const chipH = 30;
  const labelW = ctx.measureText(cell.label).width + padX * 2;
  const chipX = ix + 12;
  const chipY = iy + ih - chipH - 12;
  ctx.fillStyle = withAlpha(palette.ink, 0.88);
  ctx.fillRect(chipX, chipY, labelW, chipH);
  ctx.fillStyle = palette.paper;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(cell.label, chipX + padX, chipY + chipH / 2 + 1);

  // frame number
  const num = String(cell.frameNo).padStart(2, '0');
  const numW = ctx.measureText(num).width + padX * 2;
  const numX = ix + iw - numW - 12;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(numX, chipY, numW, chipH);
  ctx.fillStyle = palette.onAccent;
  ctx.fillText(num, numX + padX, chipY + chipH / 2 + 1);

  ctx.textBaseline = 'alphabetic';
}

function drawSprockets(
  ctx: CanvasRenderingContext2D,
  palette: ThemePalette,
  top: number,
  height: number,
  rail: number,
  scaleX: number,
  scaleY: number,
): void {
  const holeW = 14 * scaleX;
  const holeH = 20 * scaleY;
  const step = 40 * scaleY;
  const dy = (step - holeH) / 2;
  ctx.fillStyle = palette.ink;
  [PAD, STRIP_WIDTH - PAD - rail].forEach((left) => {
    const x = left * scaleX;
    for (let y = top * scaleY + dy; y < (top + height) * scaleY - holeH; y += step) {
      ctx.beginPath();
      const r = 4 * scaleX;
      pathRoundedRect(ctx, x + 7 * scaleX, y, holeW, holeH, r);
      ctx.fill();
    }
  });
}

/* --------------------------------------------------------------- compose -- */

export async function composePhotostrip(config: StripConfig): Promise<HTMLCanvasElement> {
  const width = config.width ?? STRIP_WIDTH;
  const height = config.height ?? STRIP_HEIGHT;
  const style: StripStyle = {
    template: config.style?.template ?? 'grid',
    theme: config.style?.theme ?? 'paper',
  };
  const palette = getTheme(style.theme);
  const geo = GEOMETRY[style.template];
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-unavailable');

  const scaleX = width / STRIP_WIDTH;
  const scaleY = height / STRIP_HEIGHT;

  ctx.fillStyle = palette.paper;
  ctx.fillRect(0, 0, width, height);

  // outer frame
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = BORDER * scaleX;
  const inset = 28 * scaleX;
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);

  // header
  ctx.fillStyle = palette.inkSoft;
  ctx.font = `${18 * scaleY}px "Space Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const roomLine = config.roomCode
    ? `ROOM ${config.roomCode}  ·  TWO CAMERAS`
    : 'TWO CAMERAS  ·  ONE LITTLE MEMORY';
  drawTrackedText(ctx, roomLine, width / 2, (PAD + 24) * scaleY, 3 * scaleX);

  ctx.fillStyle = palette.ink;
  ctx.font = `${geo.titleSize * scaleY}px "Anton", "Arial Black", sans-serif`;
  const titleY = PAD + (geo.header === 136 ? 118 : 74);
  drawTrackedText(ctx, config.title ?? 'PHOTOBOOTH', width / 2, titleY * scaleY, 1 * scaleX);

  // grid
  const count = Math.min(
    Math.max(config.frames.you.length, config.frames.them.length, 1),
    ROWS,
  );
  const gridTop = PAD + geo.header;
  const rowsAvail = STRIP_HEIGHT - PAD * 2 - geo.header - FOOTER;
  const cells = planLayout(style.template, count);

  for (const cell of cells) {
    const sources = cell.src === 'you' ? config.frames.you : config.frames.them;
    const src = sources[cell.frameNo - 1];
    let image: CanvasImageSource | null = null;
    if (src) {
      try {
        image = await loadImage(src);
      } catch {
        image = null;
      }
    }
    drawCell(ctx, image, cell, palette);
  }

  if (geo.sprockets) {
    drawSprockets(ctx, palette, gridTop, rowsAvail, 28, scaleX, scaleY);
  }

  // footer
  const footerTop = gridTop + rowsAvail;
  ctx.strokeStyle = withAlpha(palette.ink, 0.35);
  ctx.lineWidth = 1 * scaleX;
  ctx.setLineDash([6 * scaleX, 6 * scaleX]);
  ctx.beginPath();
  ctx.moveTo(PAD * scaleX, (footerTop + 14) * scaleY);
  ctx.lineTo((STRIP_WIDTH - PAD) * scaleX, (footerTop + 14) * scaleY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = palette.inkSoft;
  ctx.font = `${24 * scaleY}px "Space Mono", ui-monospace, monospace`;
  drawTrackedText(
    ctx,
    config.dateLabel ?? formatStripDate(),
    width / 2,
    (footerTop + 60) * scaleY,
    4 * scaleX,
  );

  ctx.fillStyle = palette.accent;
  ctx.font = `${40 * scaleY}px "Anton", "Arial Black", sans-serif`;
  drawTrackedText(ctx, config.tagline ?? 'MAKE A MEMORY', width / 2, (footerTop + 112) * scaleY, 2 * scaleX);

  // paper grain
  const noise = getNoise();
  const pattern = ctx.createPattern(noise, 'repeat');
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.globalCompositeOperation = palette.grain;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  return canvas;
}

export async function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality = 0.94): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode-failed'))),
      type,
      quality,
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
