/**
 * End-to-end verification for the two halves of "can these two devices talk".
 *
 *   npm run verify             relay protocol + routes + a two-device session
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


/* --------------------------------------------------------------- style -- */

/**
 * Every template × theme must actually compose: right size, right paper colour,
 * and far more than one colour on the page (a flat fill means a dead render).
 */
async function styles() {
  section(`style · ${ORIGIN} · 3 templates × 4 themes`);
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [`--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`],
  });

  try {
    const page = await browser.newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));

    const swept = await page.evaluate(async () => {
      // The sweep imports the TypeScript source, which only a dev server's
      // Vite transform serves — a built/preview origin would 404 and take the
      // whole run down with an unhandled rejection.
      try {
        const probe = await fetch('/src/lib/photostrip.ts');
        if (!probe.ok) return null;
      } catch {
        return null;
      }
      const mod = await import('/src/lib/photostrip.ts');
      const swatch = (color) => {
        const c = document.createElement('canvas');
        c.width = 80;
        c.height = 52;
        const x = c.getContext('2d');
        x.fillStyle = color;
        x.fillRect(0, 0, 80, 52);
        x.fillStyle = '#ff0000';
        x.fillRect(0, 0, 40, 52);
        return c.toDataURL('image/png');
      };
      const you = ['#3366ff', '#33aa66', '#aa33cc', '#cc8800'].map(swatch);
      const them = ['#ff5533', '#33bbdd', '#8855ee', '#55aa22'].map(swatch);
      const out = [];
      for (const template of ['grid', 'film', 'hero']) {
        for (const theme of ['paper', 'noir', 'pop', 'mint']) {
          const canvas = await mod.composePhotostrip({
            frames: { you, them },
            roomCode: 'TEST',
            dateLabel: '01 JAN 2026',
            style: { template, theme },
          });
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const rgb = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
          const px = (x, y) => rgb(x, y).join(',');
          const distinct = new Set();
          for (let y = 0; y < canvas.height; y += 45) {
            for (let x = 0; x < canvas.width; x += 45) distinct.add(px(x, y));
          }
          // Mean colour of the title band vs the sheet behind it: if the two
          // are close the headline vanished (dark ink on a dark sheet, say).
          let title = [0, 0, 0];
          let n = 0;
          for (let y = 96; y < 140; y += 4) {
            for (let x = 380; x < 820; x += 4) {
              const c = rgb(x, y);
              title[0] += c[0];
              title[1] += c[1];
              title[2] += c[2];
              n += 1;
            }
          }
          title = title.map((v) => v / n);
          const sheet = rgb(4, 4);
          const titleGap = Math.hypot(
            title[0] - sheet[0],
            title[1] - sheet[1],
            title[2] - sheet[2],
          );
          out.push({
            template,
            theme,
            w: canvas.width,
            h: canvas.height,
            corner: px(4, 4),
            distinct: distinct.size,
            titleGap,
          });
        }
      }
      return out;
    });
    const rows = swept ?? [];

    if (rows.length) {
      const corners = new Set(rows.map((r) => r.corner));
      check(rows.length === 12, `all 12 combinations composed (${rows.length})`);
      check(
        rows.every((r) => r.w === 1200 && r.h === 1800),
        'every strip is 1200 × 1800',
      );
      check(
        rows.every((r) => r.distinct > 20),
        `every strip paints a real image (min distinct colours ${Math.min(...rows.map((r) => r.distinct))})`,
      );
      check(corners.size === 4, `each theme paints its own paper (${corners.size} distinct sheets)`);
      check(
        rows.every((r) => r.titleGap > 20),
        `the headline stays legible in every theme (min contrast ${Math.min(...rows.map((r) => r.titleGap)).toFixed(0)})`,
      );
    } else {
      console.log('  skip  compose sweep (this origin serves no /src transform)');
    }

    // The picker is on every screen, so it works from the landing page too.
    await click(page, '#style-btn');
    const opened = await page.$eval('#style-panel', (n) => !n.hidden);
    check(opened, 'style panel opens');
    await page.evaluate(() => document.querySelector('[data-template="film"]').click());
    await page.evaluate(() => document.querySelector('[data-theme="mint"]').click());
    const picked = await page.evaluate(() => ({
      template: document.querySelector('[aria-checked="true"][data-template]')?.dataset.template,
      theme: document.querySelector('[aria-checked="true"][data-theme]')?.dataset.theme,
      saved: localStorage.getItem('pb:style'),
    }));
    check(picked.template === 'film' && picked.theme === 'mint', 'chips move to the new choice');
    check(/"template":"film"/.test(picked.saved ?? ''), 'the choice is saved locally');

    await page.keyboard.press('Escape');
    const closed = await page.$eval('#style-panel', (n) => n.hidden);
    check(closed, 'Escape closes the panel');

    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 900));
    const after = await page.evaluate(() => ({
      template: document.querySelector('[aria-checked="true"][data-template]')?.dataset.template,
      theme: document.querySelector('[aria-checked="true"][data-theme]')?.dataset.theme,
    }));
    check(after.template === 'film' && after.theme === 'mint', 'the choice survives a reload');
  } finally {
    await browser.close();
  }
}

/* --------------------------------------------------------------- routes -- */

/**
 * Every route renders the same shell; what differs is which screen it opens on
 * and what the address bar says. `astro preview` doesn't apply the `/room/:code`
 * rewrite, so run this against the dev server.
 */
async function routes() {
  section(`routes · ${ORIGIN}`);
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [`--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`],
  });

  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const active = () =>
      page.$eval('.screen.is-active', (n) => n.id).catch(() => '<none>');
    const open = async (path) => {
      await page.goto(new URL(path, ORIGIN).href, { waitUntil: 'domcontentloaded' });
      await settle(page);
      return active();
    };

    check((await open('/')) === 'screen-landing', '/ opens on the landing page');
    check((await open('/room')) === 'screen-join', '/room opens on the join form');
    check((await open('/strip')) === 'screen-error', '/strip with nothing cached explains itself');

    await open('/room/TEST');
    const prefilled = await page.evaluate(() => ({
      screen: document.querySelector('.screen.is-active')?.id,
      code: document.querySelector('#room-input')?.value ?? '',
    }));
    check(prefilled.screen === 'screen-join', '/room/CODE serves the join form');
    check(
      prefilled.code.replace(/\s+/g, '') === 'TEST',
      `the code is prefilled (${prefilled.code || 'empty'})`,
    );

    await page.goto(`${ORIGIN}/?room=TEST`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    check(new URL(page.url()).pathname === '/room/TEST', `/?room= links redirect (${page.url()})`);

    // A strip this tab developed is still here after a reload.
    await page.goto(`${ORIGIN}/strip`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() =>
      sessionStorage.setItem(
        'pb:strip',
        JSON.stringify({
          code: 'TEST',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          ts: Date.now(),
        }),
      ),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    const replay = await page.evaluate(() => ({
      screen: document.querySelector('.screen.is-active')?.id,
      src: document.querySelector('#strip-img')?.getAttribute('src') ?? '',
      more: !document.querySelector('#take-another-btn')?.hidden,
      style: !document.querySelector('#result-style-btn')?.hidden,
    }));
    check(replay.screen === 'screen-result', '/strip replays a cached strip');
    check(replay.src.startsWith('data:image/'), 'the cached image is on screen');
    check(!replay.more && !replay.style, 'a replayed strip offers no re-shoot or live style');

    // Last, because it opens a room: creating one takes over the address bar.
    await page.goto(`${ORIGIN}/create`, { waitUntil: 'domcontentloaded' });
    check((await active()) === 'screen-create', '/create opens on the create card');
    await page.waitForFunction(
      () => {
        const n = document.querySelector('#room-code');
        return n && /^[A-Z0-9]{4}$/.test((n.textContent ?? '').replace(/[^A-Z0-9]/g, ''));
      },
      { polling: 250, timeout: 20000 },
    );
    const created = new URL(page.url()).pathname;
    check(/^\/room\/[A-Z0-9]{4}$/.test(created), `creating a room rewrites to ${created}`);

    check(errors.length === 0, `no page errors${errors.length ? ` → ${errors.join('; ')}` : ''}`);
  } finally {
    await browser.close();
  }
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
    // The landing call to action is a real link now, so it can be shared and
    // middle-clicked like the room code itself.
    await Promise.all([
      host.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      click(host, 'a[href="/create"]'),
    ]);
    // /create prints a code and immediately rewrites to /room/CODE, so the
    // address may already have moved on by the time we look.
    const landed = new URL(host.url()).pathname;
    check(
      /^\/(create|room\/[A-Z0-9]{4})$/.test(landed),
      `the create CTA leaves the landing page (${landed})`,
    );
    await settle(host);
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
    check(
      new URL(host.url()).pathname === `/room/${code}`,
      `the booth address is shareable (/room/${code})`,
    );
    await click(host, '[data-action="enter-booth"]');
    await settle(host);
    await click(host, '#perm-action');
    await host.waitForSelector('#screen-booth.is-active', { timeout: 20000 });

    await guest.goto(`${ORIGIN}/?room=${code}`, { waitUntil: 'domcontentloaded' });
    await settle(guest);
    check(
      new URL(guest.url()).pathname === `/room/${code}`,
      `/?room= links land on the room route (${guest.url()})`,
    );
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

    // --- strip style: one side picks, the other side follows -----------
    const pickStyle = (page, template, theme) =>
      page.evaluate(
        (t, h) => {
          document.querySelector(`[data-template="${t}"]`)?.click();
          document.querySelector(`[data-theme="${h}"]`)?.click();
        },
        template,
        theme,
      );
    const styleSeen = (page) =>
      page.evaluate(() => ({
        template: document.querySelector('[aria-checked="true"][data-template]')?.dataset.template,
        theme: document.querySelector('[aria-checked="true"][data-theme]')?.dataset.theme,
        panel: !document.querySelector('#style-panel')?.hidden,
      }));

    await click(host, '#style-btn');
    check((await styleSeen(host)).panel, 'style panel opens from the booth bar');
    await pickStyle(host, 'hero', 'noir');
    const hostStyle = await styleSeen(host);
    check(hostStyle.template === 'hero' && hostStyle.theme === 'noir', 'host chips report the pick');

    const guestStyle = await guest
      .waitForFunction(
        () =>
          document.querySelector('[aria-checked="true"][data-template]')?.dataset.template === 'hero' &&
          document.querySelector('[aria-checked="true"][data-theme]')?.dataset.theme === 'noir'
            ? true
            : null,
        { polling: 250, timeout: 15000 },
      )
      .then(() => styleSeen(guest))
      .catch(() => null);
    check(!!guestStyle, 'guest adopts the host template and theme');
    check(guestStyle?.panel === false, 'the choice does not force the panel open on the partner');

    await pickStyle(host, 'grid', 'paper');
    const backToDefault = await guest
      .waitForFunction(
        () =>
          document.querySelector('[aria-checked="true"][data-template]')?.dataset.template === 'grid' &&
          document.querySelector('[aria-checked="true"][data-theme]')?.dataset.theme === 'paper'
            ? true
            : null,
        { polling: 250, timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check(backToDefault, 'style changes travel both ways');
    await click(host, '#style-btn');
    check((await styleSeen(host)).panel === false, 'the panel closes again');

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

    // --- partner drops out, then comes back -----------------------------
    await guest.close();
    await host.waitForFunction(
      () =>
        (document.querySelector('#connection-text')?.textContent ?? '').trim() ===
        'Waiting for your partner',
      { polling: 250, timeout: 30000 },
    );
    // Long enough for an old bug: ICE failing on the dead peer, then an 8s
    // timer repainting the departure as "the booth is offline".
    await new Promise((r) => setTimeout(r, 10000));

    const leftStatus = await statusOf(host);
    const bounced = await host.$eval('#screen-error', (n) => n.classList.contains('is-active'));
    const leftHint = await host.$eval('#deck-hint', (n) => n.textContent ?? '');
    console.log(`  host after partner left: "${leftStatus}"`);
    check(leftStatus === 'Waiting for your partner', 'host waits, never reports an error');
    check(!bounced, 'host stays in the booth instead of an error card');
    check(/stepped out/.test(leftHint), 'hint explains how the partner comes back');

    const guest2 = viaRelay
      ? await (await browser.createBrowserContext()).newPage()
      : await browser.newPage();
    watch(guest2, 'guest');
    guest2.on('pageerror', (e) => errors.push(`guest2: ${e.message}`));
    await guest2.goto(`${ORIGIN}/?room=${code}`, { waitUntil: 'domcontentloaded' });
    await settle(guest2);
    await click(guest2, '#join-submit');
    await guest2.waitForSelector('#screen-permission.is-active', { timeout: 20000 });
    await click(guest2, '#perm-action');
    await guest2.waitForSelector('#screen-booth.is-active', { timeout: 20000 });

    await Promise.all([settled(host), settled(guest2)]);
    check(await hasPartnerFeed(host), 'host gets the partner stream back');
    check(await hasPartnerFeed(guest2), 'rejoined guest gets the partner stream back');
    const kept = await host.$$eval('.rail__slot', (slots) =>
      slots.filter((s) => (s.getAttribute('style') ?? '').includes('url(')).length,
    );
    check(kept >= railFilled, `captured frames survived the drop-out (${kept})`);

    // A reloaded booth comes back at frame 0 with its ready flags cleared;
    // `ready`/`capture`/`keep` all compare frame numbers, so the two sides
    // used to disagree forever and no further frame could ever be shot.
    const frameOf = (page) =>
      page.$eval('#frame-value', (n) => (n.textContent ?? '').trim()).catch(() => '');
    const agreed = await Promise.all([frameOf(host), frameOf(guest2)]);
    check(
      agreed[0] !== '' && agreed[0] === agreed[1],
      `both booths agree on frame ${agreed[0] || '?'} after the rejoin`,
    );

    await click(host, '#ready-btn').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await click(guest2, '#ready-btn').catch(() => undefined);
    await host.waitForSelector('#capture-btn:not([disabled])', { timeout: 20000 });
    await click(host, '#capture-btn');
    const following = String(Number(agreed[0] || '01') + 1).padStart(2, '0');
    const reaches = (page, want) =>
      page.waitForFunction(
        (target) => (document.querySelector('#frame-value')?.textContent ?? '').trim() === target,
        { polling: 250, timeout: 60000 },
        want,
      );
    await Promise.all([reaches(host, following), reaches(guest2, following)]);
    check(true, `frame ${following} completed after the rejoin`);

    // Keep shooting: the fourth frame has nowhere to go but the result screen,
    // which is a route of its own now.
    const shootAgain = async (next) => {
      await click(host, '#ready-btn').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      await click(guest2, '#ready-btn').catch(() => undefined);
      await host.waitForSelector('#capture-btn:not([disabled])', { timeout: 20000 });
      await click(host, '#capture-btn');
      await Promise.all([reaches(host, next), reaches(guest2, next)]);
      check(true, `frame ${next} completed`);
    };

    await shootAgain(String(Number(following) + 1).padStart(2, '0'));

    await click(host, '#ready-btn').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await click(guest2, '#ready-btn').catch(() => undefined);
    await host.waitForSelector('#capture-btn:not([disabled])', { timeout: 20000 });
    await click(host, '#capture-btn');
    // The result screen shows up while the strip is still being composed, so
    // wait for the compose to finish and the address to move with it.
    const developed = (page) =>
      page.waitForFunction(
        () =>
          location.pathname === '/strip' &&
          (document.querySelector('#strip-img')?.getAttribute('src') ?? '').startsWith('blob:'),
        { polling: 250, timeout: 90000 },
      );
    await Promise.all([developed(host), developed(guest2)]);
    check(new URL(host.url()).pathname === '/strip', `the strip has its own address (${host.url()})`);
    check(true, 'the strip is on screen');
    check(
      await host.$eval('#take-another-btn', (n) => !n.hidden),
      'a live strip still offers Take another',
    );

    check(errors.length === 0, `no page errors${errors.length ? ` → ${errors.join('; ')}` : ''}`);
  } finally {
    await browser.close();
  }
}

const args = process.argv.slice(2);
await protocol();
if (!args.includes('--protocol-only')) {
  await routes();
  await session();
  await styles();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
