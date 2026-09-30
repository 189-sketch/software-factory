import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../core/session-store.js';

test('SessionStore survives restart and stores only provider session bindings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sessions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = {
    implementation: { providerSessionId: 'private-id', backend: 'claude-code' as const,
      model: 'model', lastUsedAt: new Date().toISOString(), attempt: 2 },
  };
  const store = new SessionStore(root);
  assert.deepEqual(await store.load(48), {});
  await store.save(48, sessions);
  assert.deepEqual(await new SessionStore(root).load(48), sessions);
  const record = JSON.parse(await fs.readFile(path.join(root, 'sessions', '48.json'), 'utf8'));
  assert.deepEqual(Object.keys(record), ['providerSessions']);
  await assert.rejects(store.load(-1), /Invalid issue number/);
});
