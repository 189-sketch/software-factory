import { normalizeStageId } from './pipeline-definition.mjs';

/** Runtime limits describe one invocation, never the lifetime of the pipeline. */
export function commandTimeoutPolicy(request, context = {}) {
  const words = request.program ? [request.program, ...(request.args ?? [])]
    : String(request.command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const program = String(words[0] ?? '').replace(/\\/g, '/').split('/').at(-1).replace(/\.(?:exe|cmd)$/, '');
  const args = words.slice(1);
  let profile = context.validationCommand ? 'validation' : 'command';
  if (['pytest', 'ctest', 'vitest', 'jest', 'playwright'].includes(program)
    || (['npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'make'].includes(program)
      && args.some(arg => /^(?:test|tests|e2e|check)(?:$|:)/.test(arg)))
    || (['python', 'python3'].includes(program) && args[0] === '-m' && args[1] === 'pytest')
    || (program === 'node' && args[0] !== '-e' && args.some(arg => arg === '--test' || /(?:^|\/)(?:test|tests|e2e)\/|(?:^|[./-])(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)))) profile = 'test';
  else if (['npm', 'pnpm', 'yarn', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'cmake', 'make'].includes(program)) {
    if (args.some(arg => /^(?:ci|install|restore)$/.test(arg))) profile = 'install';
    else if (args.some(arg => /^(?:build|compile|package)(?:$|:)/.test(arg))) profile = 'build';
    else if (args.some(arg => /^(?:lint|typecheck|format:check)$/.test(arg))) profile = 'check';
  }
  const ceiling = profile === 'command' ? context.commandTimeoutMs ?? 120000 : context.validationTimeoutMs ?? 1200000;
  const defaults = { command: ceiling, check: 300000, build: 600000, install: 600000, test: ceiling, validation: ceiling };
  const requested = Number(request.timeoutMs ?? defaults[profile]);
  return { profile, timeoutMs: Number.isFinite(requested) && requested > 0 ? Math.min(requested, ceiling) : Math.min(defaults[profile], ceiling) };
}

/** Only factory-owned failure records admit recovery of old needs-info checkpoints. */
export function commandTimeoutRecoveryStage(state) {
  if (!state || state.status === 'completed' || state.issue?.state === 'closed') return null;
  const failure = state.lastFailure;
  const legacy = failure?.class === 'ENVIRONMENT' && /command timed out after \d+ms/.test(failure.message ?? '')
    && String(state.error ?? state.wait?.note ?? '').includes('configured command execution budget exhausted');
  if (!legacy && failure?.class !== 'COMMAND_TIMEOUT') return null;
  if (!legacy && state.wait?.reason === 'blocked-operator') return null;
  return normalizeStageId(failure.stage);
}

export function commandRecoveryStage(state) {
  const timeoutStage = commandTimeoutRecoveryStage(state);
  if (timeoutStage) return timeoutStage;
  if (!state || state.status === 'completed' || state.issue?.state === 'closed' || state.wait?.reason === 'blocked-operator') return null;
  const failure = state.lastFailure;
  const legacy = failure?.class === 'ENVIRONMENT'
    && String(failure.message ?? '').startsWith('Implementation validation failed:')
    && String(state.error ?? '').startsWith('[failure-classifier] ENVIRONMENT:');
  return (legacy || failure?.class === 'VALIDATION_FAILED') && normalizeStageId(failure.stage) === 'implementation'
    ? 'implementation' : null;
}

export function commandTimeoutRetryPending(state, now = Date.now()) {
  return Boolean(commandRecoveryStage(state) && state.wait?.reason === 'runtime-retry'
    && Date.parse(state.wait.nextAttemptAt ?? '') > now);
}
