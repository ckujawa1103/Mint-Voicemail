// The Worker serves the web app and the API from one origin. That is what
// removes GitHub Pages, CORS, and the WebAuthn RP-ID mismatch from setup — but
// it puts the static asset server in front of the Worker, and the asset server
// answers anything it isn't told to skip. With
// `not_found_handling = "single-page-application"` an unlisted route doesn't
// 404, it returns index.html with a 200. Twilio would see HTML where it
// expected TwiML, and the app would see HTML where it expected JSON.
//
// So `run_worker_first` in the template has to stay in step with the routes in
// src/index.js. These tests hold those two files together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(HERE, '..', 'wrangler.template.toml'), 'utf8');
const entry = readFileSync(join(HERE, '..', 'src', 'index.js'), 'utf8');
const installer = readFileSync(join(HERE, '..', '..', 'scripts', 'install.mjs'), 'utf8');

const runWorkerFirst = JSON.parse(
  /run_worker_first\s*=\s*(\[[^\]]*\])/.exec(template)[1].replaceAll("'", '"'),
);

// "/api/*" -> matches "/api/" plus anything.
const matches = (pattern, path) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(path);

const servedByWorker = (path) => runWorkerFirst.some((p) => matches(p, path));

test('every prefix the Worker claims is routed to the Worker', () => {
  const prefixes = [...entry.matchAll(/path\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(prefixes.length >= 3, 'expected to find the /twilio/, /auth/ and /api/ prefixes');

  for (const prefix of prefixes) {
    assert.ok(
      servedByWorker(`${prefix}anything`),
      `${prefix}* is handled by the Worker but not listed in run_worker_first, so the ` +
        'asset server would answer it with index.html',
    );
  }
});

test('every exact path the Worker claims is routed to the Worker', () => {
  const paths = [...entry.matchAll(/path === '([^']+)'/g)]
    .map((m) => m[1])
    // "/" is deliberately left to the asset server: on a single origin the
    // root is the app, and the health JSON stays available at /health.
    .filter((p) => p !== '/');

  assert.ok(paths.includes('/health'), 'expected a /health route in the Worker');

  for (const path of paths) {
    assert.ok(
      servedByWorker(path),
      `${path} is handled by the Worker but not listed in run_worker_first`,
    );
  }
});

test('the asset config the single-origin design depends on is present', () => {
  assert.match(template, /\[assets\]/);
  assert.match(template, /directory\s*=\s*"\.\.\/web\/dist"/);
  assert.match(template, /not_found_handling\s*=\s*"single-page-application"/);
});

test('the installer fills in every placeholder the template declares', () => {
  const declared = new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  const filled = new Set([...installer.matchAll(/replaceAll\('\{\{(\w+)\}\}'/g)].map((m) => m[1]));

  assert.ok(declared.size > 0, 'expected the template to declare placeholders');
  for (const name of declared) {
    assert.ok(filled.has(name), `{{${name}}} would be deployed literally: the installer never replaces it`);
  }
  for (const name of filled) {
    assert.ok(declared.has(name), `the installer replaces {{${name}}}, which the template no longer declares`);
  }
});
