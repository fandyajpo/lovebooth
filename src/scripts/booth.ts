/**
 * Booth orchestrator.
 *
 * Wires the state machine to the DOM. Networking lives in `signaling` and
 * `webrtc`, cameras in `camera`/`capture`, composition in `photostrip` — this
 * file only decides what the person in front of the screen sees next.
 */

import {
  BoothStore,
  TOTAL_FRAMES,
  createInitialState,
  newSessionId,
  type AppState,
  type ErrorKind,
  type FriendlyError,
  type Screen,
} from '../lib/state';
import {
  SignalingError,
  createSignalingClient,
  signalingTransportUrl,
  type SignalingClient,
} from '../lib/signaling';
import { BoothPeer, type PeerState, type PhotoTransferMeta } from '../lib/webrtc';
import { loadIceServers } from '../lib/ice';
import type { BoothMessage, Role } from '../lib/protocol';
import {
  CameraError,
  getCameraStream,
  isCameraSupported,
  stopStream,
  watchStreamEnd,
} from '../lib/camera';
import { DEFAULT_CAPTURE, captureFrame, canvasToBlob, computeGuideRect } from '../lib/capture';
import { composePhotostrip, downloadBlob, formatStripDate } from '../lib/photostrip';
import { playChime, playShutter, playTick, primeAudio, toggleMuted } from '../lib/sound';
import { formatRoomCode, isValidRoomCode, normalizeRoomCode } from '../lib/room';
import {
  getTemplate,
  getTheme,
  isTemplateId,
  isThemeId,
  saveStyle,
  type StripStyle,
} from '../lib/style';

/* ------------------------------------------------------------ constants -- */

const COUNTDOWN_LEAD = 3500;
const REVIEW_HOLD = 2600;
const RETAKE_DELAY = 900;
const PHOTO_WATCHDOG = 25_000;
/** How long two peers may sit in `Checking` before we admit the link failed. */
const CONNECT_WATCHDOG = 25_000;
const SESSION_TTL = 1000 * 60 * 60 * 2;
const SESSION_KEY = 'pb:session';
const FRAMES_KEY = 'pb:frames';
const STRIP_KEY = 'pb:strip';

const COPY: Record<ErrorKind, FriendlyError> = {
  'camera-unsupported': {
    kind: 'camera-unsupported',
    title: 'This browser can’t pose',
    body: 'The booth needs a browser with camera support. Try the latest Chrome, Safari, Firefox or Edge.',
    action: 'Return home',
  },
  'camera-denied': {
    kind: 'camera-denied',
    title: 'We need your camera',
    body: 'Please allow camera access to use the photobooth.',
    action: 'Try again',
  },
  'camera-unavailable': {
    kind: 'camera-unavailable',
    title: 'No camera found',
    body: 'Connect a camera, close anything else using it, then try again.',
    action: 'Try again',
  },
  'room-not-found': {
    kind: 'room-not-found',
    title: 'No booth with that code',
    body: 'Check the code with your partner — codes look like 8F3K.',
    action: 'Try again',
  },
  'room-full': {
    kind: 'room-full',
    title: 'This photobooth is already full',
    body: 'Only two people fit in here. Ask for a fresh code and start a new booth.',
    action: 'Return home',
  },
  'bad-code': {
    kind: 'bad-code',
    title: 'That code won’t open',
    body: 'Room codes are four characters, letters and numbers — no O, I or L.',
    action: 'Try again',
  },
  transport: {
    kind: 'transport',
    title: 'The booth is offline',
    body: 'We couldn’t reach the booth. Check your connection and try again.',
    action: 'Try again',
  },
  unsupported: {
    kind: 'unsupported',
    title: 'Try a modern browser',
    body: 'This booth is built on WebRTC, which your browser doesn’t seem to support.',
    action: 'Return home',
  },
  'partner-left': {
    kind: 'partner-left',
    title: 'Your partner left',
    body: 'The photobooth is waiting here if they come back.',
    action: 'Return home',
  },
  'photo-transfer': {
    kind: 'photo-transfer',
    title: 'A photo didn’t arrive',
    body: 'The picture never made it across. Let’s take that frame again.',
    action: 'Try again',
  },
  'strip-missing': {
    kind: 'strip-missing',
    title: 'No strip here',
    body: 'Strips stay in the tab that developed them — open this on the device that shot it, or start a fresh booth.',
    action: 'Start a booth',
  },
};

/* --------------------------------------------------------------- state --- */

const store = new BoothStore(createInitialState());

let signaling: SignalingClient | null = null;
let peer: BoothPeer | null = null;
let localStream: MediaStream | null = null;
let stopWatchLocal: (() => void) | null = null;

let peerPresent = false;
let dataOpen = false;
/** Fetched once per connection attempt — TURN credentials never touch storage. */
let iceServers: RTCIceServer[] | null = null;

const frames: { you: (string | undefined)[]; them: (string | undefined)[] } = {
  you: [],
  them: [],
};

let countdownRaf = 0;
let countdownTimer: ReturnType<typeof setTimeout> | undefined;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let connectWatchdog: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let retakeTimer: ReturnType<typeof setTimeout> | undefined;
let copyFlagTimer: ReturnType<typeof setTimeout> | undefined;

let pendingCapture: { frame: number; targetAt: number; initiator: Role } | null = null;
let captureFired = false;
let pendingIncomingCapture: { frame: number; targetAt: number; initiator: Role } | null = null;
let retake = { frame: -1, you: false, them: false };
let lastCountdownNumber = -1;
let lastFrameIndex = -1;
let stripCanvas: HTMLCanvasElement | null = null;
let stripUrl: string | null = null;
/** Set when the strip was opened from `/strip` — nothing is attached to it. */
let detachedStrip: string | null = null;
let errorRetry: (() => void) | null = null;
let styleOpen = false;
let styleTrigger: HTMLElement | null = null;
/** Which screen the panel was opened from, so leaving it can close the panel. */
let styleScreen: Screen | null = null;
let stripChain: Promise<void> = Promise.resolve();
let stripRenderTimer: ReturnType<typeof setTimeout> | undefined;

/* --------------------------------------------------------------- utils --- */

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

const el = {
  root: $('#booth-root')!,
  screens: {
    landing: $('#screen-landing')!,
    create: $('#screen-create')!,
    join: $('#screen-join')!,
    permission: $('#screen-permission')!,
    booth: $('#screen-booth')!,
    result: $('#screen-result')!,
    error: $('#screen-error')!,
  } as Record<Screen, HTMLElement>,

  status: $('#connection-status')!,
  statusText: $('#connection-text')!,
  barRoom: $('#bar-room')!,
  leaveBtn: $('#leave-btn') as HTMLButtonElement,

  videoYou: $('#video-you') as HTMLVideoElement,
  videoPartner: $('#video-partner') as HTMLVideoElement,
  camYou: $('[data-cam="you"]')!,
  camPartner: $('[data-cam="partner"]')!,

  rail: $('#rail')!,
  frameValue: $('#frame-value')!,
  hint: $('#deck-hint')!,
  readyBtn: $('#ready-btn') as HTMLButtonElement,
  captureBtn: $('#capture-btn') as HTMLButtonElement,
  readyCols: {
    you: $('[data-ready="you"]')!,
    partner: $('[data-ready="partner"]')!,
  },

  countdown: $('#countdown')!,
  countdownNum: $('#countdown-num')!,
  countdownSub: $('#countdown-sub')!,
  flash: $('#flash')!,

  review: $('#review')!,
  reviewFrame: $('#review-frame')!,
  reviewYou: $('#review-you') as HTMLImageElement,
  reviewThem: $('#review-them') as HTMLImageElement,
  reviewNext: $('#review-next')!,
  keepBtn: $('#keep-btn') as HTMLButtonElement,
  retakeBtn: $('#retake-btn') as HTMLButtonElement,
  retakeStatus: $('#retake-status')!,

  roomCode: $('#room-code')!,
  createTimestamp: $('#create-timestamp')!,
  createTransport: $('#create-transport')!,
  createStatus: $('#create-status')!,
  copyFlag: $('#copy-flag')!,

  joinForm: $('#join-form') as HTMLFormElement,
  roomInput: $('#room-input') as HTMLInputElement,
  joinMsg: $('#join-msg')!,
  joinHint: $('#join-hint')!,

  permTitle: $('#perm-title')!,
  permBody: $('#perm-body')!,
  permAction: $('#perm-action') as HTMLButtonElement,
  permLens: $('#perm-lens')!,
  permKicker: $('#perm-kicker')!,

  print: $('#print')!,
  stripImg: $('#strip-img') as HTMLImageElement,
  takeAnotherBtn: $('#take-another-btn') as HTMLButtonElement,
  resultStyleBtn: $('#result-style-btn') as HTMLButtonElement,

  errKicker: $('#err-kicker')!,
  errTitle: $('#err-title')!,
  errBody: $('#err-body')!,

  resume: $('#landing-resume')!,
  resumeCode: $('#resume-code')!,
  landingStamp: $('#landing-stamp')!,

  soundBtn: $('#sound-btn') as HTMLButtonElement,
  styleBtn: $('#style-btn') as HTMLButtonElement,
  stylePanel: $('#style-panel')!,
  styleNote: $('#style-note')!,
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}

function currentRole(): Role {
  return store.get().role === 'guest' ? 'guest' : 'host';
}

function clearTimer(ref: ReturnType<typeof setTimeout> | undefined): undefined {
  if (ref) clearTimeout(ref);
  return undefined;
}

/* ------------------------------------------------------------ rendering -- */

function refresh() {
  render(store.get());
}

function render(state: AppState) {
  for (const [name, node] of Object.entries(el.screens)) {
    node.classList.toggle('is-active', name === state.screen);
  }

  // The panel is anchored to the screen it was opened from — leave that screen
  // (home, error card, a new run) and it goes with you, without yanking focus
  // back to the trigger.
  if (styleOpen && styleScreen !== null && state.screen !== styleScreen) setStylePanel(false);

  el.barRoom.textContent = state.roomCode ?? '····';

  // connection status -----------------------------------------------------
  const status = describeStatus(state);
  el.statusText.textContent = status.text;
  el.status.dataset.tone = status.tone;

  // ready row -------------------------------------------------------------
  setReadyCol(el.readyCols.you, state.youReady);
  setReadyCol(el.readyCols.partner, state.partnerReady);

  // primary action --------------------------------------------------------
  const camerasReady = state.cameraReady && state.partnerCameraReady;
  const bothReady = state.youReady && state.partnerReady;

  if (!camerasReady) {
    el.readyBtn.hidden = true;
    el.captureBtn.hidden = true;
  } else if (!state.youReady) {
    el.readyBtn.hidden = false;
    el.captureBtn.hidden = true;
  } else {
    el.readyBtn.hidden = true;
    el.captureBtn.hidden = false;
    el.captureBtn.disabled = !bothReady;
    el.captureBtn.textContent = bothReady ? 'Capture' : 'Waiting for your partner…';
  }

  // hint ------------------------------------------------------------------
  el.hint.textContent = describeHint(state, camerasReady, bothReady);

  // frame counter ---------------------------------------------------------
  const value = String(state.frameIndex + 1).padStart(2, '0');
  if (el.frameValue.textContent !== value) {
    el.frameValue.textContent = value;
    if (lastFrameIndex !== state.frameIndex) {
      el.frameValue.classList.remove('is-bump');
      void el.frameValue.offsetWidth;
      el.frameValue.classList.add('is-bump');
    }
  }
  lastFrameIndex = state.frameIndex;

  // film rail -------------------------------------------------------------
  document.querySelectorAll<HTMLElement>('.rail__pair').forEach((pair) => {
    const index = Number(pair.dataset.pair);
    pair.classList.toggle('is-current', index === state.frameIndex && state.screen === 'booth');
  });

  // A strip opened from `/strip` was developed elsewhere — there is no partner
  // to re-shoot with and no live peer to sync a restyle to.
  const detached = state.screen === 'result' && detachedStrip !== null;
  el.takeAnotherBtn.hidden = detached;
  el.resultStyleBtn.hidden = detached;

  // strip style -----------------------------------------------------------
  el.stylePanel.querySelectorAll<HTMLElement>('[data-template]').forEach((chip) => {
    const checked = chip.dataset.template === state.template;
    chip.setAttribute('aria-checked', String(checked));
    chip.tabIndex = checked ? 0 : -1;
  });
  el.stylePanel.querySelectorAll<HTMLElement>('[data-theme]').forEach((chip) => {
    const checked = chip.dataset.theme === state.theme;
    chip.setAttribute('aria-checked', String(checked));
    chip.tabIndex = checked ? 0 : -1;
  });
  const chosenTemplate = getTemplate(state.template);
  const chosenTheme = getTheme(state.theme);
  el.styleNote.textContent = `${chosenTemplate.label} · ${chosenTheme.label} — both of you see the same strip.`;
}

function setReadyCol(node: HTMLElement, ready: boolean) {
  node.classList.toggle('is-ready', ready);
  const state = node.querySelector('.ready__state');
  if (state) state.textContent = ready ? '✓ Ready' : 'Not ready';
}

function describeStatus(state: AppState): { text: string; tone: string } {
  if (state.state === 'disconnected') return { text: 'Partner disconnected', tone: 'error' };
  if (state.state === 'countdown' || state.state === 'capturing') {
    return { text: 'Capturing', tone: 'busy' };
  }
  if (state.state === 'photo-review') return { text: 'Photo complete', tone: 'ok' };
  if (state.state === 'generating-result' || state.state === 'result') {
    return { text: 'Printing', tone: 'busy' };
  }
  if (state.screen !== 'booth') return { text: 'Waiting for your partner', tone: 'waiting' };
  if (!peerPresent) return { text: 'Waiting for your partner', tone: 'waiting' };
  if (!dataOpen) return { text: 'Connecting', tone: 'busy' };
  if (!state.partnerCameraReady) return { text: 'Partner connected', tone: 'ok' };
  if (!state.cameraReady) return { text: 'Your camera is off', tone: 'waiting' };
  if (state.youReady && state.partnerReady) return { text: 'Ready', tone: 'ok' };
  if (state.youReady && !state.partnerReady) return { text: 'Partner not ready', tone: 'waiting' };
  if (!state.youReady && state.partnerReady) return { text: 'Partner is ready', tone: 'waiting' };
  return { text: 'Both cameras ready', tone: 'ok' };
}

function describeHint(state: AppState, camerasReady: boolean, bothReady: boolean): string {
  switch (state.state) {
    case 'countdown':
      return 'Hold that pose';
    case 'capturing':
      return 'Flash!';
    case 'waiting-for-photo':
      return state.receivingPhoto ? 'Receiving photo…' : 'Sending your frame…';
    case 'photo-review':
      return `Frame ${String(state.frameIndex + 1).padStart(2, '0')} complete`;
    case 'generating-result':
      return 'Developing the strip…';
    default:
      break;
  }
  if (state.retakeWaiting) return 'Retaking frame…';
  if (state.retakeRequested) return 'Waiting for partner…';
  if (!peerPresent) {
    return state.partnerLeft
      ? 'Your partner stepped out — send them the code to come back'
      : 'Waiting for your partner';
  }
  if (!dataOpen) return 'Connecting…';
  if (!camerasReady) return 'Partner connected — cameras warming up';
  if (!bothReady) {
    return state.youReady ? 'Waiting for your partner…' : 'Tap “I’m ready” when you are';
  }
  return 'Both cameras ready — take the shot';
}

/* ------------------------------------------------------------- screens --- */

function showError(kind: ErrorKind, retry?: () => void) {
  const copy = COPY[kind];
  errorRetry = retry ?? null;
  el.errKicker.textContent = kind === 'partner-left' ? 'Session paused' : 'Booth notice';
  el.errTitle.textContent = copy.title;
  el.errBody.textContent = copy.body;
  $('#err-action')!.textContent = copy.action;
  store.set({
    screen: 'error',
    state: 'disconnected',
    error: copy,
    youReady: false,
    partnerReady: false,
  });
}

/** Which room screen the booth was entered from, so Back can return there. */
let roomScreen: 'create' | 'join' = 'join';
/** Deadline for the confirming second tap on the leave button. */
let leaveArmTimer = 0;

function backToRoom() {
  disarmLeave();
  store.set({
    screen: roomScreen,
    state: roomScreen === 'create' ? 'waiting-for-partner' : 'joining-room',
    error: null,
  });
}

function disarmLeave() {
  window.clearTimeout(leaveArmTimer);
  leaveArmTimer = 0;
  delete el.leaveBtn.dataset.armed;
  el.leaveBtn.setAttribute('aria-label', 'Leave the session');
}

/**
 * Leaving ends the session for both people, so once a frame exists the first
 * tap only arms the button — a second tap within three seconds confirms it.
 */
function leaveSession() {
  const armed = el.leaveBtn.dataset.armed === 'true';
  if (frames.you.length > 0 && !armed) {
    el.leaveBtn.dataset.armed = 'true';
    el.leaveBtn.setAttribute('aria-label', 'Tap again to leave the session');
    leaveArmTimer = window.setTimeout(disarmLeave, 3000);
    return;
  }
  disarmLeave();
  peer?.send({ t: 'bye' });
  goHome();
}

function goHome() {
  teardownRun();
  // Everywhere but `/` is a route of its own — going home is a real navigation
  // so the address bar, the back button and a reload all agree.
  if (location.pathname !== '/') {
    location.assign('/');
    return;
  }
  store.set({
    ...createInitialState(),
    screen: 'landing',
    state: 'landing',
    signalingMode: store.get().signalingMode,
    canResume: !!sessionRecord(),
  });
  showResumeIfNeeded();
}

function teardownRun() {
  stopCaptureTimers();
  clearConnectWatchdog();
  frames.you.length = 0;
  frames.them.length = 0;
  clearStill('you');
  clearStill('them');
  hideReview();
  hideCountdown();
  peer?.close();
  peer = null;
  peerPresent = false;
  dataOpen = false;
  if (signaling) {
    signaling.leave();
    signaling.close();
    signaling = null;
  }
  stopWatchLocal?.();
  stopWatchLocal = null;
  stopStream(localStream);
  localStream = null;
  el.videoYou.srcObject = null;
  el.camYou.classList.remove('is-live');
  sessionStorage.removeItem(SESSION_KEY);
}

function stopCaptureTimers() {
  countdownTimer = clearTimer(countdownTimer);
  reviewTimer = clearTimer(reviewTimer);
  watchdog = clearTimer(watchdog);
  retakeTimer = clearTimer(retakeTimer);
  cancelAnimationFrame(countdownRaf);
  pendingCapture = null;
  captureFired = false;
}

/* ---------------------------------------------------------- room session -- */

interface SessionRecord {
  code: string;
  role: Role;
  ts: number;
}

function sessionRecord(): SessionRecord | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionRecord;
    if (!parsed?.code || Date.now() - parsed.ts > SESSION_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(code: string, role: Role) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, role, ts: Date.now() }));
  } catch {
    /* private mode */
  }
}

interface StoredFrames {
  code: string;
  frameIndex: number;
  /** `null` where a frame was never shot — `undefined` does not survive JSON. */
  you: (string | null)[];
  them: (string | null)[];
  ts: number;
}

/**
 * Keep this booth's shots across a reload.
 *
 * The frames live only in memory, so a refresh mid-run would otherwise come
 * back with every photo missing on one side and a strip full of holes. The
 * storage is per-tab and dies with it — the same lifetime a room has.
 */
function saveFrames() {
  const { roomCode, frameIndex } = store.get();
  if (!roomCode) return;
  try {
    const payload: StoredFrames = {
      code: roomCode,
      frameIndex,
      you: frames.you.slice(0, TOTAL_FRAMES).map((v) => v ?? null),
      them: frames.them.slice(0, TOTAL_FRAMES).map((v) => v ?? null),
      ts: Date.now(),
    };
    sessionStorage.setItem(FRAMES_KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode — this run just won't survive a reload */
  }
}

function clearStoredFrames() {
  try {
    sessionStorage.removeItem(FRAMES_KEY);
  } catch {
    /* private mode */
  }
}

function restoreFrames(code: string) {
  if (frames.you.length > 0 || frames.them.length > 0) return;
  let stored: StoredFrames;
  try {
    const raw = sessionStorage.getItem(FRAMES_KEY);
    if (!raw) return;
    stored = JSON.parse(raw) as StoredFrames;
  } catch {
    return;
  }
  if (
    stored?.code !== code ||
    typeof stored.ts !== 'number' ||
    Date.now() - stored.ts > SESSION_TTL
  ) {
    clearStoredFrames();
    return;
  }
  frames.you = (stored.you ?? []).slice(0, TOTAL_FRAMES).map((v) => v ?? undefined);
  frames.them = (stored.them ?? []).slice(0, TOTAL_FRAMES).map((v) => v ?? undefined);
  if (
    Number.isInteger(stored.frameIndex) &&
    stored.frameIndex >= 0 &&
    stored.frameIndex < TOTAL_FRAMES
  ) {
    store.set({ frameIndex: stored.frameIndex });
  }
  paintRail();
}

interface CachedStrip {
  code: string | null;
  dataUrl: string;
  ts: number;
}

/**
 * Park the finished strip so `/strip` can show it again after a reload.
 *
 * The result screen normally lives inside a live session with a partner still
 * attached; this cache is what lets someone bookmark or share the URL of a
 * strip they already have, with no peer and no reconnection.
 */
async function cacheStrip() {
  try {
    const canvas = stripCanvas;
    if (!canvas) return;
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const payload: CachedStrip = {
      code: store.get().roomCode,
      dataUrl: await blobToDataUrl(blob),
      ts: Date.now(),
    };
    sessionStorage.setItem(STRIP_KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode — the strip just won't survive a reload */
  }
}

function readStripCache(): CachedStrip | null {
  try {
    const raw = sessionStorage.getItem(STRIP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedStrip;
    if (
      !parsed?.dataUrl ||
      typeof parsed.ts !== 'number' ||
      Date.now() - parsed.ts > SESSION_TTL
    ) {
      sessionStorage.removeItem(STRIP_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearStripCache() {
  try {
    sessionStorage.removeItem(STRIP_KEY);
  } catch {
    /* private mode */
  }
}

/** `/strip`: replay a strip this tab already developed, or say why we can't. */
function openSavedStrip() {
  const cached = readStripCache();
  if (!cached) {
    showError('strip-missing');
    return;
  }
  detachedStrip = cached.dataUrl;
  store.set({ screen: 'result', state: 'result', roomCode: cached.code, error: null });
  el.print.dataset.caption = `${cached.code ?? 'BOOTH'} · ${formatStripDate(new Date(cached.ts))}`;
  el.stripImg.src = cached.dataUrl;
}

function showResumeIfNeeded() {
  const record = sessionRecord();
  if (!record) {
    el.resume.hidden = true;
    return;
  }
  el.resumeCode.textContent = formatRoomCode(record.code);
  el.resume.hidden = false;
}

async function startCreateRoom() {
  store.set({ screen: 'create', state: 'creating-room', error: null });
  flagCopy('');
  el.createStatus.textContent = 'Printing your code…';
  el.roomCode.textContent = '····';
  el.createTimestamp.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  try {
    iceServers = await loadIceServers();
    const client = createSignalingClient();
    wireSignaling(client);
    signaling = client;
    const code = await client.createRoom();
    store.set({
      roomCode: code,
      role: client.role ?? 'host',
      signalingMode: client.mode,
      state: 'waiting-for-partner',
    });
    el.roomCode.textContent = formatRoomCode(code);
    el.createStatus.textContent = 'Waiting for your partner to walk in…';
    el.createTransport.textContent =
      client.mode === 'relay' ? 'Connected · over the internet' : 'Connected · same device';
    clearStoredFrames();
    saveSession(code, 'host');
    try {
      // The address is the product: putting it in the bar makes the code
      // shareable and a reload rejoin instead of printing a second booth.
      history.replaceState(null, '', `/room/${code}`);
    } catch {
      /* ignore */
    }
    maybeStartPeer();
  } catch (err) {
    signaling?.close();
    signaling = null;
    const kind = err instanceof SignalingError ? mapSignalingError(err.kind) : 'transport';
    showError(kind, () => void startCreateRoom());
  }
}

type JoinFailure = 'format' | 'not-found' | 'full' | 'taken';

/**
 * One place for every way a join can fail, so the copy stays honest about
 * *why* — a bad keystroke and a booth that simply isn't on this machine are
 * not the same problem.
 */
function joinFailureText(kind: JoinFailure): string {
  switch (kind) {
    case 'format':
      return 'That’s not a room code — four characters, no O, I or L.';
    case 'full':
      return 'This photobooth is already full.';
    case 'taken':
      return 'That code is taken — try another.';
    case 'not-found':
    default:
      return store.get().signalingMode === 'relay'
        ? 'No booth with that code right now — ask your partner to open it first.'
        : 'No booth with that code in this browser. You both need to open this page in the same browser.';
  }
}

async function submitJoin(codeInput: string) {
  const code = normalizeRoomCode(codeInput);
  el.joinMsg.textContent = '';

  if (!isValidRoomCode(code)) {
    el.joinMsg.textContent = joinFailureText('format');
    return false;
  }

  try {
    // Back → Join again on a room we're already in must not open a second
    // socket: the room would look full to ourselves.
    if (signaling?.roomCode === code) {
      store.set({ screen: 'permission', state: 'camera-permission', error: null });
      return true;
    }
    signaling?.close();
    signaling = null;

    iceServers = await loadIceServers();
    const client = createSignalingClient();
    wireSignaling(client);
    signaling = client;
    await client.joinRoom(code);
    store.set({
      roomCode: client.roomCode ?? code,
      role: client.role ?? 'guest',
      signalingMode: client.mode,
      screen: 'permission',
      state: 'camera-permission',
      error: null,
    });
    saveSession(client.roomCode ?? code, client.role ?? 'guest');
    restoreFrames(client.roomCode ?? code);
    try {
      history.replaceState(null, '', `/room/${client.roomCode ?? code}`);
    } catch {
      /* ignore */
    }
    maybeStartPeer();
    return true;
  } catch (err) {
    signaling?.close();
    signaling = null;
    if (err instanceof SignalingError) {
      if (err.kind === 'not-found' || err.kind === 'bad-code') {
        el.joinMsg.textContent = joinFailureText(err.kind === 'bad-code' ? 'format' : 'not-found');
        return false;
      }
      if (err.kind === 'full') {
        el.joinMsg.textContent = joinFailureText('full');
        return false;
      }
      if (err.kind === 'exists') {
        el.joinMsg.textContent = joinFailureText('taken');
        return false;
      }
      showError(mapSignalingError(err.kind), () => void submitJoin(code));
      return false;
    }
    showError('transport', () => void submitJoin(code));
    return false;
  }
}

async function resumeRoom() {
  const record = sessionRecord();
  if (!record) {
    showResumeIfNeeded();
    return;
  }
  const ok = await submitJoin(record.code);
  if (!ok) sessionStorage.removeItem(SESSION_KEY);
}

function mapSignalingError(kind: string): ErrorKind {
  switch (kind) {
    case 'not-found':
      return 'room-not-found';
    case 'full':
      return 'room-full';
    case 'bad-code':
      return 'bad-code';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'transport';
  }
}

/* ---------------------------------------------------------- signaling ---- */

function wireSignaling(client: SignalingClient) {
  client.onSignal((data) => {
    peerPresent = true;
    maybeStartPeer();
    peer?.handleSignal(data);
  });

  client.onPeerJoin(() => {
    peerPresent = true;
    refresh();
    maybeStartPeer();
    // Whatever card we ended up on, they are back — get in front of the booth.
    if (store.get().screen === 'error') recoverFromDisconnect();
    if (store.get().screen === 'create') el.createStatus.textContent = 'Your partner walked in ✓';
    store.set({ partnerLeft: false, error: null });
  });

  client.onPeerLeave(() => {
    partnerOut();
    if (store.get().screen === 'create') {
      el.createStatus.textContent = 'Waiting for your partner to walk in…';
    }
  });

  client.onError((kind) => showError(mapSignalingError(kind)));
}

function maybeStartPeer() {
  if (peer || !signaling?.roomCode || !signaling.role || !peerPresent) return;

  peer = new BoothPeer(
    signaling.role,
    {
      onState: handlePeerState,
      onRemoteStream: handleRemoteStream,
      onDataOpen: handleDataOpen,
      onDataClose: handleDataClose,
      onMessage: handleBoothMessage,
      onPhoto: handlePhoto,
      onClockSync: handleClockSync,
    },
    { iceServers: iceServers ?? undefined },
  );
  peer.onSignalOut = (payload) => signaling?.sendSignal(payload);

  if (localStream) peer.setLocalStream(localStream);

  armConnectWatchdog();
  store.set({ state: peerPresent ? 'connecting' : store.get().state });
}

/**
 * ICE that never completes doesn't fail loudly — it just sits in `Checking`
 * forever, which the booth reports as `Connecting` while both people stare at
 * a black partner pane. Give up after a while so the copy tells the truth.
 */
function armConnectWatchdog() {
  window.clearTimeout(connectWatchdog);
  connectWatchdog = window.setTimeout(() => {
    if (peerPresent && !dataOpen && store.get().screen === 'booth') {
      showError('transport', recoverFromDisconnect);
    }
  }, CONNECT_WATCHDOG);
}

function clearConnectWatchdog() {
  window.clearTimeout(connectWatchdog);
}

function recoverFromDisconnect() {
  peer?.close();
  peer = null;
  dataOpen = false;
  clearPartnerFeed();
  store.set({
    screen: 'booth',
    state: 'connecting',
    error: null,
    youReady: false,
    partnerReady: false,
    partnerCameraReady: false,
  });
  resetFrames();
  maybeStartPeer();
}

/**
 * The other side is gone — closed the tab, refreshed, or hit leave.
 *
 * The relay has already freed their slot, so the only thing left here is
 * forgetting them properly: drop the dead peer connection (otherwise
 * `maybeStartPeer` refuses to build a replacement and the rejoin goes
 * nowhere), and don't dress a departure up as a network fault. Captured
 * frames and your own ready flag survive — they come back to the same strip.
 */
function partnerOut() {
  peerPresent = false;
  dataOpen = false;
  peer?.close();
  peer = null;
  clearConnectWatchdog();
  clearPartnerFeed();
  stopCaptureTimers();
  const inBooth = store.get().screen === 'booth';
  store.set({
    partnerLeft: true,
    error: null,
    state: inBooth ? 'waiting-for-partner' : store.get().state,
    partnerReady: false,
    partnerCameraReady: false,
    receivingPhoto: false,
    retakeRequested: false,
    retakeWaiting: false,
  });
  refresh();
}

function handlePeerState(state: PeerState) {
  if (state === 'closed') {
    clearConnectWatchdog();
    clearPartnerFeed();
  }
  if (state === 'failed') {
    // Leaving is not a network fault. If we already know they're gone, the
    // honest copy is "waiting for your partner" — never "the booth is offline".
    if (!peerPresent) return;
    peer?.restartIce();
    // A restart deserves a fresh window, otherwise the original deadline
    // fires mid-recovery and we declare defeat early.
    armConnectWatchdog();
    window.setTimeout(() => {
      if (peerPresent && peer && peer.getState() === 'failed') {
        showError('transport', recoverFromDisconnect);
      }
    }, 8000);
  }
}

/** The partner is gone — blank their pane instead of holding the last frame. */
function clearPartnerFeed() {
  const video = el.videoPartner;
  if (video.srcObject) {
    video.pause();
    video.srcObject = null;
    video.load();
  }
  clearStill('them');
  el.camPartner.classList.remove('is-live', 'is-frozen');
  el.camPartner.classList.add('is-waiting');
  refreshGuides();
}

function handleRemoteStream(stream: MediaStream | null) {
  const video = el.videoPartner;
  if (!stream) {
    clearPartnerFeed();
    return;
  }

  video.srcObject = stream;
  el.camPartner.classList.add('is-live');
  el.camPartner.classList.remove('is-waiting');

  // A stream can end without the peer connection reporting a state change.
  const dropIfCurrent = () => {
    if (video.srcObject === stream) clearPartnerFeed();
  };
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', dropIfCurrent, { once: true });
  }
  stream.addEventListener('inactive', dropIfCurrent, { once: true });

  video.addEventListener('loadedmetadata', () => {
    void video.play().catch(() => undefined);
    refreshGuides();
  }, { once: true });
  void video.play().catch(() => undefined);
  refreshGuides();
}

function sendHello() {
  if (!peer?.isDataOpen()) return;
  const { cameraReady, session, frameIndex, screen, template, theme } = store.get();
  peer.send({
    t: 'hello',
    role: currentRole(),
    cameraReady,
    session,
    frame: frameIndex,
    done: screen === 'result',
    template,
    theme,
  });
}

function handleDataOpen() {
  dataOpen = true;
  clearConnectWatchdog();
  sendHello();
  // Anything sent before the channel opened was dropped — push it again now.
  if (store.get().youReady) setReady(true);
  refresh();
}

function handleDataClose() {
  dataOpen = false;
  clearPartnerFeed();
  refresh();
  if (store.get().screen === 'booth' && peerPresent) {
    el.hint.textContent = 'Reconnecting…';
  }
}

function handleClockSync() {
  if (!pendingCapture || captureFired) return;
  scheduleCapture(pendingCapture.frame, pendingCapture.targetAt, pendingCapture.initiator);
}

/**
 * Converge with a peer that has just (re)opened the channel.
 *
 * Both sides run this, so one rule has to settle every mismatch. A booth that
 * reloads mid-run comes back at frame 0 with fresh ready flags and no photos in
 * hand, and the `ready`/`capture`/`keep` guards all compare frame numbers — if
 * the two never agree again, the run silently stalls forever.
 */
function settleAfterHello(message: Extract<BoothMessage, { t: 'hello' }>) {
  const frame = Number.isFinite(message.frame) ? message.frame : 0;

  // They are already holding the finished strip: compose ours from the frames
  // we have rather than wait for a frame that will never be shot again.
  if (message.done && store.get().screen !== 'result') {
    void generateResult();
    return;
  }

  // …we are the ones holding it, and they are still in the booth.
  if (store.get().screen === 'result' && !message.done) {
    sendHello();
    return;
  }

  const current = store.get();

  if (frame > current.frameIndex) {
    // They are further along — move up to their frame. Anything shot before it
    // is already on both sides; anything lost with a reload shows up as a hole
    // in that booth's own strip, which beats waiting on a frame nobody will
    // replay.
    reviewTimer = clearTimer(reviewTimer);
    watchdog = clearTimer(watchdog);
    pendingIncomingCapture = null;
    captureFired = false;
    pendingCapture = null;
    hideReview();
    hideCountdown();
    store.set({ frameIndex: frame, state: 'ready', receivingPhoto: false, partnerReady: false });
    saveFrames();
    setReady(store.get().youReady);
    return;
  }

  if (frame < current.frameIndex) {
    // We are further along — rewind the frame we are on so we shoot it
    // together, instead of one side sitting in review while the other waits.
    restartFrame(current.frameIndex);
    store.set({ youReady: false, partnerReady: false });
    setReady(false);
    return;
  }

  // Same frame: re-announce readiness, since a reloaded tab has none yet while
  // the other may still believe it does.
  setReady(store.get().youReady);
}

/* ------------------------------------------------------ booth messages ---- */

function handleBoothMessage(message: BoothMessage) {
  const state = store.get();

  switch (message.t) {
    case 'hello': {
      const patch: Partial<AppState> = { partnerCameraReady: message.cameraReady };
      if (message.role === 'host' && message.session !== state.session) {
        patch.session = message.session;
      }
      // The host owns the style on handshake so two people arriving with
      // different saved choices settle on one immediately. After that either
      // side may restyle via `style`.
      if (message.role === 'host' && currentRole() === 'guest') {
        if (isTemplateId(message.template)) patch.template = message.template;
        if (isThemeId(message.theme)) patch.theme = message.theme;
      }
      store.set(patch);
      if (patch.template || patch.theme) {
        const next = store.get();
        saveStyle({ template: next.template, theme: next.theme });
        restyleStrip();
      }
      settleAfterHello(message);
      break;
    }

    case 'style': {
      if (!isTemplateId(message.template) || !isThemeId(message.theme)) break;
      applyStyle({ template: message.template, theme: message.theme }, false);
      break;
    }

    case 'camera': {
      if (message.session !== state.session) break;
      store.set({ partnerCameraReady: message.ready });
      break;
    }

    case 'ready': {
      if (message.session !== state.session || message.frame !== state.frameIndex) break;
      store.set({ partnerReady: message.value });
      break;
    }

    case 'capture': {
      if (message.session !== state.session) break;
      // The initiator may reach the next frame a hair before we do.
      if (message.frame > state.frameIndex) {
        pendingIncomingCapture = message;
        break;
      }
      if (message.frame !== state.frameIndex) break;
      if (captureFired) break;
      startIncomingCountdown(message.frame, message.targetAt, message.initiator);
      break;
    }

    case 'retake': {
      if (message.session !== state.session || message.frame !== state.frameIndex) break;
      reviewTimer = clearTimer(reviewTimer);
      if (retake.frame !== message.frame) {
        retake = { frame: message.frame, you: false, them: true };
      } else {
        retake.them = true;
      }
      if (!retake.you && state.state === 'photo-review') {
        el.retakeStatus.textContent = 'Your partner wants a retake…';
        el.retakeBtn.textContent = 'Yes — retake';
        el.retakeBtn.disabled = false;
      }
      maybeBeginRetake();
      break;
    }

    case 'keep': {
      if (message.session !== state.session || message.frame !== state.frameIndex) break;
      if (state.state !== 'photo-review') break;
      reviewTimer = clearTimer(reviewTimer);
      advanceFrame();
      break;
    }

    case 'reset': {
      store.set({ session: message.session });
      resetFrames();
      if (state.screen === 'result' || state.screen === 'booth') {
        store.set({ screen: 'booth', state: 'ready', error: null });
      }
      break;
    }

    case 'bye': {
      partnerOut();
      break;
    }

    default:
      break;
  }
}

/* ------------------------------------------------------------- camera ----- */

async function enableCamera() {
  el.permAction.disabled = true;
  el.permAction.textContent = 'Opening lens…';

  try {
    if (!isCameraSupported()) throw new CameraError('unsupported');
    const stream = await getCameraStream();
    localStream = stream;
    attachLocalStream(stream);

    store.set({ cameraReady: true, screen: 'booth', state: 'waiting-for-partner', error: null });
    el.permAction.disabled = false;
    el.permAction.textContent = 'Enable camera';
    resetFrames();

    if (peer) peer.setLocalStream(stream);
    if (peer?.isDataOpen()) {
      peer.send({ t: 'camera', ready: true, session: store.get().session });
    }
  } catch (err) {
    el.permAction.disabled = false;
    el.permAction.textContent = 'Try again';
    const kind =
      err instanceof CameraError
        ? err.kind === 'denied'
          ? 'camera-denied'
          : err.kind === 'unsupported'
            ? 'camera-unsupported'
            : 'camera-unavailable'
        : 'camera-unavailable';
    showPermissionError(kind);
  }
}

function showPermissionError(kind: ErrorKind) {
  const copy = COPY[kind];
  el.permLens.classList.add('is-error');
  el.permKicker.textContent = 'Lens check failed';
  el.permTitle.textContent = copy.title;
  el.permBody.textContent = copy.body;
  el.permAction.textContent = 'Try again';
}

function attachLocalStream(stream: MediaStream) {
  const video = el.videoYou;
  video.srcObject = stream;
  el.camYou.classList.add('is-live');
  video.addEventListener(
    'loadedmetadata',
    () => {
      void video.play().catch(() => undefined);
      refreshGuides();
    },
    { once: true },
  );
  void video.play().catch(() => undefined);

  stopWatchLocal?.();
  stopWatchLocal = watchStreamEnd(stream, () => {
    store.set({ cameraReady: false });
    el.camYou.classList.remove('is-live');
    showPermissionError('camera-denied');
    store.set({ screen: 'permission', state: 'camera-permission' });
  });
  refreshGuides();
}

function refreshGuides() {
  for (const [video, figure] of [
    [el.videoYou, el.camYou],
    [el.videoPartner, el.camPartner],
  ] as const) {
    const guide = figure.querySelector<HTMLElement>('.cam__guide');
    if (!guide) continue;
    const rect = figure.getBoundingClientRect();
    const computed = computeGuideRect(video, rect.width, rect.height, DEFAULT_CAPTURE);
    if (!computed) {
      guide.style.left = '';
      guide.style.top = '';
      guide.style.width = '';
      guide.style.height = '';
      continue;
    }
    guide.style.left = `${computed.left}px`;
    guide.style.top = `${computed.top}px`;
    guide.style.width = `${computed.width}px`;
    guide.style.height = `${computed.height}px`;
  }
}

/* -------------------------------------------------------------- ready ----- */

function setReady(value: boolean) {
  const state = store.get();
  store.set({ youReady: value });
  peer?.send({ t: 'ready', frame: state.frameIndex, value, session: state.session });
}

/* ----------------------------------------------------------- countdown ---- */

function primeAndCapture() {
  primeAudio();
  const state = store.get();
  if (state.state === 'countdown' || captureFired) return;
  if (!state.youReady || !state.partnerReady || !peer?.isDataOpen()) return;

  const initiator = currentRole();
  const targetAt = Date.now() + COUNTDOWN_LEAD;
  peer.requestClockSync();
  peer.send({ t: 'capture', frame: state.frameIndex, session: state.session, targetAt, initiator });
  beginCountdown(state.frameIndex, targetAt, initiator);
}

function startIncomingCountdown(frame: number, targetAt: number, initiator: Role) {
  if (store.get().state === 'countdown' || captureFired) return;
  beginCountdown(frame, targetAt, initiator);
}

function beginCountdown(frame: number, targetAt: number, initiator: Role) {
  reviewTimer = clearTimer(reviewTimer);
  if (pendingIncomingCapture && pendingIncomingCapture.frame <= frame) {
    pendingIncomingCapture = null;
  }
  hideReview();
  store.set({ state: 'countdown', frameIndex: frame, countdownNumber: 3 });
  el.countdown.hidden = false;
  el.countdownSub.textContent = '3 · 2 · 1 · flash';
  pendingCapture = { frame, targetAt, initiator };
  captureFired = false;
  lastCountdownNumber = -1;
  scheduleCapture(frame, targetAt, initiator);
}

function scheduleCapture(frame: number, targetAt: number, initiator: Role) {
  if (!peer || captureFired) return;
  const local = peer.localTargetFor(targetAt, initiator);
  const delay = Math.max(0, local - Date.now());

  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = setTimeout(() => fireCapture(frame), delay);

  const tick = () => {
    const remaining = local - Date.now();
    if (remaining <= -200) return;
    const number = Math.min(3, Math.max(0, Math.ceil(remaining / 1000)));
    if (number !== lastCountdownNumber) {
      lastCountdownNumber = number;
      setCountdownNumber(number);
    }
    countdownRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(countdownRaf);
  tick();
}

function setCountdownNumber(number: number) {
  if (number <= 0) {
    el.countdownNum.textContent = 'FLASH';
    el.countdownNum.classList.add('is-flash');
    return;
  }
  el.countdownNum.classList.remove('is-flash');
  el.countdownNum.textContent = String(number);
  // restart the keyframe
  el.countdownNum.style.animation = 'none';
  void el.countdownNum.offsetWidth;
  el.countdownNum.style.animation = '';
  playTick();
}

function hideCountdown() {
  el.countdown.hidden = true;
  el.countdownNum.classList.remove('is-flash');
  cancelAnimationFrame(countdownRaf);
}

async function fireCapture(frame: number) {
  if (captureFired) return;
  captureFired = true;
  pendingCapture = null;
  if (countdownTimer) clearTimeout(countdownTimer);
  cancelAnimationFrame(countdownRaf);

  const state = store.get();
  store.set({ state: 'capturing', countdownNumber: 0 });
  hideCountdown();

  el.flash.classList.remove('is-on');
  void el.flash.offsetWidth;
  el.flash.classList.add('is-on');
  playShutter();

  const video = el.videoYou;
  if (!video.videoWidth) {
    showError('camera-unavailable', () => store.set({ screen: 'booth', state: 'ready' }));
    return;
  }

  const canvas = captureFrame(video, DEFAULT_CAPTURE);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  frames.you[frame] = dataUrl;
  setStill('you', dataUrl);
  freeze('you');
  paintRail();
  saveFrames();

  store.set({ state: 'waiting-for-photo', receivingPhoto: false });

  try {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    await peer?.sendPhoto(
      { id: `${state.session}-${frame}-${Date.now()}`, frame, session: state.session, mime: blob.type },
      blob,
    );
  } catch {
    showError('photo-transfer', () => restartFrame(frame));
    return;
  }

  scheduleWatchdog(frame);
  maybeCompleteFrame(frame);
}

function scheduleWatchdog(frame: number) {
  watchdog = clearTimer(watchdog);
  watchdog = setTimeout(() => {
    if (frames.you[frame] && frames.them[frame]) return;
    showError('photo-transfer', () => restartFrame(frame));
  }, PHOTO_WATCHDOG);
}

async function handlePhoto(meta: PhotoTransferMeta, blob: Blob) {
  const state = store.get();
  if (meta.session !== state.session) return;
  if (meta.frame < 0 || meta.frame >= TOTAL_FRAMES) return;

  try {
    const dataUrl = await blobToDataUrl(blob);
    frames.them[meta.frame] = dataUrl;
    store.set({ receivingPhoto: false });
    // Freeze the partner's pane exactly like our own side does.
    if (store.get().frameIndex === meta.frame) {
      setStill('them', dataUrl);
      freeze('them');
    }
    paintRail();
    saveFrames();
    maybeCompleteFrame(meta.frame);
  } catch {
    showError('photo-transfer', () => restartFrame(meta.frame));
  }
}

function maybeCompleteFrame(frame: number) {
  const you = frames.you[frame];
  const them = frames.them[frame];
  if (!you || !them) {
    if (frames.you[frame] && !frames.them[frame]) store.set({ receivingPhoto: true });
    return;
  }

  // Frames behind the one we are on arrived as catch-up — reviewing them now
  // would yank the booth back to a frame both sides already shot.
  if (frame < store.get().frameIndex) return;

  // Both the local send and the remote receive can land on the same frame;
  // only the first one starts the review so timers never double up.
  const current = store.get();
  if (current.state === 'photo-review' && current.frameIndex === frame) return;

  watchdog = clearTimer(watchdog);
  reviewTimer = clearTimer(reviewTimer);
  store.set({ state: 'photo-review', receivingPhoto: false });
  showReview(frame, you, them);

  const isLast = frame >= TOTAL_FRAMES - 1;
  reviewTimer = setTimeout(
    () => {
      if (isLast) void generateResult();
      else advanceFrame();
    },
    isLast ? 1500 : REVIEW_HOLD,
  );
}

function showReview(frame: number, you: string, them: string) {
  if (retake.frame !== frame) retake = { frame: -1, you: false, them: false };
  const partnerAsked = retake.frame === frame && retake.them && !retake.you;
  el.reviewFrame.textContent = String(frame + 1).padStart(2, '0');
  el.reviewYou.src = you;
  el.reviewThem.src = them;
  el.retakeBtn.hidden = false;
  el.retakeBtn.disabled = false;
  el.retakeBtn.textContent = partnerAsked ? 'Yes — retake' : 'Retake';
  el.keepBtn.disabled = false;
  el.retakeStatus.textContent = partnerAsked ? 'Your partner wants a retake…' : '';
  el.reviewNext.textContent = `Next frame in 3`;
  el.review.hidden = false;

  let left = 3;
  const countdown = () => {
    left -= 1;
    if (left <= 0) {
      el.reviewNext.textContent = frame >= TOTAL_FRAMES - 1 ? 'Developing…' : 'Next frame';
      return;
    }
    el.reviewNext.textContent = `Next frame in ${left}`;
    retakeTimer = setTimeout(countdown, 1000);
  };
  retakeTimer = clearTimer(retakeTimer);
  retakeTimer = setTimeout(countdown, 1000);
}

function hideReview() {
  el.review.hidden = true;
  retakeTimer = clearTimer(retakeTimer);
}

function advanceFrame() {
  reviewTimer = clearTimer(reviewTimer);
  watchdog = clearTimer(watchdog);
  hideReview();
  clearStill('you');
  clearStill('them');
  const next = store.get().frameIndex + 1;
  if (next >= TOTAL_FRAMES) {
    void generateResult();
    return;
  }
  // Arm the next frame: without this the partner still considers the
  // previous frame "fired" and silently drops the incoming countdown.
  captureFired = false;
  pendingCapture = null;
  store.set({ frameIndex: next, state: 'ready', youReady: true, partnerReady: true });
  paintRail();
  saveFrames();

  const queued = pendingIncomingCapture;
  if (queued && queued.frame === next) {
    pendingIncomingCapture = null;
    startIncomingCountdown(queued.frame, queued.targetAt, queued.initiator);
  } else if (queued && queued.frame < next) {
    pendingIncomingCapture = null;
  }
}

/* -------------------------------------------------------------- retake ---- */

function requestRetake() {
  const state = store.get();
  if (state.state !== 'photo-review') return;
  const frame = state.frameIndex;
  reviewTimer = clearTimer(reviewTimer);
  retakeTimer = clearTimer(retakeTimer);

  const partnerAlreadyAsked = retake.frame === frame && retake.them;
  retake = { frame, you: true, them: partnerAlreadyAsked };
  el.retakeBtn.disabled = true;
  el.keepBtn.disabled = true;
  el.retakeStatus.textContent = 'Waiting for partner…';
  peer?.send({ t: 'retake', frame, session: state.session });
  maybeBeginRetake();
}

/** Hold is up, or the visitor would rather not wait: move on now and tell
 *  the partner so both sides advance on the same tick. */
function keepFrame() {
  const state = store.get();
  if (state.state !== 'photo-review') return;
  reviewTimer = clearTimer(reviewTimer);
  peer?.send({ t: 'keep', frame: state.frameIndex, session: state.session });
  advanceFrame();
}

function maybeBeginRetake() {
  if (retake.frame < 0 || !retake.you || !retake.them) return;
  const frame = retake.frame;
  retake = { frame: -1, you: false, them: false };
  retakeTimer = clearTimer(retakeTimer);
  el.retakeStatus.textContent = `Retaking frame ${String(frame + 1).padStart(2, '0')}…`;
  store.set({ retakeWaiting: true });
  retakeTimer = setTimeout(() => {
    store.set({ retakeWaiting: false });
    restartFrame(frame, true);
  }, RETAKE_DELAY);
}

function restartFrame(frame: number, autoCountdown = false) {
  reviewTimer = clearTimer(reviewTimer);
  watchdog = clearTimer(watchdog);
  countdownTimer = clearTimer(countdownTimer);
  cancelAnimationFrame(countdownRaf);
  pendingIncomingCapture = null;
  hideReview();
  hideCountdown();
  clearStill('you');
  clearStill('them');
  frames.you[frame] = undefined;
  frames.them[frame] = undefined;
  paintRail();
  captureFired = false;
  pendingCapture = null;
  store.set({ frameIndex: frame, state: 'ready', receivingPhoto: false });
  saveFrames();
  if (autoCountdown) window.setTimeout(() => primeAndCapture(), 350);
}

function resetFrames() {
  frames.you.length = 0;
  frames.them.length = 0;
  clearStoredFrames();
  clearStripCache();
  pendingIncomingCapture = null;
  retake = { frame: -1, you: false, them: false };
  clearStill('you');
  clearStill('them');
  hideReview();
  watchdog = clearTimer(watchdog);
  reviewTimer = clearTimer(reviewTimer);
  captureFired = false;
  pendingCapture = null;
  store.set({ frameIndex: 0, youReady: false, partnerReady: false, receivingPhoto: false });
  paintRail();
}

/* ------------------------------------------------------------ previews ---- */

function setStill(side: 'you' | 'them', src: string) {
  const figure = side === 'you' ? el.camYou : el.camPartner;
  let img = figure.querySelector<HTMLImageElement>('.cam__still');
  if (!img) {
    img = document.createElement('img');
    img.className = 'cam__still';
    img.alt = '';
    figure.appendChild(img);
  }
  img.src = src;
}

function clearStill(side: 'you' | 'them') {
  const figure = side === 'you' ? el.camYou : el.camPartner;
  figure.querySelector('.cam__still')?.remove();
}

function freeze(side: 'you' | 'them') {
  const figure = side === 'you' ? el.camYou : el.camPartner;
  figure.classList.remove('is-frozen');
  void figure.offsetWidth;
  figure.classList.add('is-frozen');
  window.setTimeout(() => figure.classList.remove('is-frozen'), 900);
}

function paintRail() {
  document.querySelectorAll<HTMLElement>('.rail__slot').forEach((slot) => {
    const frame = Number(slot.dataset.frame);
    const side = slot.dataset.slot === 'them' ? 'them' : 'you';
    const src = frames[side][frame];
    if (src) {
      slot.style.backgroundImage = `url(${src})`;
      slot.classList.add('is-filled');
    } else {
      slot.style.backgroundImage = '';
      slot.classList.remove('is-filled');
    }
  });
}

/* -------------------------------------------------------------- result ---- */

async function generateResult() {
  reviewTimer = clearTimer(reviewTimer);
  hideReview();
  clearStill('you');
  clearStill('them');
  store.set({ state: 'generating-result', screen: 'result' });

  try {
    await renderStrip(true);
    store.set({ state: 'result' });
    playChime();
    void cacheStrip();
    // The strip is a destination of its own: park the URL here so a reload,
    // a bookmark or a shared link brings it straight back.
    try {
      if (location.pathname !== '/strip') history.replaceState(null, '', '/strip');
    } catch {
      /* ignore */
    }
  } catch {
    showError('photo-transfer', () => store.set({ screen: 'booth', state: 'ready' }));
  }
}

/**
 * Rebuild the strip from the frames in hand using the current style.
 *
 * Composes are expensive and can overlap: a style change landing mid-paint used
 * to invalidate the very reveal the result screen was waiting on, leaving an
 * empty print and a chime. Queue them instead — every caller then sees its own
 * paint finish, and a failed paint never wedges the queue.
 */
function renderStrip(reveal: boolean): Promise<void> {
  const run = stripChain.then(() => paintStrip(reveal));
  stripChain = run.catch(() => undefined);
  return run;
}

async function paintStrip(reveal: boolean): Promise<void> {
  const state = store.get();
  const you = frames.you.slice(0, TOTAL_FRAMES).map((v) => v ?? '');
  const them = frames.them.slice(0, TOTAL_FRAMES).map((v) => v ?? '');
  const canvas = await composePhotostrip({
    frames: { you, them },
    roomCode: state.roomCode,
    dateLabel: formatStripDate(),
    title: 'PHOTOBOOTH',
    tagline: 'MAKE A MEMORY',
    style: { template: state.template, theme: state.theme },
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'),
  );

  stripCanvas = canvas;
  if (stripUrl) URL.revokeObjectURL(stripUrl);
  stripUrl = URL.createObjectURL(blob);

  el.print.dataset.caption = `${state.roomCode ?? 'BOOTH'} · ${formatStripDate()}`;
  if (reveal) {
    el.print.classList.remove('is-revealing');
    el.stripImg.onload = () => {
      el.stripImg.onload = null;
      void el.print.offsetWidth;
      el.print.classList.add('is-revealing');
    };
  } else {
    el.stripImg.onload = null;
  }
  el.stripImg.src = stripUrl;
}

/* ----------------------------------------------------------- strip style -- */

function setStylePanel(open: boolean, restoreFocus = false) {
  if (open === styleOpen) return;
  styleOpen = open;
  styleScreen = open ? store.get().screen : null;
  el.stylePanel.hidden = !open;
  document.querySelectorAll<HTMLElement>('[data-action="open-style"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', String(open));
  });
  if (open) {
    const target = el.stylePanel.querySelector<HTMLElement>('[aria-checked="true"]');
    (target ?? el.stylePanel.querySelector<HTMLElement>('[role="radio"]'))?.focus();
  } else if (restoreFocus) {
    // Only steal focus back when the person explicitly dismissed the panel —
    // clicking away should leave focus where they clicked.
    styleTrigger?.focus();
  }
}

/**
 * Adopt a new template and/or theme. `sync` is false for changes that arrived
 * from the partner — echoing them straight back would ping-pong forever.
 */
function applyStyle(patch: Partial<StripStyle>, sync = true) {
  const state = store.get();
  const template = isTemplateId(patch.template) ? patch.template : state.template;
  const theme = isThemeId(patch.theme) ? patch.theme : state.theme;
  if (template === state.template && theme === state.theme) return;

  store.set({ template, theme });
  saveStyle({ template, theme });
  if (sync) peer?.send({ t: 'style', template, theme });
  restyleStrip();
}

/** The strip only exists on the result screen — repaint it there, live. */
function restyleStrip() {
  if (store.get().screen !== 'result') return;
  if (stripRenderTimer) clearTimeout(stripRenderTimer);
  stripRenderTimer = setTimeout(() => {
    stripRenderTimer = undefined;
    if (store.get().screen !== 'result') return;
    void renderStrip(false).catch(() => undefined);
  }, 150);
}

async function downloadStrip() {
  const code = store.get().roomCode ?? 'strip';
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    if (stripCanvas) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        stripCanvas!.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'),
      );
      downloadBlob(blob, `photobooth-${code}-${stamp}.png`);
      return;
    }
    // Opened from `/strip`: there is no canvas, only what the cache holds.
    if (detachedStrip) {
      const blob = await (await fetch(detachedStrip)).blob();
      const ext = blob.type.includes('png') ? 'png' : 'jpg';
      downloadBlob(blob, `photobooth-${code}-${stamp}.${ext}`);
    }
  } catch {
    showError('photo-transfer');
  }
}

function takeAnother() {
  const nextSession = newSessionId();
  peer?.send({ t: 'reset', session: nextSession });
  store.set({ session: nextSession });
  detachedStrip = null;
  resetFrames();
  store.set({ screen: 'booth', state: 'ready', error: null });
  const code = store.get().roomCode;
  if (code) {
    try {
      history.replaceState(null, '', `/room/${code}`);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------ lifecycle --- */

async function copyCode() {
  const code = store.get().roomCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    flagCopy('Copied — paste it to your partner');
  } catch {
    selectCode();
  }
}

function flagCopy(message: string) {
  copyFlagTimer = clearTimer(copyFlagTimer);
  el.copyFlag.textContent = message;
  if (!message) return;
  copyFlagTimer = setTimeout(() => {
    el.copyFlag.textContent = '';
  }, 2600);
}

/** Clipboard write is blocked or unavailable: highlight the code so the
 *  visitor's own copy shortcut works, and tell them which key to press. */
function selectCode() {
  const range = document.createRange();
  range.selectNodeContents(el.roomCode);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  flagCopy(apple ? 'Selected — press ⌘C' : 'Selected — press Ctrl+C');
}

function toggleSound() {
  const muted = toggleMuted();
  el.soundBtn.setAttribute('aria-pressed', String(muted));
  el.soundBtn.setAttribute('aria-label', muted ? 'Unmute the shutter sound' : 'Mute the shutter sound');
  if (!muted) {
    primeAudio();
    playTick();
  }
}

/* --------------------------------------------------------------- wiring --- */

function handleAction(action: string, target: HTMLElement) {
  switch (action) {
    case 'back-home':
      goHome();
      break;
    case 'leave-session':
      leaveSession();
      break;
    case 'back-to-room':
      backToRoom();
      break;
    case 'resume-room':
      void resumeRoom();
      break;
    case 'copy-code':
      void copyCode();
      break;
    case 'enter-booth':
      primeAudio();
      roomScreen = store.get().screen === 'join' ? 'join' : 'create';
      store.set({ screen: 'permission', state: 'camera-permission' });
      break;
    case 'enable-camera':
      void enableCamera();
      break;
    case 'set-ready':
      primeAudio();
      setReady(true);
      break;
    case 'capture':
      primeAndCapture();
      break;
    case 'keep':
      keepFrame();
      break;
    case 'retake':
      requestRetake();
      break;
    case 'download':
      void downloadStrip();
      break;
    case 'take-another':
      takeAnother();
      break;
    case 'new-room':
      goHome();
      break;
    case 'open-style':
      styleTrigger = target;
      setStylePanel(!styleOpen, true);
      break;
    case 'close-style':
      setStylePanel(false, true);
      break;
    case 'set-template':
      applyStyle({ template: target.dataset.template as StripStyle['template'] });
      break;
    case 'set-theme':
      applyStyle({ theme: target.dataset.theme as StripStyle['theme'] });
      break;
    case 'error-action': {
      const retry = errorRetry;
      errorRetry = null;
      if (retry) retry();
      else goHome();
      break;
    }
    default:
      break;
  }
}

function wireEvents() {
  document.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!target || target.hasAttribute('disabled')) return;
    const action = target.dataset.action;
    if (action) handleAction(action, target);
  });

  el.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = el.roomInput.value;
    if (!isValidRoomCode(normalizeRoomCode(code))) {
      el.joinMsg.textContent = joinFailureText('format');
      return;
    }
    const submit = $('#join-submit') as HTMLButtonElement;
    submit.disabled = true;
    submit.textContent = 'Checking…';
    void submitJoin(code).finally(() => {
      submit.disabled = false;
      submit.textContent = 'Join room';
    });
  });

  el.roomInput.addEventListener('input', () => {
    el.roomInput.value = el.roomInput.value.toUpperCase();
    el.joinMsg.textContent = '';
  });

  el.soundBtn.addEventListener('click', toggleSound);

  // Radiogroups move with arrows: focus and selection travel together, so a
  // keyboard user never lands on a chip they didn't pick.
  el.stylePanel.addEventListener('keydown', (event) => {
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="radio"]');
    const group = current?.closest<HTMLElement>('[role="radiogroup"]');
    if (!current || !group) return;
    const items = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    const index = items.indexOf(current);
    if (index < 0) return;

    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next].click();
    items[next].focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !styleOpen) return;
    event.preventDefault();
    setStylePanel(false, true);
  });

  // Tapping anywhere that isn't the panel or its trigger dismisses it.
  document.addEventListener('click', (event) => {
    if (!styleOpen) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('#style-panel') || target?.closest('[data-action="open-style"]')) return;
    setStylePanel(false);
  });

  window.addEventListener('resize', refreshGuides);
  window.addEventListener('orientationchange', () => setTimeout(refreshGuides, 220));

  window.addEventListener('beforeunload', () => {
    peer?.send({ t: 'bye' });
    signaling?.leave();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshGuides();
    void el.videoYou.play().catch(() => undefined);
    void el.videoPartner.play().catch(() => undefined);
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => refreshGuides());
    observer.observe(el.camYou);
    observer.observe(el.camPartner);
  }
}

/** Which screen this URL opens on — `/` and `/room/:code` are join flows. */
function routeScreen(): 'landing' | 'create' | 'join' | 'strip' {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/create') return 'create';
  if (path === '/strip') return 'strip';
  if (path === '/room' || path.startsWith('/room/')) return 'join';
  return 'landing';
}

/** A code carried by `/room/:code`, or by the old `/?room=` links. */
function routeCode(): string {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const fromPath = path.startsWith('/room/') ? path.slice('/room/'.length) : '';
  const fromQuery = new URLSearchParams(location.search).get('room') ?? '';
  const code = normalizeRoomCode(fromPath || fromQuery);
  return isValidRoomCode(code) ? code : '';
}

function initialScreen() {
  const stamp = new Date();
  el.landingStamp.textContent = `${String(stamp.getDate()).padStart(2, '0')} ${String(
    stamp.getMonth() + 1,
  ).padStart(2, '0')} ${stamp.getFullYear()}`;

  if (!isCameraSupported() || !window.isSecureContext) {
    // Still render the landing page; the problem surfaces at the lens step.
    store.set({ screen: 'landing' });
  }

  showResumeIfNeeded();

  store.set({ signalingMode: signalingTransportUrl() ? 'relay' : 'local' });
  renderJoinHint();

  const route = routeScreen();
  const code = routeCode();

  if (route === 'create') {
    void startCreateRoom();
    return;
  }

  if (route === 'strip') {
    openSavedStrip();
    return;
  }

  if (route === 'join' || isValidRoomCode(code)) {
    store.set({ screen: 'join', state: 'joining-room' });
    if (isValidRoomCode(code)) {
      el.roomInput.value = formatRoomCode(code);
      setTimeout(() => $('#join-submit')?.focus(), 120);
    } else {
      setTimeout(() => el.roomInput.focus(), 120);
    }
  }
}

/** Tell people the local transport only reaches this browser *before* they fail. */
function renderJoinHint() {
  if (!el.joinHint) return;
  const rule = 'Letters and numbers — no O, I or L.';
  el.joinHint.textContent =
    store.get().signalingMode === 'relay'
      ? rule
      : `${rule} Local booths only reach this browser.`;
}

function boot() {
  if (typeof window === 'undefined') return;

  if (!('RTCPeerConnection' in window) || !isCameraSupported()) {
    store.subscribe(render);
    showError('unsupported');
    return;
  }

  wireEvents();
  store.subscribe(render);
  initialScreen();
}

boot();
