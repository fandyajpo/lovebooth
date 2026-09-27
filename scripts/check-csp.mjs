/**
 * Fail the build when vercel.json's Content-Security-Policy no longer matches
 * the inline scripts Astro actually emitted.
 *
 * The two scripts that must run before first paint (the deep-link redirect and
 * the pre-boot screen picker) stay inline on purpose — moving them out would
 * cost a render-blocking round trip. CSP therefore allows them by hash, which
 * means editing either one silently breaks the site unless something checks.
 * That something runs right after `astro build`, so a stale hash can never
 * reach a deployment.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const emitted = new Set();
for (const file of walk(dist).filter((path) => path.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    emitted.add(`'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`);
  }
}

const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const header = (config.headers ?? [])
  .flatMap((entry) => entry.headers ?? [])
  .find((item) => item.key === 'Content-Security-Policy')?.value;

if (!header) {
  console.error('check-csp: vercel.json has no Content-Security-Policy header');
  process.exit(1);
}

const declared = new Set(header.match(/'sha256-[^']+'/g) ?? []);
const stale = [...declared].filter((hash) => !emitted.has(hash));
const missing = [...emitted].filter((hash) => !declared.has(hash));

if (stale.length === 0 && missing.length === 0) {
  console.log(`check-csp: ${emitted.size} inline script hash(es) match the header`);
  process.exit(0);
}

console.error('check-csp: the CSP in vercel.json no longer matches the build.');
if (stale.length) console.error(`  no longer emitted: ${stale.join(', ')}`);
if (missing.length) console.error(`  emitted but not allowed: ${missing.join(', ')}`);
console.error('  Replace the script-src hashes with:');
console.error(`  ${[...emitted].join(' ')}`);
console.error(`  (from ${relative(root, join(dist, 'index.html'))} and its siblings)`);
process.exit(1);
