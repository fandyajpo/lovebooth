/**
 * End-to-end verification for the two halves of "can these two devices talk".
 *
 *   npm run verify             relay protocol + a real two-device session
 *   npm run verify:protocol    relay protocol only (fast, no browser needed)
 *
 * Environment overrides:
 *   RELAY    signaling relay ws(s):// URL  (default ws://localhost:8787)
 *   ORIGIN   site origin for the session   (default http://localhost:4321)
 *   CHROME   Chrome executable path        (default the macOS install)
 *
 * The session half drives the flow from two pages. Serve ORIGIN from a
 * non-localhost host and it uses two isolated browser contexts — the same thing
 * two separate phones are — over the relay, asserting `/ice` was fetched. On
 * localhost the app correctly uses its BroadcastChannel transport instead, so
 * the two pages share one context and the `/ice` assertions are skipped.
 */

const RELAY = process.env.RELAY ?? 'ws://localhost:8787';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:4321';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (n) => console.log(`\n== ${n}`);

/* ------------------------------------------------------------ protocol -- */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = () => reject(new Error('ws closed before open'));
    ws.onopen = () => {
      ws.onclose = () => {};
      resolve({
        send: (o) => ws.send(JSON.stringify(o)),
        wait(pred, ms = 6000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout: ${pred.name || 'pred'}`)), ms);
            waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
          });
        },
        close: () => ws.close(),
      });
    };
  });
}

const http = (path, init) =>
  fetch(new URL(path, RELAY.replace(/^ws/, 'http')), init);

async function protocol() {
  section(`relay protocol · ${RELAY}`);

  const root = await http('/');
  check(root.status === 200, 'GET / → 200');

  const ice = await http('/ice');
  const body = await ice.json().catch(() => null);
  check(ice.status === 200, 'GET /ice → 200');
  check(ice.headers.get('access-control-allow-origin') === '*', '/ice sets CORS');
  check(Array.isArray(body?.iceServers) && body.iceServers.length > 0, 'iceServers is non-empty');
  check(typeof body?.source === 'string', 'ice has a source field');
  check(
    (body?.iceServers ?? []).every(
      (s) => Array.isArray(s.urls) || typeof s.urls === 'string' || typeof s.url === 'string',
    ),
    'every iceServer has urls',
  );
  check(
    !(body?.iceServers ?? []).some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /:53([/?]|$)/.test(u)),
    ),
    'no port-53 ice urls',
  );

  const pre = await http('/ice', { method: 'OPTIONS' });
  check(pre.status === 204, 'OPTIONS /ice → 204');

  const room = `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const a = await connect(RELAY);
  check((await a.wait((m) => m.t === 'welcome')).t === 'welcome', 'A gets welcome');
  a.send({ t: 'create', room });
  const created = await a.wait((m) => m.t === 'created' || m.t === 'error');
  check(created.t === 'created' && created.role === 'host', 'A creates a room');

  const b = await connect(RELAY);
  await b.wait((m) => m.t === 'welcome');
  b.send({ t: 'join', room });
  const joined = await b.wait((m) => m.t === 'joined' || m.t === 'error');
  check(joined.t === 'joined' && joined.role === 'guest', 'B joins as guest');
  check((await a.wait((m) => m.t === 'peer-joined')).t === 'peer-joined', 'A hears peer-joined');

  a.send({ t: 'signal', room, data: { k: 'offer', sdp: 'x' } });
  const sig = await b.wait((m) => m.t === 'signal');
  check(sig.data?.k === 'offer', 'signal relayed to B');

  const c = await connect(RELAY);
  await c.wait((m) => m.t === 'welcome');
  c.send({ t: 'join', room });
  const third = await c.wait((m) => m.t === 'error' || m.t === 'joined');
  check(third.t === 'error' && third.code === 'full', 'third peer refused (full)');

  a.send({ t: 'leave' });
  check((await b.wait((m) => m.t === 'peer-left')).t === 'peer-left', 'B hears peer-left');

  a.close();
  b.close();
  c.close();
}

/* -------------------------------------------------------------- session -- */

const settle = async (page) => {
  await page.waitForFunction(() => document.readyState !== 'loading', {
    polling: 250,
    timeout: 20000,
  });
  await new Promise((r) => setTimeout(r, 900));
};

const click = (page, sel) =>
  page.evaluate((s) => {
    const node = document.querySelector(s);
    if (!node) throw new Error(`missing ${s}`);
    node.click();
  }, sel);

const statusOf = (page) =>
  page.$eval('#connection-text', (n) => n.textContent?.trim() ?? '').catch(() => '<none>');

const hasPartnerFeed = (page) =>
  page.$eval('#video-partner', (v) => !!(v.srcObject && v.srcObject.getVideoTracks().length > 0));

async function session() {
  // localhost uses BroadcastChannel + localStorage, which do not cross browser
  // storage partitions — two isolated contexts there would be two separate
  // universes. Only the relay can introduce genuinely separate devices.
  const viaRelay = !/^https?:\/\/(localhost|127\.)/.test(ORIGIN);

  section(`session · ${ORIGIN} ${viaRelay ? '(two isolated contexts)' : '(one context)'}`);
  const puppeteer = (await import('puppeteer-core')).default;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
    ],
  });

  const iceSeen = { host: null, guest: null };
  const watch = (page, key) =>
    page.on('response', async (res) => {
      if (!res.url().endsWith('/ice')) return;
      try {
        iceSeen[key] = await res.json();
      } catch {
        /* ignore */
      }
    });

  try {
    const hostCtx = viaRelay ? await browser.createBrowserContext() : null;
    const guestCtx = viaRelay ? await browser.createBrowserContext() : null;
    const host = hostCtx ? await hostCtx.newPage() : await browser.newPage();
    const guest = guestCtx ? await guestCtx.newPage() : await browser.newPage();
    watch(host, 'host');
    watch(guest, 'guest');

    const errors = [];
    for (const [p, name] of [
      [host, 'host'],
      [guest, 'guest'],
    ]) {
      p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    }

    await host.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await settle(host);
    await click(host, '[data-action="create-room"]');
    await host.waitForFunction(
      () => {
        const n = document.querySelector('#room-code');
        return n && /^[A-Z0-9]{4}$/.test((n.textContent ?? '').replace(/[^A-Z0-9]/g, ''));
      },
      { polling: 250, timeout: 20000 },
    );
    const code = await host.$eval('#room-code', (n) =>
      (n.textContent ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    );
    await click(host, '[data-action="enter-booth"]');
    await settle(host);
    await click(host, '#perm-action');
    await host.waitForSelector('#screen-booth.is-active', { timeout: 20000 });

    await guest.goto(`${ORIGIN}/?room=${code}`, { waitUntil: 'domcontentloaded' });
    await settle(guest);
    await click(guest, '#join-submit');
    await guest.waitForSelector('#screen-permission.is-active', { timeout: 20000 });
    await click(guest, '#perm-action');
    await guest.waitForSelector('#screen-booth.is-active', { timeout: 20000 });

    const settled = async (page) => {
      await page.waitForFunction(
        () => {
          const t = document.querySelector('#connection-text')?.textContent?.trim() ?? '';
          const v = document.querySelector('#video-partner');
          return (
            t !== 'Connecting' &&
            t !== 'Connecting…' &&
            t !== 'Waiting for your partner' &&
            !!v?.srcObject
          );
        },
        { polling: 250, timeout: 45000 },
      );
    };
    await Promise.all([settled(host), settled(guest)]);

    const hs = await statusOf(host);
    const gs = await statusOf(guest);
    console.log(`  host status: "${hs}"`);
    console.log(`  guest status: "${gs}"`);
    check(hs !== 'Connecting' && hs !== 'Waiting for your partner', 'host left Connecting');
    check(gs !== 'Connecting' && gs !== 'Waiting for your partner', 'guest left Connecting');
    check(await hasPartnerFeed(host), 'host receives partner stream');
    check(await hasPartnerFeed(guest), 'guest receives partner stream');
    if (viaRelay) {
      check(iceSeen.host?.iceServers?.length > 0, 'host fetched /ice');
      check(iceSeen.guest?.iceServers?.length > 0, 'guest fetched /ice');
    } else {
      console.log('  skip  /ice (localhost uses BroadcastChannel, no relay)');
    }

    // one frame end to end: synchronized countdown, both captures, both transfers
    await click(host, '#ready-btn').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await click(guest, '#ready-btn').catch(() => undefined);
    await host.waitForSelector('#capture-btn:not([disabled])', { timeout: 20000 });
    await click(host, '#capture-btn');

    const nextFrame = (page) =>
      page.waitForFunction(
        () => (document.querySelector('#frame-value')?.textContent ?? '').trim() === '02',
        { polling: 250, timeout: 60000 },
      );
    await Promise.all([nextFrame(host), nextFrame(guest)]);
    check(true, 'frame 01 completed on both devices');

    const railFilled = await host.$$eval('.rail__slot', (slots) =>
      slots.filter((s) => (s.getAttribute('style') ?? '').includes('url(')).length,
    );
    console.log(`  rail slots with photos: ${railFilled}`);
    check(railFilled >= 2, 'both photos landed in the rail');
    check(errors.length === 0, `no page errors${errors.length ? ` → ${errors.join('; ')}` : ''}`);
  } finally {
    await browser.close();
  }
}

const args = process.argv.slice(2);
await protocol();
if (!args.includes('--protocol-only')) await session();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
