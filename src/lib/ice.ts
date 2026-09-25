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
 * booth that connects.
 */

import { signalingTransportUrl } from './signaling';

const FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const TIMEOUT_MS = 5000;

let cached: RTCIceServer[] = FALLBACK;
let resolved = false;
let inflight: Promise<RTCIceServer[]> | null = null;

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

      const body = (await res.json()) as { iceServers?: unknown };
      const servers = body.iceServers;
      if (Array.isArray(servers) && servers.length > 0) {
        cached = servers as RTCIceServer[];
        resolved = true;
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
