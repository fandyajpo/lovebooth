# Lovebooth

A remote two-person photobooth. Two cameras, one little memory.

Astro + TypeScript, no backend. Two people in different places join a room with a
four-character code, see each other live over WebRTC, count down together, and walk
away with a 4-frame photostrip composed entirely in the browser.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:4321 in two tabs (or two browsers) and run the flow end to end —
nothing else to configure.

| command | what it does |
| --- | --- |
| `npm run dev` | dev server, `host: true` |
| `npm run dev:host` | dev server reachable from other devices on your LAN |
| `npm run relay` | optional local signaling relay on `ws://localhost:8787` |
| `npm run build` / `npm run preview` | static production build / serve it |
| `npm run check` | TypeScript + Astro diagnostics |

## How the two tabs are connected

There is no server in the app. Signaling sits behind one interface,
`SignalingClient` in `src/lib/signaling.ts`, and two transports implement it:

- **BroadcastChannel (default).** Tabs on the same machine discover each other
  through `localStorage` + `BroadcastChannel`. Zero configuration, no process to run.
  The room receipt shows `Connected · same device`.
- **WebSocket relay (optional).** Point the app at any relay that speaks the
  small message protocol in `scripts/signaling-relay.mjs` and the same two tabs
  become two different machines. The receipt shows
  `Connected · over the internet`.

```bash
npm run relay                                              # terminal 1
PUBLIC_SIGNALING_URL=ws://localhost:8787 npm run dev       # terminal 2
```

`PUBLIC_SIGNALING_URL` is read once at build/dev time, so set it before starting
the server. See `.env.example`.

The relay only ever carries room membership and SDP/ICE blobs. It never sees
a pixel.

> Cameras need a secure context. `localhost` is fine over plain HTTP; for
> `--host` on a LAN address put it behind HTTPS or a tunnel.

## The flow

1. **Landing** → *Create a room* or *Join with a code*.
2. **Room** → four-character code (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, no
   `0/O/1/I/L`), copy button, live join status.
3. **Camera permission** → local `getUserMedia` only.
4. **Booth** → both cameras live, connection status, per-frame film rail, and one
   shared *I'm ready* / *Capture* control. Capture starts only when both sides are ready.
5. **Countdown** → host proposes an absolute wall-clock instant, both sides derive
   their own local offset from a ping/pong clock sync and flash on the same tick.
6. **Review** → the composed frame, with *Keep it* and *Retake*. A retake only
   happens when **both** people ask for one; either person can keep it.
7. **Result** → the 1200×1800 strip, PNG download, or *Take another* which issues a
   fresh session id so a stale frame from the previous run can never land.

Frames are carried between peers over an ordered, reliable WebRTC data channel in
16 KB chunks, not through the relay.

## Privacy

- Photos are captured to a canvas, shown as data URLs, and composed in the browser.
- They travel peer-to-peer over `RTCPeerConnection`. Nothing is uploaded, stored,
  or logged anywhere.
- The only network traffic the app generates outside the P2P connection is the
  signaling exchange described above.
- There is no account, no database, no analytics.

## Layout

```
src/
  pages/index.astro        entry, fonts, favicon
  components/              Photobooth shell + each screen/widget
  scripts/booth.ts         orchestrator: state ⇄ DOM, room, frames, review
  lib/
    signaling.ts           SignalingClient interface + 2 transports
    webrtc.ts              BoothPeer: negotiation, data channel, clock sync
    state.ts               state machine + store
    protocol.ts            typed messages between the two peers
    camera.ts              getUserMedia wrapper
    capture.ts             frame grab + guide geometry
    photostrip.ts          1200×1800 canvas composition + download
    sound.ts               ticks, shutter, chime
    room.ts                room-code generation
  styles/global.css        the whole visual system
scripts/signaling-relay.mjs  optional dev relay (not imported by the app)
```

## Visual system

Disposable-camera / photobooth-receipt: warm paper `#efe9dd`, ink `#14120e`, an
action red `#e8380d`, and a caution yellow `#f5b800`. Anton for display, Space Mono
for labels, Space Grotesk for body. Film grain over everything, scalloped receipt
edges on the result, and a flash that fires on every capture.

`prefers-reduced-motion` disables the animations, focus rings are always visible,
and status/countdown/review changes are announced through `aria-live`.

## Verification

`npm run check` reports 0 errors. The end-to-end flow (room create → join →
bad-code rejection → camera → WebRTC → ready → synchronized countdown → photo
transfer → retake consent → 4 frames → 1200×1800 strip → reset) has been exercised
headlessly against both signaling transports with zero console errors.
# lovebooth
