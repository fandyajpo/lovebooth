/**
 * The final artefact: a 1200 × 1800 vertical photobooth strip, composed
 * entirely in the browser. Nothing is uploaded; both peers can independently
 * rebuild the exact same strip from the frames they already hold.
 */

export const STRIP_WIDTH = 1200;
export const STRIP_HEIGHT = 1800;

/** Aspect the local capture should target so cells paste in without cropping. */
export const STRIP_CELL_WIDTH = 800;
export const STRIP_CELL_HEIGHT = 522;

const PAD = 56;
const HEADER = 136;
const FOOTER = 104;
const GAP = 16;
const MAT = 14;
const BORDER = 3;

const COLORS = {
  paper: '#efe9dd',
  mat: '#fbf9f3',
  ink: '#14120e',
  inkSoft: '#6b655a',
  accent: '#e8380d',
};

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
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatStripDate(date: Date = new Date()): string {
  const day = String(date.getDate()).padStart(2, '0');
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
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

function drawCell(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  frameNumber: number,
): void {
  // paper mat + ink frame
  ctx.fillStyle = COLORS.mat;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  const ix = x + MAT;
  const iy = y + MAT;
  const iw = w - MAT * 2;
  const ih = h - MAT * 2;

  if (image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.drawImage(image, ix, iy, iw, ih);
    ctx.restore();
  } else {
    ctx.fillStyle = '#d9d2c3';
    ctx.fillRect(ix, iy, iw, ih);
  }

  ctx.strokeStyle = 'rgba(20,18,14,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);

  // label chip
  ctx.font = '700 16px "Space Mono", ui-monospace, monospace';
  const padX = 10;
  const chipH = 30;
  const labelW = ctx.measureText(label).width + padX * 2;
  const chipX = ix + 12;
  const chipY = iy + ih - chipH - 12;
  ctx.fillStyle = 'rgba(20,18,14,0.88)';
  ctx.fillRect(chipX, chipY, labelW, chipH);
  ctx.fillStyle = COLORS.paper;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, chipX + padX, chipY + chipH / 2 + 1);

  // frame number
  const num = String(frameNumber).padStart(2, '0');
  const numW = ctx.measureText(num).width + padX * 2;
  const numX = ix + iw - numW - 12;
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(numX, chipY, numW, chipH);
  ctx.fillStyle = '#fff';
  ctx.fillText(num, numX + padX, chipY + chipH / 2 + 1);

  ctx.textBaseline = 'alphabetic';
}

export async function composePhotostrip(config: StripConfig): Promise<HTMLCanvasElement> {
  const width = config.width ?? STRIP_WIDTH;
  const height = config.height ?? STRIP_HEIGHT;
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-unavailable');

  const scaleX = width / STRIP_WIDTH;
  const scaleY = height / STRIP_HEIGHT;

  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, width, height);

  // outer frame
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = BORDER * scaleX;
  const inset = 28 * scaleX;
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);

  // header
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = `${18 * scaleY}px "Space Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const roomLine = config.roomCode
    ? `ROOM ${config.roomCode}  ·  TWO CAMERAS`
    : 'TWO CAMERAS  ·  ONE LITTLE MEMORY';
  drawTrackedText(ctx, roomLine, width / 2, (PAD + 24) * scaleY, 3 * scaleX);

  ctx.fillStyle = COLORS.ink;
  ctx.font = `${76 * scaleY}px "Anton", "Arial Black", sans-serif`;
  drawTrackedText(ctx, config.title ?? 'PHOTOBOOTH', width / 2, (PAD + 118) * scaleY, 1 * scaleX);

  // grid
  const cellW = (STRIP_WIDTH - PAD * 2 - GAP) / 2;
  const rowsAvail = STRIP_HEIGHT - PAD * 2 - HEADER - FOOTER;
  const cellH = (rowsAvail - GAP * 3) / 4;
  const gridTop = PAD + HEADER;
  const gridLeft = PAD;

  const count = Math.max(config.frames.you.length, config.frames.them.length, 1);

  for (let row = 0; row < count; row += 1) {
    const y = gridTop + row * (cellH + GAP);
    for (let col = 0; col < 2; col += 1) {
      const x = gridLeft + col * (cellW + GAP);
      const sources = col === 0 ? config.frames.you : config.frames.them;
      const src = sources[row];
      let image: CanvasImageSource | null = null;
      if (src) {
        try {
          image = await loadImage(src);
        } catch {
          image = null;
        }
      }
      drawCell(
        ctx,
        image,
        x * scaleX,
        y * scaleY,
        cellW * scaleX,
        cellH * scaleY,
        col === 0 ? 'YOU' : 'THEM',
        row + 1,
      );
    }
  }

  // footer
  const footerTop = gridTop + rowsAvail;
  ctx.strokeStyle = 'rgba(20,18,14,0.35)';
  ctx.lineWidth = 1 * scaleX;
  ctx.setLineDash([6 * scaleX, 6 * scaleX]);
  ctx.beginPath();
  ctx.moveTo(PAD * scaleX, (footerTop + 14) * scaleY);
  ctx.lineTo((STRIP_WIDTH - PAD) * scaleX, (footerTop + 14) * scaleY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = `${24 * scaleY}px "Space Mono", ui-monospace, monospace`;
  drawTrackedText(
    ctx,
    config.dateLabel ?? formatStripDate(),
    width / 2,
    (footerTop + 60) * scaleY,
    4 * scaleX,
  );

  ctx.fillStyle = COLORS.accent;
  ctx.font = `${40 * scaleY}px "Anton", "Arial Black", sans-serif`;
  drawTrackedText(ctx, config.tagline ?? 'MAKE A MEMORY', width / 2, (footerTop + 112) * scaleY, 2 * scaleX);

  // paper grain
  const noise = getNoise();
  const pattern = ctx.createPattern(noise, 'repeat');
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.globalCompositeOperation = 'multiply';
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
