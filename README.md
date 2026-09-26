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

Open http://localhost:4321 in two tabs and run the flow end to end — nothing to
configure. On the deployed site (or any non-`localhost` host) a second device just
opens the same URL and types the four-character code.

| command | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run dev:host` | dev server reachable from other devices on your LAN |
| `npm run build` / `npm run preview` | static production build / serve it (see routes below) |
| `npm run check` | TypeScript + Astro diagnostics |
| `npm run verify` | relay protocol + a real two-device session (see below) |
| `npm run verify:protocol` | relay protocol only — fast, no browser needed |
| `npm run relay` | run the signaling relay locally on `ws://localhost:8787` |
| `npm run relay:deploy` | push the signaling relay to Cloudflare |

## How the two devices are connected

There is no backend in the app itself. Signaling sits behind one interface,
`SignalingClient` in `src/lib/signaling.ts`, and two transports implement it:

- **WebSocket relay (default).** Used whenever the page is not served from a local
  hostname. The deployed relay is `relay/` — a Cloudflare Worker with a Durable
  Object per room — living at
  `wss://lovebooth-relay.fandyglitch3.workers.dev/`. Two phones on two networks
  find each other through it with zero configuration. The room receipt shows
  `Connected · over the internet`.
- **BroadcastChannel (localhost fallback).** Tabs on the same machine discover each
  other through `localStorage` + `BroadcastChannel`, so `npm run dev` needs no server
  at all. The receipt shows `Connected · same device`, and the join form warns that
  a local booth only reaches this browser.

`PUBLIC_SIGNALING_URL` overrides the relay for either mode; it is read once at
build/dev time, so set it before starting the server. See `.env.example`.

Both transports only carry room membership and SDP/ICE blobs. Photos travel
peer-to-peer over WebRTC and never touch a relay.

> Cameras need a secure context. `localhost` is fine over plain HTTP; for `--host`
> on a LAN address put it behind HTTPS or a tunnel.

## Getting through both networks (TURN)

Signaling only *introduces* the two devices. Whether they can then talk depends on
their NATs, and two phones on two different home networks frequently can't open a
direct path. When that happens the booth pairs, the room reaches the booth, and the
partner's pane just stays black under `Connecting` — because there is no route.

The fix is TURN: a relay for the media itself. It is only used as a last resort, so
it costs nothing on a LAN or any network that can connect directly.

- `GET /ice` on the relay Worker mints short-lived credentials from Cloudflare
  Realtime TURN and returns them as an `iceServers` array. The TURN key and its API
  token are Worker secrets — neither ever reaches the browser.
- `src/lib/ice.ts` fetches that before the peer connection is created, once per
  connection attempt, and falls back to STUN if the endpoint is unavailable.
- Cloudflare's free tier covers the first **1,000 GB** of egress per month.

One-time setup:

1. In the Cloudflare dashboard, create a **TURN key** (Realtime → TURN keys) and an
   **API token** that can generate credentials for it.
2. Give the Worker both values:

```bash
npx wrangler secret put TURN_KEY_ID     --config relay/wrangler.jsonc
npx wrangler secret put TURN_API_TOKEN  --config relay/wrangler.jsonc
npm run relay:deploy
```

Without those secrets `/ice` still answers — with STUN only — so the booth keeps
working exactly as before until you add them.

## The flow

1. **Landing** → *Create a room* or *Join with a code*.
2. **Room** → four-character code (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, no
   `0/O/1/I/L`), copy button, live join status.
3. **Camera permission** → local `getUserMedia` only.
4. **Booth** → both cameras live, connection status, per-frame film rail, and one
   shared *I'm ready* / *Capture* control. Capture starts only when both sides are ready.
5. **Countdown** → host proposes an absolute wall-clock instant, both sides derive
   their own local offset from a ping/pong clock sync and flash on the same tick.
   Underneath the numbers a **mission card** tells you both what to do with your
   face. It is derived from that shared instant (`lib/missions.ts`) rather than
   sent as its own message, so both booths print the same line with nothing new
   to agree on.
6. **Review** → the composed frame, with *Keep it* and *Retake*. A retake only
   happens when **both** people ask for one; either person can keep it.
7. **Result** → the 1200×1800 strip at `/strip`, a PNG download, and four choices
   that belong to the device that presses them: *Take another*, *Style*,
   *Back to the room* and *Exit*. None of them moves the partner. Start another
   strip and they are *invited* — a card on their own screen offering *Join them*
   or *Stay here* — never dragged along.

Capture always needs both sides ready, so the person who taps *Take another*
can only end up waiting in the booth: the session id and the frame number are
left untouched, which means whoever joins later lands on frame 01 with the same
session and nothing has to be renegotiated.

Frames are carried between peers over an ordered, reliable WebRTC data channel in
16 KB chunks, not through the relay.

## Routes

The app is a handful of routes that all render the same shell; only the screen
they open on and the address bar differ.

| route | opens on | notes |
| --- | --- | --- |
| `/` | landing | `/?room=CODE` redirects here to `/room/CODE` |
| `/create` | create a booth | creates a room, then rewrites to `/room/CODE` |
| `/room` | join form | pick a code by hand |
| `/room/CODE` | join form | code prefilled; shareable, reload-safe |
| `/strip` | result | replays a cached strip; without one it explains itself |

The address is the product: `/room/CODE` is what you paste to your partner, and it
survives a reload mid-run — the frames and the finished strip are cached in
`sessionStorage` (`pb:frames`, `pb:strip`).

The rewrite is wired twice, because dev and production serve differently:

- **dev** — a Vite plugin in `astro.config.mjs` rewrites `/room/:code` before Astro
  routes it.
- **production** — `vercel.json` does the same after the filesystem has been
  checked.

`npm run preview` applies neither, so `/room/CODE` 404s under `preview`; use the
dev server, or deploy. `npm run verify`'s `routes` section exercises this against
`ORIGIN` and expects the rewrite to work.

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
  pages/                 one route per page, all sharing layouts/Base.astro
    index.astro            /
    create.astro           /create
    room.astro             /room
    strip.astro            /strip
  layouts/Base.astro      head, shell, pre-boot screen selection
  components/              Photobooth shell + each screen/widget
  scripts/booth.ts         orchestrator: state ⇄ DOM, room, frames, review
  lib/
    signaling.ts           SignalingClient interface + 2 transports
    ice.ts                 fetches ICE/TURN servers from the relay
    webrtc.ts              BoothPeer: negotiation, data channel, clock sync
    state.ts               state machine + store
    protocol.ts            typed messages between the two peers
    camera.ts              getUserMedia wrapper
    capture.ts             frame grab + guide geometry
    photostrip.ts          1200×1800 canvas composition + download
    style.ts               strip templates, theme palettes, persistence
    missions.ts            the prompt shown under the countdown
    sound.ts               ticks, shutter, printer, chime
    room.ts                room-code generation
  styles/global.css        the whole visual system
astro.config.mjs           dev rewrite for /room/:code
vercel.json                production rewrite for /room/:code
relay/
  src/index.js             signaling relay + `GET /ice` (TURN credentials)
  wrangler.jsonc           deploy config
```

## Visual system

Disposable-camera / photobooth-receipt: warm paper `#efe9dd`, ink `#14120e`, an
action red `#e8380d`, and a caution yellow `#f5b800`. Anton for display, Space Mono
for labels, Space Grotesk for body. Film grain over everything, scalloped receipt
edges on the result, and a flash that fires on every capture.

`prefers-reduced-motion` disables the animations, focus rings are always visible,
and status/countdown/review changes are announced through `aria-live`.

## Strip style

The strip has two independent knobs, both picked from the *Style* panel in the
booth bar or on the result screen:

- **Template** — how the eight photos sit: `grid` (four rows, you and them),
  `film` (edge-to-edge contact sheet with a sprocket rail), or `hero` (the last
  instant large, the first three small).
- **Theme** — the palette the canvas paints with: `paper` (the house look),
  `noir`, `pop`, `mint`. The booth UI keeps its warm-paper skin; only the
  exported strip changes.

Both people compose the strip independently, so the choice rides the data
channel: `BoothMessage`'s `style` variant carries live changes and `hello`
carries the current one so a late or returning peer adopts it. The host wins on
handshake; after that it is last-write-wins. The pick is saved to
`localStorage['pb:style']` and re-rendered live while the result is on screen.

## Verification

`npm run check` reports 0 errors. `npm run verify` drives the real thing: the
signaling relay protocol, the routes (each opens on the right screen, `/room/CODE`
is shareable, a developed strip reappears at `/strip`), then a two-device session
across two isolated browser contexts — the same code path two separate phones take
— asserting that ICE servers were fetched, both partner streams arrived, a frame
transferred, both booths read the same mission under the countdown, and a
drop-out and rejoin mid-run agree on which frame is current.
From the strip onward it checks that *nothing either device presses moves the
other*: one walks away with *Take another*, the partner stays on their strip and
gets the invitation, taking it puts both back on an empty frame 01, and *Back to
the room* / *Exit* each move only the one who pressed them.
It also switches the strip style on one device and asserts the other follows,
then composes all twelve template × theme combinations and checks each renders
1200 × 1800 with its own paper colour.

```bash
npm run verify:protocol                          # relay only, ~5s, no browser
npm run verify                                   # + full session on localhost
RELAY=wss://lovebooth-relay.fandyglitch3.workers.dev \
ORIGIN=http://192.168.0.104:4321 npm run verify  # + session through the real relay
```

Serve `ORIGIN` from a non-localhost host to exercise `/ice` and the relay; on
localhost the app uses its BroadcastChannel transport instead, which the script
detects and skips those assertions for. Use your own LAN address — DHCP hands a
new one out often enough that the example above will go stale; check it with
`ipconfig getifaddr en0`.
