/**
 * WebRTC plumbing for the booth.
 *
 * Responsibilities are intentionally narrow: negotiate a peer connection,
 * carry a single reliable data channel, move chunked photo blobs across it,
 * and keep the two device clocks aligned so a countdown means the same
 * instant on both ends. It knows nothing about the UI.
 */

import type { BoothMessage, PeerSignal, Role } from './protocol';
import { isBoothMessage } from './protocol';

export type PeerState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface PhotoTransferMeta {
  id: string;
  frame: number;
  session: string;
  mime: string;
  size: number;
}

export interface BoothPeerEvents {
  onState?: (state: PeerState) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
  onDataOpen?: () => void;
  onDataClose?: () => void;
  onMessage?: (message: BoothMessage) => void;
  onPhoto?: (meta: PhotoTransferMeta, blob: Blob) => void;
  onPhotoProgress?: (frame: number, received: number, total: number) => void;
  /** Fired whenever a fresh clock sample lands, so a pending countdown can re-arm. */
  onClockSync?: () => void;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Small enough for every browser's data channel message limit. */
const CHUNK_SIZE = 16 * 1024;
const BUFFER_HIGH_WATER = 512 * 1024;
const CLOCK_SYNC_INTERVAL = 10_000;

function isPeerSignal(value: unknown): value is PeerSignal {
  if (typeof value !== 'object' || value === null) return false;
  const k = (value as { k?: unknown }).k;
  return k === 'offer' || k === 'answer' || k === 'ice';
}

export class BoothPeer {
  readonly role: Role;

  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private events: BoothPeerEvents;

  private makingOffer = false;
  private ignoreOffer = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private localTracks = new Set<RTCRtpSender>();
  private state: PeerState = 'idle';

  /** guestClock − hostClock, measured by the host. */
  private clockOffset = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockInFlight = false;

  private activeTransfer: { meta: PhotoTransferMeta; parts: Blob[]; received: number } | null =
    null;

  constructor(
    role: Role,
    events: BoothPeerEvents = {},
    options: { iceServers?: RTCIceServer[] } = {},
  ) {
    this.role = role;
    this.events = events;
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers ?? ICE_SERVERS });
    this.wire();
    if (role === 'host') this.openDataChannel();
  }

  /* ------------------------- lifecycle ------------------------- */

  private setState(next: PeerState) {
    if (this.state === next) return;
    this.state = next;
    this.events.onState?.(next);
  }

  getState(): PeerState {
    return this.state;
  }

  isDataOpen(): boolean {
    return this.dc?.readyState === 'open';
  }

  private wire() {
    const pc = this.pc;

    pc.onicecandidate = ({ candidate }) => {
      this.signal({ k: 'ice', candidate: candidate ? candidate.toJSON() : null });
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connecting':
          this.setState('connecting');
          break;
        case 'connected':
          this.setState('connected');
          this.startClockSync();
          break;
        case 'disconnected':
          this.setState('reconnecting');
          break;
        case 'failed':
          this.setState('failed');
          break;
        case 'closed':
          this.setState('closed');
          break;
        default:
          break;
      }
    };

    pc.onnegotiationneeded = () => {
      void this.enqueue(async () => {
        try {
          this.makingOffer = true;
          const offer = await pc.createOffer();
          if (pc.signalingState !== 'stable') return;
          await pc.setLocalDescription(offer);
          if (pc.localDescription) {
            this.signal({ k: 'offer', sdp: pc.localDescription.toJSON() });
          }
        } catch (err) {
          console.warn('[booth] negotiation failed', err);
        } finally {
          this.makingOffer = false;
        }
      });
    };

    pc.ontrack = ({ streams }) => {
      this.events.onRemoteStream?.(streams[0] ?? null);
    };

    // Only the host opens the channel; the guest adopts it here.
    pc.ondatachannel = ({ channel }) => this.attachChannel(channel);
  }

  private openDataChannel() {
    const dc = this.pc.createDataChannel('booth', { ordered: true });
    this.attachChannel(dc);
  }

  private attachChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;

    dc.onopen = () => {
      this.setState('connected');
      this.events.onDataOpen?.();
      if (this.role === 'host') void this.runClockSync();
    };

    dc.onclose = () => {
      this.events.onDataClose?.();
      if (this.pc.connectionState !== 'connected') this.setState('reconnecting');
    };

    dc.onerror = () => {
      /* surfaced through connection state, never shown raw to the user */
    };

    dc.onmessage = (event) => this.handleChannelData(event.data);
  }

  private handleChannelData(data: unknown) {
    if (typeof data === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isBoothMessage(parsed)) return;
      this.applyControlMessage(parsed);
      return;
    }

    if (data instanceof ArrayBuffer) this.handleChunk(data);
  }

  private applyControlMessage(message: BoothMessage) {
    switch (message.t) {
      case 'clock':
        this.applyClockMessage(message);
        return;
      case 'photo-meta':
        this.activeTransfer = {
          meta: {
            id: message.id,
            frame: message.frame,
            session: message.session,
            mime: message.mime,
            size: message.size,
          },
          parts: [],
          received: 0,
        };
        this.events.onPhotoProgress?.(message.frame, 0, message.size);
        return;
      case 'photo-end': {
        const transfer = this.activeTransfer;
        this.activeTransfer = null;
        if (!transfer || transfer.meta.id !== message.id) return;
        const blob = new Blob(transfer.parts, { type: transfer.meta.mime });
        this.events.onPhoto?.(transfer.meta, blob);
        return;
      }
      default:
        this.events.onMessage?.(message);
    }
  }

  private handleChunk(buffer: ArrayBuffer) {
    const transfer = this.activeTransfer;
    if (!transfer) return;
    transfer.parts.push(new Blob([buffer]));
    transfer.received += buffer.byteLength;
    this.events.onPhotoProgress?.(
      transfer.meta.frame,
      Math.min(transfer.received, transfer.meta.size),
      transfer.meta.size,
    );
  }

  /* ------------------------- signaling glue ------------------------- */

  /** Outbound signaling. Wired up by the app so this class stays independent. */
  onSignalOut: ((payload: PeerSignal) => void) | null = null;

  private signal(payload: PeerSignal) {
    this.onSignalOut?.(payload);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  handleSignal(data: unknown): void {
    if (!isPeerSignal(data)) return;
    void this.enqueue(() => this.applySignal(data));
  }

  private async applySignal(data: PeerSignal): Promise<void> {
    const pc = this.pc;
    try {
      if (data.k === 'offer') {
        const collision = this.makingOffer || pc.signalingState !== 'stable';
        this.ignoreOffer = !this.isPolite() && collision;
        if (this.ignoreOffer) return;
        if (pc.signalingState === 'have-local-offer') {
          try {
            await pc.setLocalDescription({ type: 'rollback' });
          } catch {
            /* implicit rollback will be attempted by setRemoteDescription */
          }
        }
        await pc.setRemoteDescription(data.sdp);
        await this.flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription) this.signal({ k: 'answer', sdp: pc.localDescription.toJSON() });
        return;
      }

      if (data.k === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(data.sdp);
        await this.flushCandidates();
        return;
      }

      if (data.k === 'ice') {
        if (!data.candidate) return;
        if (!pc.remoteDescription) {
          this.pendingCandidates.push(data.candidate);
          return;
        }
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      if (!this.ignoreOffer) console.warn('[booth] signal handling failed', err);
    }
  }

  /** The guest is the "polite" peer: it backs down when both sides offer. */
  private isPolite(): boolean {
    return this.role === 'guest';
  }

  private async flushCandidates(): Promise<void> {
    const queue = this.pendingCandidates.splice(0);
    for (const candidate of queue) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* candidate may be stale after a rollback */
      }
    }
  }

  /* ------------------------- media ------------------------- */

  setLocalStream(stream: MediaStream | null): void {
    const videoSenders = this.pc.getSenders().filter((s) => s.track?.kind === 'video');
    if (!stream) {
      for (const sender of videoSenders) {
        void sender.replaceTrack(null);
      }
      return;
    }

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    if (videoSenders.length > 0) {
      void videoSenders[0].replaceTrack(track);
      this.localTracks.add(videoSenders[0]);
      return;
    }

    const sender = this.pc.addTrack(track, stream);
    this.localTracks.add(sender);
  }

  restartIce(): void {
    if (this.role !== 'host') return;
    try {
      this.pc.restartIce();
    } catch {
      /* older browsers renegotiate via a fresh offer instead */
    }
  }

  /* ------------------------- messaging ------------------------- */

  send(message: BoothMessage): boolean {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private async waitForBuffer(): Promise<void> {
    const dc = this.dc;
    if (!dc) return;
    while (dc.bufferedAmount > BUFFER_HIGH_WATER && dc.readyState === 'open') {
      await new Promise<void>((resolve) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', done, { once: true });
        dc.addEventListener('close', done, { once: true });
        setTimeout(done, 400);
      });
    }
  }

  /** Chunked binary transfer — photos never leave the peer connection. */
  async sendPhoto(meta: Omit<PhotoTransferMeta, 'size'>, blob: Blob): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('data channel closed');

    this.send({
      t: 'photo-meta',
      id: meta.id,
      frame: meta.frame,
      session: meta.session,
      mime: blob.type || 'image/jpeg',
      size: blob.size,
    });

    const total = Math.ceil(blob.size / CHUNK_SIZE) || 1;
    for (let index = 0; index < total; index += 1) {
      const slice = blob.slice(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, blob.size));
      const buffer = await slice.arrayBuffer();
      await this.waitForBuffer();
      dc.send(buffer);
    }

    this.send({
      t: 'photo-end',
      id: meta.id,
      frame: meta.frame,
      session: meta.session,
    });
  }

  /* ------------------------- clock sync ------------------------- */

  private startClockSync() {
    this.stopClockSync();
    if (this.role !== 'host') return;
    void this.runClockSync();
    this.clockTimer = setInterval(() => void this.runClockSync(), CLOCK_SYNC_INTERVAL);
  }

  private stopClockSync() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  private pendingClockResolve: ((t2: number) => void) | null = null;

  private async runClockSync() {
    if (this.role !== 'host' || !this.isDataOpen() || this.clockInFlight) return;
    this.clockInFlight = true;
    try {
      const t1 = Date.now();
      if (!this.send({ t: 'clock', stage: 'ping', t1 })) return;
      const sample = await new Promise<{ t2: number; t3: number } | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingClockResolve = null;
          resolve(null);
        }, 3000);
        this.pendingClockResolve = (t2) => {
          clearTimeout(timer);
          resolve({ t2, t3: Date.now() });
        };
      });
      if (!sample) return;
      this.clockOffset = (sample.t2 - t1 + (sample.t2 - sample.t3)) / 2;
      this.send({ t: 'clock', stage: 'result', offset: this.clockOffset });
      this.events.onClockSync?.();
    } finally {
      this.clockInFlight = false;
    }
  }

  private applyClockMessage(message: BoothMessage & { t: 'clock' }) {
    if (message.stage === 'ping') {
      if (this.role !== 'guest') return;
      this.send({ t: 'clock', stage: 'pong', t1: message.t1, t2: Date.now() });
      return;
    }
    if (message.stage === 'pong') {
      if (this.role !== 'host') return;
      this.pendingClockResolve?.(message.t2 ?? 0);
      return;
    }
    if (message.stage === 'result') {
      this.clockOffset = message.offset ?? 0;
      this.events.onClockSync?.();
      return;
    }
    if (message.stage === 'need') {
      if (this.role === 'host') void this.runClockSync();
    }
  }

  /** Convert a shared capture timestamp into this device's wall clock. */
  localTargetFor(targetAt: number, initiator: Role): number {
    const iAmHost = this.role === 'host';
    if (initiator === 'host') return iAmHost ? targetAt : targetAt + this.clockOffset;
    return iAmHost ? targetAt - this.clockOffset : targetAt;
  }

  getClockOffset(): number {
    return this.clockOffset;
  }

  /** Ask the host for a fresh sample before a guest-initiated countdown. */
  requestClockSync(): void {
    if (this.role === 'guest') this.send({ t: 'clock', stage: 'need' });
    else void this.runClockSync();
  }

  /* ------------------------- teardown ------------------------- */

  close(): void {
    this.stopClockSync();
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.dc = null;
    this.setState('closed');
  }
}
