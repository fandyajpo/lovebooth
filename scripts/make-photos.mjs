/**
 * Generates `public/photos/` — the synthetic booth frames and strips that
 * drift behind the landing hero.
 *
 * Nothing here is borrowed: every picture is drawn in a canvas at build time,
 * so the site ships no third-party imagery (the CSP would refuse it anyway).
 * The strips come out of the real `composePhotostrip`, imported from the
 * running dev server, so a flying strip is exactly what the booth prints.
 *
 *   npm run dev            # required: the composer is imported from it
 *   node scripts/make-photos.mjs
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from 'puppeteer-core';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:4321';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(process.cwd(), 'public', 'photos');

const FRAME_W = 400;
const FRAME_H = 261;
const STRIP_W = 360;
const STRIP_H = 540;

/** The frames that fly. Deliberately varied so no two look like twins. */
const FRAMES = [
  { file: 'frame-01', palette: 'paper', pose: 'lean', expr: 'smile', people: 2 },
  { file: 'frame-02', palette: 'night', pose: 'kiss', expr: 'kiss', people: 2 },
  { file: 'frame-03', palette: 'red', pose: 'silly', expr: 'grin', people: 2 },
  { file: 'frame-04', palette: 'flash', pose: 'stack', expr: 'surprise', people: 2 },
  { file: 'frame-05', palette: 'amber', pose: 'apart', expr: 'wink', people: 2 },
  { file: 'frame-06', palette: 'mint', pose: 'peek', expr: 'happy', people: 2 },
  { file: 'frame-07', palette: 'night', pose: 'apart', expr: 'smile', people: 1 },
  { file: 'frame-08', palette: 'paper', pose: 'kiss', expr: 'happy', people: 1 },
  { file: 'frame-09', palette: 'red', pose: 'lean', expr: 'surprise', people: 1 },
  { file: 'frame-10', palette: 'flash', pose: 'apart', expr: 'grin', people: 2 },
  { file: 'frame-11', palette: 'amber', pose: 'kiss', expr: 'kiss', people: 2 },
  { file: 'frame-12', palette: 'mint', pose: 'stack', expr: 'wink', people: 1 },
];

/** Three strips, one per look the booth can print. */
const STRIPS = [
  { file: 'strip-01', style: { template: 'grid', theme: 'paper' }, you: 'paper', them: 'night' },
  { file: 'strip-02', style: { template: 'film', theme: 'noir' }, you: 'flash', them: 'amber' },
  { file: 'strip-03', style: { template: 'hero', theme: 'pop' }, you: 'red', them: 'mint' },
];

/* --------------------------------------------------------------- drawing -- */

/**
 * Runs inside the page: window.__renderFrame draws one canvas portrait,
 * window.__renderRoll returns the eight singles a strip needs.
 */
const DRAW = String.raw`
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKINS = {
  light: { skin: '#4a443a', hair: '#14120e', feature: '#f4efe4', shirtA: '#14120e', shirtB: '#e8380d' },
  dark: { skin: '#e7e0d2', hair: '#14120e', feature: '#14120e', shirtA: '#efe9dd', shirtB: '#e8380d' },
};

const BACKDROPS = {
  paper: { stops: ['#faf7ef', '#e9e1d1'], kind: 'light', glow: 'rgba(255,255,255,0.95)' },
  flash: { stops: ['#ffffff', '#d6ccb9'], kind: 'light', glow: 'rgba(255,255,255,1)' },
  mint: { stops: ['#e6f4ea', '#a8d5b8'], kind: 'light', glow: 'rgba(255,255,255,0.9)' },
  amber: { stops: ['#ffd94f', '#e5a106'], kind: 'light', glow: 'rgba(255,255,255,0.7)' },
  red: { stops: ['#f4552b', '#a92708'], kind: 'light', glow: 'rgba(255,235,225,0.75)' },
  night: { stops: ['#2b2823', '#0c0b09'], kind: 'dark', glow: 'rgba(245,184,0,0.32)' },
};

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The mass behind the head — never crosses the face. */
function hairBack(ctx, style, r, tone) {
  ctx.fillStyle = tone;
  if (style === 'bob' || style === 'wave') {
    const reach = style === 'wave' ? r * 1.8 : r * 1.0;
    ctx.beginPath();
    ctx.moveTo(-r * 1.12, -r * 0.3);
    ctx.quadraticCurveTo(-r * 1.2, r * 0.9, -r * 0.86, reach);
    ctx.lineTo(r * 0.86, reach);
    ctx.quadraticCurveTo(r * 1.2, r * 0.9, r * 1.12, -r * 0.3);
    ctx.quadraticCurveTo(0, -r * 1.5, -r * 1.12, -r * 0.3);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.16, r * 1.1, r * 1.08, 0, 0, Math.PI * 2);
  ctx.fill();
  if (style === 'bun') {
    ctx.beginPath();
    ctx.arc(0, -r * 1.16, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }
  if (style === 'curly') {
    for (let i = -2; i <= 2; i += 1) {
      ctx.beginPath();
      ctx.arc(i * r * 0.46, -r * (0.74 - Math.abs(i) * 0.12), r * 0.36, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Only the fringe is allowed on top of the face; it stops above the eyes. */
function hairFringe(ctx, style, r, tone) {
  ctx.fillStyle = tone;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-r * 1.3, -r * 1.5, r * 2.6, r * 0.8);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.16, r * 1.04, r * 1.02, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function face(ctx, expr, r, feature, accent) {
  const eyeY = -r * 0.14;
  const eyeX = r * 0.4;
  ctx.strokeStyle = feature;
  ctx.fillStyle = feature;
  ctx.lineWidth = Math.max(1.4, r * 0.1);
  ctx.lineCap = 'round';

  const dot = (x) => {
    ctx.beginPath();
    ctx.arc(x, eyeY, r * 0.11, 0, Math.PI * 2);
    ctx.fill();
  };
  const arcEye = (x) => {
    ctx.beginPath();
    ctx.arc(x, eyeY, r * 0.17, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  };
  const openEye = (x) => {
    ctx.beginPath();
    ctx.arc(x, eyeY, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#14120e';
    ctx.beginPath();
    ctx.arc(x + r * 0.04, eyeY + r * 0.02, r * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = feature;
  };

  const mouthY = r * 0.42;
  const smile = () => {
    ctx.beginPath();
    ctx.arc(0, mouthY - r * 0.1, r * 0.3, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();
  };

  switch (expr) {
    case 'happy': {
      arcEye(-eyeX);
      arcEye(eyeX);
      smile();
      break;
    }
    case 'grin': {
      dot(-eyeX);
      dot(eyeX);
      ctx.fillStyle = feature;
      roundedRect(ctx, -r * 0.36, mouthY - r * 0.16, r * 0.72, r * 0.34, r * 0.16);
      ctx.fill();
      ctx.strokeStyle = '#14120e';
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath();
      ctx.moveTo(-r * 0.3, mouthY - r * 0.02);
      ctx.lineTo(r * 0.3, mouthY - r * 0.02);
      ctx.stroke();
      ctx.strokeStyle = feature;
      ctx.lineWidth = Math.max(1.4, r * 0.1);
      break;
    }
    case 'wink': {
      dot(-eyeX);
      arcEye(eyeX);
      smile();
      break;
    }
    case 'kiss': {
      arcEye(-eyeX);
      arcEye(eyeX);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.ellipse(r * 0.08, mouthY, r * 0.17, r * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'surprise': {
      openEye(-eyeX);
      openEye(eyeX);
      ctx.beginPath();
      ctx.ellipse(0, mouthY + r * 0.04, r * 0.16, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      dot(-eyeX);
      dot(eyeX);
      smile();
    }
  }
}

function bust(ctx, o) {
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate((o.tilt * Math.PI) / 180);
  const r = o.r;

  // torso
  ctx.fillStyle = o.shirt;
  ctx.beginPath();
  ctx.moveTo(-r * 2.5, r * 4.2);
  ctx.lineTo(-r * 2.1, r * 1.7);
  ctx.quadraticCurveTo(-r * 1.3, r * 0.95, -r * 0.5, r * 0.86);
  ctx.lineTo(r * 0.5, r * 0.86);
  ctx.quadraticCurveTo(r * 1.3, r * 0.95, r * 2.1, r * 1.7);
  ctx.lineTo(r * 2.5, r * 4.2);
  ctx.closePath();
  ctx.fill();

  // neck
  ctx.fillStyle = o.skin;
  ctx.fillRect(-r * 0.34, r * 0.1, r * 0.68, r * 0.9);

  hairBack(ctx, o.hairStyle, r, o.hair);

  // head
  ctx.fillStyle = o.skin;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.94, r * 1.04, 0, 0, Math.PI * 2);
  ctx.fill();
  // ears
  ctx.beginPath();
  ctx.arc(-r * 0.92, r * 0.1, r * 0.16, 0, Math.PI * 2);
  ctx.arc(r * 0.92, r * 0.1, r * 0.16, 0, Math.PI * 2);
  ctx.fill();

  hairFringe(ctx, o.hairStyle, r, o.hair);
  face(ctx, o.expr, r, o.feature, o.accent);
  ctx.restore();
}

function drawHeart(ctx, x, y, s, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, s * 0.32);
  ctx.bezierCurveTo(-s * 0.1, s * 0.05, -s * 0.5, -s * 0.1, -s * 0.5, -s * 0.34);
  ctx.bezierCurveTo(-s * 0.5, -s * 0.66, -s * 0.14, -s * 0.7, 0, -s * 0.4);
  ctx.bezierCurveTo(s * 0.14, -s * 0.7, s * 0.5, -s * 0.66, s * 0.5, -s * 0.34);
  ctx.bezierCurveTo(s * 0.5, -s * 0.1, s * 0.1, s * 0.05, 0, s * 0.32);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function grain(ctx, w, h, rnd, amount) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function furniture(ctx, w, h, opts) {
  const ink = opts.kind === 'dark' ? 'rgba(242,239,231,0.85)' : 'rgba(20,18,14,0.72)';
  ctx.save();
  ctx.strokeStyle = opts.kind === 'dark' ? 'rgba(242,239,231,0.35)' : 'rgba(20,18,14,0.22)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(7.5, 7.5, w - 15, h - 15);

  ctx.fillStyle = ink;
  ctx.font = '700 9px ui-monospace, "Space Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const text = 'L O V E B O O T H';
  ctx.fillText(text, 16, 24);
  ctx.textAlign = 'right';
  ctx.fillText(opts.date, w - 16, h - 16);

  // frame chip, same idea as the chip on the printed strip
  const chipW = 30;
  const chipH = 16;
  ctx.fillStyle = '#e8380d';
  ctx.fillRect(w - chipW - 15, 15, chipW, chipH);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '700 10px ui-monospace, "Space Mono", monospace';
  ctx.fillText(opts.frame, w - chipW / 2 - 15, 15 + chipH - 5);
  ctx.restore();
}

window.__renderFrame = (opts) => {
  const { w, h, palette, pose, expr, people, seed, frame } = opts;
  const rnd = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const back = BACKDROPS[palette];
  const tone = back.kind === 'dark' ? SKINS.dark : SKINS.light;

  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, back.stops[0]);
  g.addColorStop(1, back.stops[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // the flash, thrown from the middle of the frame
  const glow = ctx.createRadialGradient(w / 2, h * 0.44, 8, w / 2, h * 0.44, h * 0.95);
  glow.addColorStop(0, back.glow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const r = h * (people === 1 ? 0.2 : 0.185);
  const cy = h * 0.46;
  const tiltA = pose === 'lean' || pose === 'kiss' ? 9 : pose === 'stack' ? -6 : rnd() * 6 - 3;
  const tiltB = pose === 'lean' || pose === 'kiss' ? -9 : pose === 'stack' ? 7 : rnd() * 6 - 3;

  const mk = (i) => ({
    x: 0,
    y: cy,
    r,
    tilt: i === 0 ? tiltA : tiltB,
    skin: tone.skin,
    hair: tone.hair,
    feature: tone.feature,
    accent: palette === 'red' ? '#ffe7dc' : '#e8380d',
    shirt: i === 0 ? tone.shirtA : tone.shirtB,
    hairStyle: ['wave', 'short', 'bob', 'curly', 'bun'][(seed + i * 3) % 5],
    expr: i === 0 ? expr : EXPRS_LIST[(seed + 2) % EXPRS_LIST.length],
  });

  if (people === 1) {
    const p = mk(0);
    p.x = w / 2;
    p.expr = expr;
    p.y = cy + r * 0.4;
    bust(ctx, p);
  } else {
    const gap = pose === 'kiss' ? r * 1.5 : pose === 'apart' ? r * 3.4 : r * 1.9;
    const a = mk(0);
    const b = mk(1);
    a.x = w / 2 - gap / 2 + (pose === 'stack' ? -r * 0.5 : 0);
    b.x = w / 2 + gap / 2 + (pose === 'stack' ? r * 0.5 : 0);
    a.y = cy + (pose === 'stack' ? r * 0.7 : 0);
    b.y = cy + (pose === 'stack' ? -r * 0.5 : 0);
    if (pose === 'peek') {
      b.expr = 'surprise';
      a.expr = 'happy';
    }
    if (pose === 'silly') {
      a.expr = 'grin';
      b.expr = 'wink';
    }
    bust(ctx, a);
    bust(ctx, b);

    if (pose === 'kiss') drawHeart(ctx, w / 2, cy - r * 2.1, r * 1.1, tone.feature === '#14120e' ? '#e8380d' : '#e8380d');
    if (pose === 'peek') {
      // two hands held up in front of the lower face
      ctx.fillStyle = tone.skin;
      [-1, 1].forEach((s) => {
        ctx.beginPath();
        ctx.ellipse(b.x + s * r * 0.42, cy + r * 0.62, r * 0.34, r * 0.44, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    if (pose === 'silly') {
      ctx.fillStyle = tone.feature;
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath();
        ctx.arc(w * 0.16 + i * r * 0.5, h * 0.2, r * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // halftone, so the flat shapes read as a printed picture
  ctx.save();
  ctx.fillStyle = back.kind === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(20,18,14,0.055)';
  for (let y = 5; y < h; y += 6) {
    for (let x = (y / 6) % 2 ? 5 : 8; x < w; x += 6) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // vignette
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, back.kind === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(20,18,14,0.3)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  furniture(ctx, w, h, {
    kind: back.kind,
    date: opts.date,
    frame: String(frame).padStart(2, '0'),
  });

  grain(ctx, w, h, rnd, 16);
  return c.toDataURL('image/jpeg', 0.8);
};

const EXPRS_LIST = ['smile', 'happy', 'grin', 'wink', 'kiss', 'surprise'];
`;

/* ------------------------------------------------------------------ main -- */

function b64(url) {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

async function main() {
  try {
    const res = await fetch(ORIGIN);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`make-photos: ${ORIGIN} is not answering — start it with \`npm run dev\`.`);
    process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });
  const browser = await launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: DRAW });
  await page.evaluate(() => document.fonts.ready);

  const date = new Date();
  const stamp = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;

  const frames = await page.evaluate(
    (list, w, h, stamp) =>
      list.map((f, i) =>
        window.__renderFrame({
          w,
          h,
          seed: 1000 + i * 17,
          date: stamp,
          frame: i + 1,
          ...f,
        }),
      ),
    FRAMES,
    FRAME_W,
    FRAME_H,
    stamp,
  );

  const roll = await page.evaluate(
    (palettes, w, h, stamp) =>
      palettes.map((palette, i) =>
        window.__renderFrame({
          w,
          h,
          palette,
          pose: ['lean', 'apart', 'stack', 'kiss'][i % 4],
          expr: ['smile', 'grin', 'happy', 'wink'][i % 4],
          people: 1,
          seed: 500 + i * 31,
          date: stamp,
          frame: i + 1,
        }),
      ),
    ['paper', 'paper', 'paper', 'paper', 'night', 'night', 'night', 'night'],
    800,
    522,
    stamp,
  );

  const strips = await page.evaluate(
    async (specs, frames, w, h) => {
      const mod = await import('/src/lib/photostrip.ts');
      const out = [];
      for (const spec of specs) {
        // The composer lays everything out in 1200 x 1800 space, so it is
        // only correct at that size — downscale the finished sheet instead.
        const full = await mod.composePhotostrip({
          frames: { you: frames.you, them: frames.them },
          roomCode: 'K7QP',
          dateLabel: '27 SEP 2026',
          title: 'PHOTOBOOTH',
          tagline: 'MAKE A MEMORY',
          style: spec.style,
        });
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(full, 0, 0, w, h);
        out.push(canvas.toDataURL('image/jpeg', 0.86));
      }
      return out;
    },
    STRIPS,
    { you: roll.slice(0, 4), them: roll.slice(4, 8) },
    STRIP_W,
    STRIP_H,
  );

  await browser.close();

  const written = [];
  FRAMES.forEach((f, i) => {
    const path = join(OUT, `${f.file}.jpg`);
    writeFileSync(path, b64(frames[i]));
    written.push(path);
  });
  STRIPS.forEach((s, i) => {
    const path = join(OUT, `${s.file}.jpg`);
    writeFileSync(path, b64(strips[i]));
    written.push(path);
  });

  const stale = readdirSync(OUT).filter((name) => !written.some((path) => path.endsWith(name)));
  stale.forEach((name) => {
    unlinkSync(join(OUT, name));
    console.log(`removed ${name}`);
  });

  written.forEach((path) => {
    const kb = Math.round(statSync(path).size / 1024);
    console.log(`wrote ${path.replace(`${process.cwd()}/`, '')} — ${kb} KB`);
  });
}

main().catch((error) => {
  console.error('make-photos:', error);
  process.exit(1);
});
