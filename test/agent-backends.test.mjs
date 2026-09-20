import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFactoryConfig } from '../runtime/factory-config.mjs';

test('agent backend defaults preserve embedded execution independently of isolation', () => {
  const config = resolveFactoryConfig({ env: { FACTORY_EXECUTION_ADAPTER: 'docker' } });
  assert.equal(config.agents.defaultBackend, 'embedded');
  assert.equal(config.execution.adapter, 'docker');
});

test('role overrides select backend and model without mutating defaults', () => {
  const config = resolveFactoryConfig({ env: {
    FACTORY_AGENT_BACKEND: 'pi-cli',
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ implementation: { backend: 'codex-cli', model: 'model-a' }, 'review-pr': 'claude-code' }),
  } });
  assert.equal(config.agents.defaultBackend, 'pi-cli');
  assert.deepEqual(config.agents.overrides.implementation, { backend: 'codex-cli', model: 'model-a' });
  assert.equal(config.agents.overrides['review-pr'].backend, 'claude-code');
  assert.ok(Object.isFrozen(config.agents.overrides.implementation));
});

test('backend configuration fails early on typos and malformed overrides', () => {
  for (const env of [
    { FACTORY_AGENT_BACKEND: 'codxe' },
    { FACTORY_AGENT_OVERRIDES: '{' },
    { FACTORY_AGENT_OVERRIDES: '{"review":"codex-cli"}' },
    { FACTORY_AGENT_OVERRIDES: '{"implementation":{"backend":"codex-cli","arguments":["--unsafe"]}}' },
    { FACTORY_AGENT_TIMEOUT_MS: '0' },
  ]) assert.throws(() => resolveFactoryConfig({ env }), /FACTORY_AGENT/);
});
