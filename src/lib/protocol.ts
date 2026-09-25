/**
 * Everything that travels between the two booth participants.
 *
 * Signaling carries only WebRTC negotiation payloads. After the peer
 * connection is up, every message below rides the RTCDataChannel — photos
 * included — so nothing about the booth ever touches a server.
 */

import type { TemplateId, ThemeId } from './style';

export type Role = 'host' | 'guest';

export interface OfferSignal {
  k: 'offer';
  sdp: RTCSessionDescriptionInit;
}

export interface AnswerSignal {
  k: 'answer';
  sdp: RTCSessionDescriptionInit;
}

export interface IceSignal {
  k: 'ice';
  candidate: RTCIceCandidateInit | null;
}

export type PeerSignal = OfferSignal | AnswerSignal | IceSignal;

export type BoothMessage =
  /**
   * First message on a fresh channel: who I am, whether my camera is live,
   * and which strip style I currently have selected — a peer that joins (or
   * rejoins) late adopts the style already in play. `frame` and `done` say how
   * far along this booth is, so one that reloads mid-run can be moved back to
   * the frame the other is still on instead of deadlocking on mismatched
   * frame numbers.
   */
  | {
      t: 'hello';
      role: Role;
      cameraReady: boolean;
      session: string;
      frame: number;
      done: boolean;
      template: TemplateId;
      theme: ThemeId;
    }
  /** Either side restyled the strip; last write wins. */
  | { t: 'style'; template: TemplateId; theme: ThemeId }
  /** Camera hot-plug / permission changes after the handshake. */
  | { t: 'camera'; ready: boolean; session: string }
  /**
   * Clock alignment. The room host pings, the guest answers, the host
   * publishes `offset = guestClock - hostClock`. Count-down timestamps are
   * then converted locally so both booths flash on the same instant.
   */
  | { t: 'clock'; stage: 'ping' | 'pong' | 'result' | 'need'; t1?: number; t2?: number; offset?: number }
  /** Explicit ready flag for a given frame. */
  | { t: 'ready'; frame: number; value: boolean; session: string }
  /**
   * The synchronized countdown. `targetAt` is a wall-clock timestamp in the
   * *initiator's* clock; both peers convert it locally using the measured
   * clock offset. Never a per-device `setTimeout(3000)`.
   */
  | { t: 'capture'; frame: number; session: string; targetAt: number; initiator: Role }
  /** Header for an incoming chunked photo transfer. */
  | { t: 'photo-meta'; id: string; frame: number; session: string; mime: string; size: number }
  /** Trailing signal once every chunk has been flushed. */
  | { t: 'photo-end'; id: string; frame: number; session: string }
  /** One side wants to redo the current frame; both must say yes. */
  | { t: 'retake'; frame: number; session: string }
  /** Keep the frame as-is and move on now instead of waiting out the hold. */
  | { t: 'keep'; frame: number; session: string }
  /**
   * One side gave up a finished strip and started another run of their own.
   * It is a hint, never a command: the receiver stays wherever it is and may
   * join later through its own button. Which is why it carries nothing to
   * apply — no session, no frame, nothing that could move a screen.
   */
  | { t: 'redo' }
  /** Polite goodbye before a tab closes. */
  | { t: 'bye' };

export function isBoothMessage(value: unknown): value is BoothMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string'
  );
}
