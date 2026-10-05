import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Keep the process-tree root alive until its owning worker closes the control pipe. */
export function superviseService(request) {
  const emit = value => { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(value)}\n`); };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const kill = () => {
      if (process.platform === 'win32') {
        // The target is this supervisor, never an agent-supplied or reused application PID.
        execFile('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error) { emit({ kind: 'cleanup-error', code: error.code }); process.exit(1); }
        });
      } else {
        try { process.kill(-process.pid, 'SIGKILL'); }
        catch (error) { emit({ kind: 'cleanup-error', code: error.code }); process.exit(1); }
      }
    };
    if (process.stdout.destroyed) kill();
    else process.stdout.write(`${JSON.stringify({ kind: 'stopping' })}\n`, kill);
  };
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.on('error', stop);
  const windows = process.platform === 'win32';
  const child = spawn(windows ? 'powershell.exe' : request.program,
    windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./service-windows.ps1', import.meta.url))] : request.argv, {
    cwd: request.cwd, env: windows ? { ...process.env, FACTORY_SERVICE_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64') } : process.env,
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('spawn', () => emit({ kind: 'spawned', pid: child.pid }));
  child.once('error', error => emit({ kind: 'spawn-error', code: error.code ?? 'SERVICE_SPAWN_FAILED' }));
  child.once('exit', (code, signal) => emit({ kind: 'exited', code, signal }));
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.on('data', chunk => emit({ kind: 'output', stream: name, text: String(chunk).slice(-4096) }));
  }
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  superviseService(JSON.parse(process.argv[2]));
}
