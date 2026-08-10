// Two things about the bulk endpoint hold only by construction, and both fail
// quietly rather than loudly. These tests hold them in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const api = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8');
const inbox = readFileSync(join(HERE, '..', '..', 'web', 'src', 'components', 'Inbox.jsx'), 'utf8');

test('/api/voicemails/bulk is matched before the single-item route', () => {
  // The single-item pattern reads any /api/voicemails/<word> as an id, "bulk"
  // included, so the literal route only wins by being declared first. Move it
  // below and every bulk request becomes "Voicemail not found".
  const idPattern = /const idMatch = (\/\^.*?\/)\.exec/.exec(api)?.[1];
  assert.ok(idPattern, 'could not find the single-item route pattern');

  const asRegex = new RegExp(idPattern.slice(1, -1));
  assert.ok(
    asRegex.test('/api/voicemails/bulk'),
    'the single-item pattern no longer shadows /api/voicemails/bulk — this test can go',
  );

  const bulkAt = api.indexOf("path === '/api/voicemails/bulk'");
  const idAt = api.indexOf('const idMatch =');
  assert.ok(bulkAt !== -1, 'the bulk route is gone');
  assert.ok(
    bulkAt < idAt,
    'the bulk route must be declared before the single-item route, or it is unreachable',
  );
});

test('every bulk action the app sends is one the Worker handles', () => {
  // A typo on either side is a 400 the user sees only after selecting
  // messages and pressing the button.
  const handled = new Set([...api.matchAll(/action === '(\w+)'/g)].map((m) => m[1]));
  const updates = /const UPDATES = \{([\s\S]*?)\n {4}\};/.exec(api)?.[1] ?? '';
  for (const m of updates.matchAll(/(\w+):\s*\[/g)) handled.add(m[1]);

  const sent = new Set([...inbox.matchAll(/bulk\('(\w+)'/g)].map((m) => m[1]));

  assert.ok(sent.size >= 5, `expected the app to use several bulk actions, found ${[...sent]}`);
  for (const action of sent) {
    assert.ok(handled.has(action), `the app sends "${action}", which the Worker does not handle`);
  }
});
