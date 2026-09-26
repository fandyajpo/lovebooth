/**
 * A tiny WebAudio shutter: filtered noise burst plus a mechanical click.
 * Created lazily after a user gesture so nothing ever autoplays.
 */

let context: AudioContext | null = null;
let muted = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === 'suspended') void context.resume();
  return context;
}

export function primeAudio(): void {
  getAudioContext();
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
}

export function toggleMuted(): boolean {
  muted = !muted;
  return muted;
}

function noiseBurst(
  ctx: AudioContext,
  duration: number,
  gainValue: number,
  filterHz: number,
  when: number,
): void {
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    const envelope = 1 - i / frames;
    data[i] = (Math.random() * 2 - 1) * envelope;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterHz;
  filter.Q.value = 0.9;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainValue, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(when);
  source.stop(when + duration);
}

export function playShutter(): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  noiseBurst(ctx, 0.05, 0.22, 2400, now);
  noiseBurst(ctx, 0.11, 0.14, 900, now + 0.035);

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(180, now + 0.03);
  osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
  gain.gain.setValueAtTime(0.06, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now + 0.03);
  osc.stop(now + 0.16);
}

export function playTick(): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.05, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

export function playChime(): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const at = now + i * 0.09;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}

/**
 * The little thermal printer feeding the strip out. Noise chopped into paper
 * rides over a low motor hum; the returned function fades it out early, which
 * is how the chime takes over the moment the strip is actually ready.
 */
export function playPrinter(duration = 2.4): () => void {
  const stop = () => undefined;
  if (muted) return stop;
  const ctx = getAudioContext();
  if (!ctx) return stop;

  const now = ctx.currentTime;
  // ~7 paper rides per second, baked into the buffer so no LFO is needed.
  const cycle = Math.floor(ctx.sampleRate * 0.14);
  const buffer = ctx.createBuffer(1, cycle, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < cycle; i += 1) {
    const feed = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * (i / cycle) * 7));
    data[i] = (Math.random() * 2 - 1) * feed;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1500;
  filter.Q.value = 0.8;

  const hum = ctx.createOscillator();
  hum.type = 'triangle';
  hum.frequency.value = 132;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.35;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.06);
  gain.gain.setValueAtTime(0.12, now + Math.max(0.2, duration - 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter).connect(gain);
  hum.connect(humGain).connect(gain);
  gain.connect(ctx.destination);

  source.start(now);
  hum.start(now);
  source.stop(now + duration);
  hum.stop(now + duration);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      const at = ctx.currentTime;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0.0001, at, 0.08);
      source.stop(at + 0.3);
      hum.stop(at + 0.3);
    } catch {
      /* already finished */
    }
  };
}
