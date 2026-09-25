/**
 * The booth is one explicit state machine. No scattered booleans — every
 * screen, button and status line is derived from `state`.
 */

import { loadStyle } from './style';
import type { TemplateId, ThemeId } from './style';

export type PhotoboothState =
  | 'landing'
  | 'creating-room'
  | 'joining-room'
  | 'waiting-for-partner'
  | 'connecting'
  | 'camera-permission'
  | 'ready'
  | 'countdown'
  | 'capturing'
  | 'waiting-for-photo'
  | 'photo-review'
  | 'generating-result'
  | 'result'
  | 'disconnected';

export type Screen =
  | 'landing'
  | 'create'
  | 'join'
  | 'permission'
  | 'booth'
  | 'result'
  | 'error';

export type ErrorKind =
  | 'camera-unsupported'
  | 'camera-denied'
  | 'camera-unavailable'
  | 'room-not-found'
  | 'room-full'
  | 'bad-code'
  | 'transport'
  | 'unsupported'
  | 'partner-left'
  | 'photo-transfer';

export interface FriendlyError {
  kind: ErrorKind;
  title: string;
  body: string;
  action: string;
}

export type ConnectionPhase =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'partner-connected'
  | 'cameras-ready'
  | 'ready'
  | 'capturing'
  | 'disconnected';

export interface AppState {
  screen: Screen;
  state: PhotoboothState;
  role: 'host' | 'guest' | null;
  roomCode: string | null;
  connection: ConnectionPhase;
  youReady: boolean;
  partnerReady: boolean;
  cameraReady: boolean;
  partnerCameraReady: boolean;
  frameIndex: number;
  totalFrames: number;
  countdownNumber: number;
  session: string;
  error: FriendlyError | null;
  partnerLeft: boolean;
  retakeRequested: boolean;
  retakeWaiting: boolean;
  receivingPhoto: boolean;
  signalingMode: 'relay' | 'local' | null;
  canResume: boolean;
  /** Strip arrangement. Synced over the data channel — see `BoothMessage`. */
  template: TemplateId;
  /** Strip palette. */
  theme: ThemeId;
}

export const TOTAL_FRAMES = 4;

export function createInitialState(): AppState {
  return {
    screen: 'landing',
    state: 'landing',
    role: null,
    roomCode: null,
    connection: 'idle',
    youReady: false,
    partnerReady: false,
    cameraReady: false,
    partnerCameraReady: false,
    frameIndex: 0,
    totalFrames: TOTAL_FRAMES,
    countdownNumber: 0,
    session: newSessionId(),
    error: null,
    partnerLeft: false,
    retakeRequested: false,
    retakeWaiting: false,
    receivingPhoto: false,
    signalingMode: null,
    canResume: false,
    ...loadStyle(),
  };
}

export function newSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

type Listener = (state: AppState) => void;

export class BoothStore {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState = createInitialState()) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): AppState {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof AppState)[]) {
      if (!Object.is(this.state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}
