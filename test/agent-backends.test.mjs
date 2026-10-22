import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFactoryConfig } from '../runtime/factory-config.mjs';

test('agent backend defaults to the implemented CLI independently of isolation', () => {
  const config = resolveFactoryConfig({ env: { FACTORY_EXECUTION_ADAPTER: 'docker' } });
  assert.equal(config.agents.defaultBackend, 'claude-code');
  assert.equal(config.execution.adapter, 'docker');
});

test('role overrides select the supported backend and model without mutating defaults', () => {
  const config = resolveFactoryConfig({ env: {
    FACTORY_AGENT_BACKEND: 'claude-code',
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ implementation: { backend: 'claude-code', model: 'model-a' }, 'review-pr': 'claude-code' }),
  } });
  assert.equal(config.agents.defaultBackend, 'claude-code');
  assert.deepEqual(config.agents.overrides.implementation, { backend: 'claude-code', model: 'model-a' });
  assert.equal(config.agents.overrides['review-pr'].backend, 'claude-code');
  assert.ok(Object.isFrozen(config.agents.overrides.implementation));
});

test('backend configuration fails early on typos and malformed overrides', () => {
  for (const env of [
    { FACTORY_AGENT_BACKEND: 'codxe' },
    { FACTORY_AGENT_BACKEND: 'codex-cli' },
    { FACTORY_AGENT_BACKEND: 'pi-cli' },
    { FACTORY_AGENT_BACKEND: 'typesafe' },
    { FACTORY_AGENT_BACKEND: 'embedded' },
    { FACTORY_AGENT_OVERRIDES: '{' },
    { FACTORY_AGENT_OVERRIDES: '{"review":"claude-code"}' },
    { FACTORY_AGENT_OVERRIDES: '{"review-pr":"codex-cli"}' },
    { FACTORY_AGENT_OVERRIDES: '{"implementation":{"backend":"codex-cli","arguments":["--unsafe"]}}' },
    { FACTORY_AGENT_TIMEOUT_MS: '0' },
  ]) assert.throws(() => resolveFactoryConfig({ env }), /FACTORY_AGENT/);
});

test('the agent content stream is on by default and configurable', () => {
  const config = resolveFactoryConfig({ env: {} });
  assert.equal(config.agents.stream.mode, 'on');
  assert.equal(config.agents.stream.dir, '');
  assert.equal(config.agents.stream.maxBytes, 8 * 1024 * 1024);

  const configured = resolveFactoryConfig({ env: {
    FACTORY_AGENT_STREAM: 'full',
    FACTORY_AGENT_STREAM_DIR: 'transcripts',
    FACTORY_AGENT_STREAM_MAX_BYTES: '1024',
  } });
  assert.equal(configured.agents.stream.mode, 'full');
  assert.match(configured.agents.stream.dir, /transcripts$/);
  assert.equal(configured.agents.stream.maxBytes, 1024);

  assert.equal(resolveFactoryConfig({ env: { FACTORY_AGENT_STREAM: 'off' } }).agents.stream.mode, 'off');
  assert.equal(resolveFactoryConfig({ env: { FACTORY_AGENT_STREAM: ' ON ' } }).agents.stream.mode, 'on');
});

test('an invalid content stream mode fails early instead of silently dropping the transcript', () => {
  for (const env of [
    { FACTORY_AGENT_STREAM: 'verbose' },
    { FACTORY_AGENT_STREAM: 'true' },
    { FACTORY_AGENT_STREAM_MAX_BYTES: '-1' },
    { FACTORY_AGENT_STREAM_MAX_BYTES: '1.5' },
  ]) assert.throws(() => resolveFactoryConfig({ env }), /FACTORY_AGENT_STREAM/);
});
