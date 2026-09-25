/**
 * Signaling is deliberately a thin, swappable seam.
 *
 * The UI only ever talks to {@link SignalingClient}. Two transports ship with
 * the booth:
 *
 *  - `WebSocketSignalingClient` — the default. Talks to the deployed relay
 *    below, so two phones on two networks can find each other. Point
 *    `PUBLIC_SIGNALING_URL` at any other relay (or `npm run relay`) and
 *    nothing else changes.
 *  - `BroadcastChannelSignalingClient` — no server at all; used on localhost,
 *    where two tabs on the same machine can develop and demo the full flow
 *    without a relay running.
 *
 * Signaling only ever moves WebRTC negotiation payloads and presence. Photos
 * never go through it.
 */

import { generateRoomCode, isValidRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from './room';
import type { Role } from './protocol';

/**
 * The deployed Cloudflare Worker (`relay/`). Public on purpose: it only
 * forwards SDP/ICE payloads and room presence, never photos or anything
 * identifying. Override with `PUBLIC_SIGNALING_URL` to use your own.
 */
export const DEPLOYED_RELAY_URL = 'wss://lovebooth-relay.fandyglitch3.workers.dev/';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export type SignalingErrorKind =
  | 'not-found'
  | 'full'
  | 'bad-code'
  | 'exists'
  | 'transport'
  | 'unsupported'
  | 'timeout';

export class SignalingError extends Error {
  readonly kind: SignalingErrorKind;
  constructor(kind: SignalingErrorKind, message = kind) {
    super(message);
    this.name = 'SignalingError';
    this.kind = kind;
  }
}

export interface SignalingClient {
  createRoom(): Promise<string>;
  joinRoom(code: string): Promise<void>;
  sendSignal(data: unknown): void;
  onSignal(callback: (data: unknown) => void): void;

  /** Extension points — the core four above stay transport-agnostic. */
  readonly mode: 'relay' | 'local';
  readonly selfId: string;
  readonly roomCode: string | null;
  readonly role: Role | null;
  onPeerJoin(callback: (peerId: string) => void): void;
  onPeerLeave(callback: (peerId: string) => void): void;
  onError(callback: (kind: SignalingErrorKind) => void): void;
  leave(): void;
  close(): void;
}

/* ------------------------------------------------------------------ *
 * WebSocket relay transport
 * ------------------------------------------------------------------ */

type RelayServerMessage =
  | { t: 'welcome'; selfId: string }
  | { t: 'created'; room: string }
  | { t: 'joined'; room: string; role: Role; peers: string[] }
  | { t: 'error'; code: SignalingErrorKind }
  | { t: 'peer-joined'; peerId: string }
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from: string; data: unknown };

export class WebSocketSignalingClient implements SignalingClient {
  readonly mode = 'relay' as const;

  private url: string;
  private socket: WebSocket | null = null;
  private queue: string[] = [];
  private pending: {
    accept: string;
    resolve: (msg: RelayServerMessage) => void;
    reject: (err: SignalingError) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private _selfId = '';
  private _roomCode: string | null = null;
  private _role: Role | null = null;

  private signalCb: ((data: unknown) => void) | null = null;
  private peerJoinCb: ((peerId: string) => void) | null = null;
  private peerLeaveCb: ((peerId: string) => void) | null = null;
  private errorCb: ((kind: SignalingErrorKind) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get selfId() {
    return this._selfId;
  }
  get roomCode() {
    return this._roomCode;
  }
  get role() {
    return this._role;
  }

  private connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        this.socket!.addEventListener('open', () => resolve(), { once: true });
        this.socket!.addEventListener(
          'error',
          () => reject(new SignalingError('transport')),
          { once: true },
        );
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch {
        reject(new SignalingError('transport'));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SignalingError('timeout'));
      }, 8000);

      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const line of this.queue.splice(0)) socket.send(line);
        resolve();
      });

      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SignalingError('transport'));
      });

      socket.addEventListener('close', () => {
        this.socket = null;
        if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.reject(new SignalingError('transport'));
        }
        if (!settled && !this._roomCode) {
          settled = true;
          clearTimeout(timer);
          reject(new SignalingError('transport'));
        }
      });

      socket.addEventListener('message', (event) => this.handleMessage(event.data));
    });
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let msg: RelayServerMessage;
    try {
      msg = JSON.parse(raw) as RelayServerMessage;
    } catch {
      return;
    }

    if (msg.t === 'welcome') {
      this._selfId = msg.selfId;
      return;
    }

    if (msg.t === 'signal') {
      this.signalCb?.(msg.data);
      return;
    }

    if (msg.t === 'peer-joined') {
      this.peerJoinCb?.(msg.peerId);
      return;
    }

    if (msg.t === 'peer-left') {
      this.peerLeaveCb?.(msg.peerId);
      return;
    }

    if (msg.t === 'error') {
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(new SignalingError(msg.code));
      } else {
        this.errorCb?.(msg.code);
      }
      return;
    }

    const pending = this.pending;
    if (pending && pending.accept === msg.t) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  }

  private request(
    payload: Record<string, unknown>,
    accept: string,
  ): Promise<RelayServerMessage> {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        this.pending = null;
        reject(new SignalingError('timeout'));
      }
      const timer = setTimeout(() => {
        if (this.pending?.resolve !== resolve) return;
        this.pending = null;
        reject(new SignalingError('timeout'));
      }, 8000);
      this.pending = { accept, resolve, reject, timer };

      const line = JSON.stringify(payload);
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(line);
      } else {
        this.queue.push(line);
      }
    });
  }

  async createRoom(): Promise<string> {
    await this.connect();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = generateRoomCode();
      try {
        const msg = await this.request({ t: 'create', room: code }, 'created');
        if (msg.t === 'created') {
          this._roomCode = msg.room;
          this._role = 'host';
          return msg.room;
        }
      } catch (err) {
        if (err instanceof SignalingError && (err.kind === 'exists' || err.kind === 'timeout')) {
          // Code collision — draw another one.
          continue;
        }
        throw err;
      }
    }
    throw new SignalingError('transport');
  }

  async joinRoom(codeInput: string): Promise<void> {
    const code = normalizeRoomCode(codeInput);
    if (!isValidRoomCode(code) || code.length !== ROOM_CODE_LENGTH) {
      throw new SignalingError('bad-code');
    }
    await this.connect();
    const msg = await this.request({ t: 'join', room: code }, 'joined');
    if (msg.t !== 'joined') throw new SignalingError('transport');
    this._roomCode = msg.room;
    this._role = msg.role;
    // Tell the app who is already in the room before any SDP starts flying.
    for (const peerId of msg.peers) this.peerJoinCb?.(peerId);
  }

  sendSignal(data: unknown): void {
    if (!this._roomCode) return;
    const line = JSON.stringify({ t: 'signal', room: this._roomCode, data });
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(line);
    } else {
      this.queue.push(line);
    }
  }

  onSignal(callback: (data: unknown) => void) {
    this.signalCb = callback;
  }
  onPeerJoin(callback: (peerId: string) => void) {
    this.peerJoinCb = callback;
  }
  onPeerLeave(callback: (peerId: string) => void) {
    this.peerLeaveCb = callback;
  }
  onError(callback: (kind: SignalingErrorKind) => void) {
    this.errorCb = callback;
  }

  leave(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this._roomCode) {
      this.socket.send(JSON.stringify({ t: 'leave', room: this._roomCode }));
    }
    this._roomCode = null;
    this._role = null;
  }

  close(): void {
    this.leave();
    this.socket?.close();
    this.socket = null;
  }
}

/* ------------------------------------------------------------------ *
 * BroadcastChannel transport (no server, same device)
 * ------------------------------------------------------------------ */

const REGISTRY_PREFIX = 'pb:room:';
const PRESENCE_PREFIX = 'pb:presence:';
const PRESENCE_TTL = 7000;
const HEARTBEAT_MS = 2000;

interface PresenceRecord {
  id: string;
  role: Role;
  lastSeen: number;
}

function presenceKey(code: string, id: string) {
  return `${PRESENCE_PREFIX}${code}:${id}`;
}

function readPresence(code: string): PresenceRecord[] {
  const out: PresenceRecord[] = [];
  const prefix = `${PRESENCE_PREFIX}${code}:`;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as PresenceRecord;
      if (value && typeof value.lastSeen === 'number' && Date.now() - value.lastSeen < PRESENCE_TTL) {
        out.push(value);
      }
    } catch {
      /* stale entry */
    }
  }
  return out;
}

export class BroadcastChannelSignalingClient implements SignalingClient {
  readonly mode = 'local' as const;

  private channel: BroadcastChannel | null = null;
  private _selfId = `p${Math.random().toString(36).slice(2, 10)}`;
  private _roomCode: string | null = null;
  private _role: Role | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private knownPeers = new Set<string>();

  private signalCb: ((data: unknown) => void) | null = null;
  private peerJoinCb: ((peerId: string) => void) | null = null;
  private peerLeaveCb: ((peerId: string) => void) | null = null;

  get selfId() {
    return this._selfId;
  }
  get roomCode() {
    return this._roomCode;
  }
  get role() {
    return this._role;
  }

  private post(message: Record<string, unknown>) {
    this.channel?.postMessage({ ...message, from: this._selfId });
  }

  private handleMessage(event: MessageEvent) {
    const msg = event.data as Record<string, unknown> & { from?: string };
    if (!msg || typeof msg !== 'object' || msg.from === this._selfId) return;

    switch (msg.k) {
      case 'signal':
        this.signalCb?.(msg.data);
        break;
      case 'present': {
        const peerId = String(msg.from);
        const isNew = !this.knownPeers.has(peerId);
        this.knownPeers.add(peerId);
        if (isNew) {
          this.peerJoinCb?.(peerId);
          // Answer so the newcomer learns about us too.
          this.post({ k: 'present', role: this._role });
        }
        break;
      }
      case 'bye': {
        const peerId = String(msg.from);
        if (this.knownPeers.delete(peerId)) this.peerLeaveCb?.(peerId);
        break;
      }
      default:
        break;
    }
  }

  private writePresence() {
    if (!this._roomCode || !this._role) return;
    const record: PresenceRecord = {
      id: this._selfId,
      role: this._role,
      lastSeen: Date.now(),
    };
    localStorage.setItem(presenceKey(this._roomCode, this._selfId), JSON.stringify(record));
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.writePresence();
    this.heartbeat = setInterval(() => this.writePresence(), HEARTBEAT_MS);

    this.watcher = setInterval(() => {
      if (!this._roomCode) return;
      const live = readPresence(this._roomCode);
      const liveIds = new Set(live.map((p) => p.id));
      for (const id of [...this.knownPeers]) {
        if (id === this._selfId) continue;
        if (!liveIds.has(id)) {
          this.knownPeers.delete(id);
          this.peerLeaveCb?.(id);
        }
      }
      for (const record of live) {
        if (record.id === this._selfId) continue;
        if (!this.knownPeers.has(record.id)) {
          this.knownPeers.add(record.id);
          this.peerJoinCb?.(record.id);
        }
      }
    }, HEARTBEAT_MS);

    window.addEventListener('pagehide', this.onPageHide);
  }

  private onPageHide = () => {
    this.post({ k: 'bye' });
    if (this._roomCode) localStorage.removeItem(presenceKey(this._roomCode, this._selfId));
  };

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watcher) clearInterval(this.watcher);
    this.heartbeat = null;
    this.watcher = null;
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private openChannel(code: string) {
    this.channel?.close();
    this.channel = new BroadcastChannel(`pb:booth:${code}`);
    this.channel.addEventListener('message', (event) => this.handleMessage(event));
  }

  async createRoom(): Promise<string> {
    if (typeof BroadcastChannel === 'undefined' || typeof localStorage === 'undefined') {
      throw new SignalingError('unsupported');
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateRoomCode();
      const existing = localStorage.getItem(REGISTRY_PREFIX + code);
      if (existing && readPresence(code).length > 0) continue;

      this._roomCode = code;
      this._role = 'host';
      this.knownPeers.clear();
      localStorage.setItem(
        REGISTRY_PREFIX + code,
        JSON.stringify({ createdAt: Date.now(), hostId: this._selfId }),
      );
      this.openChannel(code);
      this.startHeartbeat();
      this.post({ k: 'present', role: this._role });
      return code;
    }
    throw new SignalingError('transport');
  }

  async joinRoom(codeInput: string): Promise<void> {
    if (typeof BroadcastChannel === 'undefined' || typeof localStorage === 'undefined') {
      throw new SignalingError('unsupported');
    }
    const code = normalizeRoomCode(codeInput);
    if (!isValidRoomCode(code) || code.length !== ROOM_CODE_LENGTH) {
      throw new SignalingError('bad-code');
    }

    const registry = localStorage.getItem(REGISTRY_PREFIX + code);
    const presence = readPresence(code);
    if (!registry && presence.length === 0) throw new SignalingError('not-found');
    if (presence.filter((p) => p.id !== this._selfId).length >= 2) {
      throw new SignalingError('full');
    }

    const hostIsLive = presence.some((p) => p.role === 'host');
    this._roomCode = code;
    this._role = hostIsLive ? 'guest' : 'host';
    this.knownPeers.clear();
    localStorage.setItem(
      REGISTRY_PREFIX + code,
      JSON.stringify({ createdAt: Date.now(), hostId: this._selfId }),
    );

    this.openChannel(code);
    this.startHeartbeat();
    this.post({ k: 'present', role: this._role });
  }

  sendSignal(data: unknown) {
    this.post({ k: 'signal', data });
  }

  onSignal(callback: (data: unknown) => void) {
    this.signalCb = callback;
  }
  onPeerJoin(callback: (peerId: string) => void) {
    this.peerJoinCb = callback;
  }
  onPeerLeave(callback: (peerId: string) => void) {
    this.peerLeaveCb = callback;
  }
  /** The local transport reports failures through promises, never async. */
  onError(_callback: (kind: SignalingErrorKind) => void) {
    /* intentionally empty */
  }

  leave() {
    this.post({ k: 'bye' });
    if (this._roomCode) {
      localStorage.removeItem(presenceKey(this._roomCode, this._selfId));
      if (readPresence(this._roomCode).length === 0) {
        localStorage.removeItem(REGISTRY_PREFIX + this._roomCode);
      }
    }
    this.stopHeartbeat();
    this.channel?.close();
    this.channel = null;
    this._roomCode = null;
    this._role = null;
  }

  close() {
    this.leave();
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function signalingTransportUrl(): string | null {
  const url = import.meta.env.PUBLIC_SIGNALING_URL;
  if (typeof url === 'string' && url.trim().length > 0) return url.trim();

  // On localhost there is nothing to relay between but two tabs, and the
  // BroadcastChannel does that with no server running at all.
  if (typeof location !== 'undefined' && LOCAL_HOSTS.has(location.hostname)) return null;

  return DEPLOYED_RELAY_URL;
}

export function createSignalingClient(): SignalingClient {
  const url = signalingTransportUrl();
  if (url) return new WebSocketSignalingClient(url);
  return new BroadcastChannelSignalingClient();
}
