/**
 * lovebooth signaling relay — Cloudflare Worker + Durable Object.
 *
 * The booth itself stays a static site. This is the one piece that has to live
 * on the internet: WebRTC needs somewhere for two devices to be introduced
 * before the peer connection takes over. It moves presence and SDP/ICE
 * payloads only — no photos, no accounts, no storage of any kind.
 *
 * Protocol is a handful of JSON frames; the client in `src/lib/signaling.ts`
 * only ever sees `SignalingClient`, so adding a transport never touches the UI:
 *
 *   in : { t: 'create', room }        out: { t: 'welcome', selfId }
 *        { t: 'join',   room }             { t: 'created', room, role }
 *        { t: 'signal', room, data }       { t: 'joined', room, role, peers }
 *        { t: 'leave' }                    { t: 'peer-joined' | 'peer-left', peerId }
 *                                          { t: 'signal', from, data }
 *                                          { t: 'error', code }
 *
 * Every socket carries its own room membership in `serializeAttachment`, so a
 * hibernating Durable Object wakes with its state intact instead of losing the
 * room. The index is rebuilt from live sockets on every message.
 *
 * The Worker also serves `GET /ice`, which hands the browser its ICE servers
 * with short-lived TURN credentials minted from TURN_KEY_ID/TURN_API_TOKEN —
 * both stored as Worker secrets, neither ever shipped to the page.
 *
 *   npx wrangler dev --port 8787     # local
 *   npx wrangler deploy              # production
 *   npx wrangler secret put TURN_KEY_ID
 *   npx wrangler secret put TURN_API_TOKEN
 */

const MAX_MEMBERS = 2;

/* ----------------------------------------------------------------- ice ---- */
/**
 * ICE servers are the other half of "can two phones actually talk". A relay
 * only helps if both ends can punch through, and for two devices on different
 * home networks that usually needs a TURN server — otherwise the booth pairs,
 * the signaling works, and the video pane stays black forever.
 *
 * Cloudflare Realtime TURN mints short-lived credentials from a TURN key, and
 * that key must never reach the browser. So the browser asks this Worker
 * instead, and the Worker keeps the secret. Without TURN_KEY_ID/TURN_API_TOKEN
 * configured we still answer — with STUN only — so a missing secret degrades to
 * the old behaviour rather than breaking the booth.
 *
 *   curl https://rtc.live.cloudflare.com/v1/turn/keys/$KEY/credentials/generate-ice-servers \
 *     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 *     -d '{"ttl": 3600}'
 */
const ICE_TTL_SECONDS = 3600;
const ICE_REFRESH_LEAD_MS = 5 * 60 * 1000;
const STUN_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }];

let iceCache = null;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

/** Browsers never get to port 53, so a URL with it only costs a timeout. */
function usableIceServers(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const server of list) {
    if (!server || typeof server !== 'object') continue;
    const raw = server.urls ?? server.url;
    const urls = (Array.isArray(raw) ? raw : [raw]).filter(
      (u) => typeof u === 'string' && !/:53([/?]|$)/.test(u),
    );
    if (urls.length === 0) continue;
    out.push({ ...server, urls });
  }
  return out.length > 0 ? out : null;
}

async function mintIceServers(env) {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_API_TOKEN;
  if (!keyId || !token) return null;

  const now = Date.now();
  if (iceCache && iceCache.expiresAt > now + ICE_REFRESH_LEAD_MS) return iceCache.servers;

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
    },
  );
  if (!res.ok) throw new Error(`turn credentials: ${res.status}`);

  const servers = usableIceServers((await res.json())?.iceServers);
  if (!servers) throw new Error('turn credentials: empty');
  iceCache = { servers, expiresAt: now + ICE_TTL_SECONDS * 1000 };
  return servers;
}

async function handleIce(env) {
  try {
    const servers = await mintIceServers(env);
    if (servers) return jsonResponse({ iceServers: servers, source: 'cloudflare-turn' });
  } catch {
    /* fall through to STUN — a broken TURN must never take the booth down */
  }
  return jsonResponse({ iceServers: STUN_FALLBACK, source: 'stun' });
}

export class BoothHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const selfId = crypto.randomUUID().slice(0, 8);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ selfId, room: null, role: null });
    this.send(server, { t: 'welcome', selfId });

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* already gone */
    }
  }

  /** Every socket currently sitting in `room`. */
  membersOf(room) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (meta?.room === room) out.push({ ws, meta });
    }
    return out;
  }

  /** Announce a departure to whoever is still in the room. */
  drop(ws) {
    let meta;
    try {
      meta = ws.deserializeAttachment();
    } catch {
      return;
    }
    if (!meta?.room) return;
    const room = meta.room;
    const selfId = meta.selfId;

    meta.room = null;
    meta.role = null;
    try {
      ws.serializeAttachment(meta);
    } catch {
      /* socket already closed — nothing left to persist */
    }

    for (const member of this.membersOf(room)) {
      this.send(member.ws, { t: 'peer-left', peerId: selfId });
    }
  }

  joinRoom(ws, meta, room) {
    // One socket, one room — leave the old one first.
    if (meta.room) this.drop(ws);

    const members = this.membersOf(room);
    if (members.length === 0) {
      this.send(ws, { t: 'error', code: 'not-found' });
      return;
    }
    if (members.length >= MAX_MEMBERS) {
      this.send(ws, { t: 'error', code: 'full' });
      return;
    }

    const hostIsPresent = members.some((m) => m.meta.role === 'host');
    meta.room = room;
    meta.role = hostIsPresent ? 'guest' : 'host';
    ws.serializeAttachment(meta);

    this.send(ws, {
      t: 'joined',
      room,
      role: meta.role,
      peers: members.map((m) => m.meta.selfId),
    });
    for (const member of members) this.send(member.ws, { t: 'peer-joined', peerId: meta.selfId });
  }

  createRoom(ws, meta, room) {
    if (meta.room) this.drop(ws);

    if (this.membersOf(room).length > 0) {
      this.send(ws, { t: 'error', code: 'exists' });
      return;
    }

    meta.room = room;
    meta.role = 'host';
    ws.serializeAttachment(meta);
    this.send(ws, { t: 'created', room, role: 'host' });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    let meta;
    try {
      meta = ws.deserializeAttachment();
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create':
        this.createRoom(ws, meta, String(msg.room || ''));
        return;
      case 'join':
        this.joinRoom(ws, meta, String(msg.room || ''));
        return;
      case 'signal': {
        const room = meta.room || String(msg.room || '');
        if (!room) return;
        for (const member of this.membersOf(room)) {
          if (member.meta.selfId === meta.selfId) continue;
          this.send(member.ws, { t: 'signal', from: meta.selfId, data: msg.data });
        }
        return;
      }
      case 'leave':
        this.drop(ws);
        return;
      default:
        return;
    }
  }

  async webSocketClose(ws) {
    this.drop(ws);
  }

  async webSocketError(ws) {
    this.drop(ws);
  }
}

export default {
  async fetch(request, env) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      const { pathname } = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (pathname === '/ice') return handleIce(env);
      return new Response('lovebooth signaling relay\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // One hub object for the whole app: rooms are tiny and short-lived, and a
    // single object keeps membership checks trivial.
    const hub = env.BOOTH.get(env.BOOTH.idFromName('lovebooth'));
    return hub.fetch(request);
  },
};
