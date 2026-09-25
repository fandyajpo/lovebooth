/**
 * Room identity: human-readable, typo-resistant photobooth codes.
 *
 * Codes are 4 characters drawn from an alphabet with no ambiguous glyphs
 * (0/O, 1/I/L are removed) so a code read off a screen is easy to retype.
 */

// Digits are in the alphabet on purpose: 0/1 are unambiguous, so the
// ambiguous glyphs they collide with (O, I, L) can be folded into them.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

/** 33 ^ 4 ≈ 1.19M combinations — enough to never collide by accident. */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Strips everything a user might paste along with the code. */
export function normalizeRoomCode(input: string): string {
  return (input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .trim();
}

export function isValidRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input);
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** `8F3K` → `8 F 3 K`, for display on the room ticket. */
export function formatRoomCode(code: string): string {
  return code.split('').join(' ');
}
