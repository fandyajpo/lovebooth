/**
 * What the two of you do while the shutter counts down.
 *
 * The prompt is derived from the countdown's own start instant rather than
 * sent as its own message: `targetAt` already rides the `capture` packet, so
 * after a single press both booths hold the exact same number and reach the
 * same line with nothing new to agree on.
 *
 * The instant is bucketed to half a second because in the rare case that both
 * people press Capture at once each booth starts on its own clock, and the two
 * values would otherwise drift apart by their clock skew — close enough
 * together that one bucket almost always reads the same sentence twice.
 * Frames are seconds apart, so a strip still never repeats itself.
 */

const MISSIONS = [
  'Both look away from the camera',
  'Straight faces — nobody smile',
  'Pretend you just heard gossip',
  'Look at each other, not the camera',
  'Whoever blinks first loses',
  'Biggest grin you have',
  'Act surprised',
  'Both do jazz hands',
  'Cool-guy face, chin up',
  'Look at the camera like it insulted you',
  'Freeze like a statue',
  'Argue silently about nothing',
  'Point at the camera',
  'Do not laugh. Do not.',
  'Pose like a yearbook photo',
  'Both stare at your own hand',
];

function hash(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Same instant, same frame — the same prompt on both screens. */
export function missionFor(targetAt: number, frame: number): string {
  const bucket = Math.round(targetAt / 500);
  return MISSIONS[hash(bucket * 4 + frame) % MISSIONS.length];
}
