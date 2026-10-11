/* global console, URL */
// Checks the built site in dist/ (run after `vite build`):
// - a normal build must contain no demo code and no demo-only files;
// - a demo build (VITE_DEMO=1) must contain the demo.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const demo = process.env.VITE_DEMO === '1';

/** Text that only the demo's code contains (its storage key, error code and banner). */
const MARKERS = ['devspace-demo-state', 'not_available_in_demo', 'Demo with sample data'];
/** Files that belong to the demo's hosting only. */
const DEMO_FILES = ['_headers', '_redirects', 'demo'];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(js|html)$/.test(entry.name) ? [path] : [];
  });
}

if (!existsSync(dist)) {
  console.error('check-demo-build: dist/ is missing; run vite build first.');
  process.exit(1);
}

const text = files(dist).map((path) => readFileSync(path, 'utf8'));
const found = MARKERS.filter((marker) => text.some((content) => content.includes(marker)));
const demoFiles = DEMO_FILES.filter((name) => existsSync(join(dist, name)));

if (demo) {
  const missing = MARKERS.filter((marker) => !found.includes(marker));
  if (missing.length > 0) {
    console.error(`check-demo-build: the demo build is missing demo code (${missing.join(', ')}).`);
    process.exit(1);
  }
  console.log('check-demo-build: demo build contains the demo.');
} else {
  if (found.length > 0 || demoFiles.length > 0) {
    console.error(
      `check-demo-build: the normal build contains demo code or files: ${[...found, ...demoFiles].join(', ')}`,
    );
    process.exit(1);
  }
  console.log('check-demo-build: normal build contains no demo code.');
}
