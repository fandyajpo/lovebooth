/**
 * ICE server discovery.
 *
 * `RTCPeerConnection` needs STUN to see itself and TURN to be reached when the
 * two devices are on networks that won't open a direct path — the common case
 * for two phones on different Wi-Fi networks. TURN credentials are short-lived
 * secrets, so the relay Worker mints them and this module fetches the result
 * over plain HTTPS.
 *
 * A fetch failure is not fatal: we fall back to STUN and let the old direct
 * path do its thing, because a booth that connects without TURN is still a
 * booth that connects. A grant that did arrive is remembered briefly, so
 * reopening the page skips the request entirely.
 */

import { signalingTransportUrl } from './signaling';

const FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const TIMEOUT_MS = 5000;

/**
 * The relay only hands out TURN grants that still carry five minutes of life
 * (it refreshes on a five-minute lead), so a response is good for at least
 * that long — held back by a minute here to cover the trip. Reopening the
 * page within that window costs no request at all.
 */
const CACHE_KEY = 'lovebooth:ice:v1';
const CACHE_MS = 4 * 60 * 1000;

let cached: RTCIceServer[] = FALLBACK;
let resolved = false;
let inflight: Promise<RTCIceServer[]> | null = null;

function readCache(): RTCIceServer[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; servers?: unknown };
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > CACHE_MS) return null;
    if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) return null;
    return parsed.servers as RTCIceServer[];
  } catch {
    return null;
  }
}

function writeCache(servers: RTCIceServer[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), servers }));
  } catch {
    /* storage unavailable — the next visit just pays for /ice again */
  }
}

/** `wss://host/path` and `ws://host/path` both come back as a plain origin. */
function relayOrigin(transportUrl: string | null): string | null {
  if (!transportUrl) return null;
  try {
    return new URL(transportUrl.replace(/^ws/, 'http')).origin;
  } catch {
    return null;
  }
}

export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (resolved) return cached;
  if (inflight) return inflight;

  const origin = relayOrigin(signalingTransportUrl());
  if (!origin) {
    resolved = true;
    return cached;
  }

  const remembered = readCache();
  if (remembered) {
    resolved = true;
    cached = remembered;
    return cached;
  }

  inflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${origin}/ice`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return cached;

      const body = (await res.json()) as { iceServers?: unknown; source?: string };
      const servers = body.iceServers;
      if (Array.isArray(servers) && servers.length > 0) {
        cached = servers as RTCIceServer[];
        resolved = true;
        // Only a real TURN grant earns a slot in storage: pinning the next
        // four minutes to a STUN-only fallback would hide a recovered mint.
        if (body.source === 'cloudflare-turn') writeCache(cached);
      }
      return cached;
    } catch {
      // Keep `resolved` false so a later attempt can still find TURN.
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
