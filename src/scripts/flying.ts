/**
 * The drifting prints behind the landing hero.
 *
 * The slots are server-rendered with a sensible layout, so the pile exists
 * without JavaScript. What this adds: a fresh shuffle every visit (the pile is
 * never parked the same way twice), a per-shot depth, and a small parallax
 * that follows the pointer. Everything is decoration — the container is
 * aria-hidden and pointer-events:none, and reduced-motion visitors get the
 * layout with none of the movement.
 */

interface Slot {
  x: number;
  y: number;
}

/** Wider screens: the headline, the CTAs and the contact sheet all stop
 *  before half the card, so the whole right-hand side belongs to the pile. */
const WIDE: Slot[] = [
  { x: 58, y: 11 },
  { x: 74, y: 7 },
  { x: 85, y: 16 },
  { x: 64, y: 23 },
  { x: 80, y: 28 },
  { x: 96, y: 25 },
  { x: 56, y: 34 },
  { x: 71, y: 40 },
  { x: 88, y: 44 },
  { x: 97, y: 52 },
  { x: 63, y: 49 },
  { x: 77, y: 56 },
  { x: 66, y: 65 },
  { x: 84, y: 74 },
  { x: 58, y: 90 },
];

/** Laptops and tablets: the headline grows, so the pile hugs the right edge
 *  and stays above the contact sheet. */
const MID: Slot[] = [
  { x: 70, y: 10 },
  { x: 86, y: 7 },
  { x: 96, y: 18 },
  { x: 72, y: 26 },
  { x: 88, y: 33 },
  { x: 66, y: 42 },
  { x: 94, y: 50 },
  { x: 76, y: 58 },
  { x: 88, y: 66 },
  { x: 74, y: 74 },
];

/** Phones: every row is full width, so the pile gets a band of its own at
 *  the foot of the hero — a handful of prints lying on the counter. */
const TIGHT: Slot[] = [
  { x: 10, y: 46 },
  { x: 28, y: 42 },
  { x: 47, y: 47 },
  { x: 65, y: 41 },
  { x: 83, y: 46 },
  { x: 96, y: 42 },
];

const rand = (from: number, to: number): number => from + Math.random() * (to - from);

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function place(el: HTMLElement, slot: Slot): void {
  const strip = el.classList.contains('fly__slot--strip');
  el.style.setProperty('--x', `${(slot.x + rand(-2.4, 2.4)).toFixed(1)}%`);
  el.style.setProperty('--y', `${(slot.y + rand(-2.2, 2.2)).toFixed(1)}%`);
  el.style.setProperty('--r', `${rand(-11, 11).toFixed(1)}deg`);
  el.style.setProperty('--w', `${rand(strip ? 134 : 166, strip ? 176 : 230).toFixed(0)}px`);
  el.style.setProperty('--dur', `${rand(6.5, 11.5).toFixed(1)}s`);
  el.style.setProperty('--delay', `${rand(0, 0.85).toFixed(2)}s`);
  const depth = rand(0.3, 1.15);
  el.style.setProperty('--d', depth.toFixed(2));
  el.style.setProperty('--z', String(Math.round(depth * 10)));
  el.classList.toggle('is-far', depth < 0.55);
}

function init(): void {
  const landing = document.querySelector<HTMLElement>('#screen-landing');
  const fly = landing?.querySelector<HTMLElement>('.fly');
  if (!landing || !fly) return;

  const slots = [...fly.querySelectorAll<HTMLElement>('.fly__slot')];
  const phone = window.matchMedia('(max-width: 560px)').matches;
  const laptop = window.matchMedia('(max-width: 899px)').matches;
  const pool = shuffle(phone ? TIGHT : laptop ? MID : WIDE);
  const visible = slots.filter((el) => {
    const view = el.dataset.view;
    if (phone) return view === 'both';
    if (laptop) return view !== 'wide';
    return true;
  });

  visible.forEach((el, i) => place(el, pool[i % pool.length]));

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (still || !pointer) return;

  // The pile leans away from the cursor: each shot moves by its own depth.
  const from = { x: 0, y: 0 };
  const at = { x: 0, y: 0 };
  let frame = 0;

  const tick = (): void => {
    at.x += (from.x - at.x) * 0.08;
    at.y += (from.y - at.y) * 0.08;
    fly.style.setProperty('--px', `${(at.x * 16).toFixed(2)}px`);
    fly.style.setProperty('--py', `${(at.y * 16).toFixed(2)}px`);
    if (Math.abs(from.x - at.x) > 0.001 || Math.abs(from.y - at.y) > 0.001) {
      frame = requestAnimationFrame(tick);
    } else {
      frame = 0;
    }
  };

  landing.addEventListener('pointermove', (event) => {
    const box = landing.getBoundingClientRect();
    from.x = ((event.clientX - box.left) / box.width - 0.5) * 2;
    from.y = ((event.clientY - box.top) / box.height - 0.5) * 2;
    if (!frame) frame = requestAnimationFrame(tick);
  });

  landing.addEventListener('pointerleave', () => {
    from.x = 0;
    from.y = 0;
    if (!frame) frame = requestAnimationFrame(tick);
  });
}

init();
