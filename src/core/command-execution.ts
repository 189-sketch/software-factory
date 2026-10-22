import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

let windowsRunner: Promise<string> | undefined;
async function ownedWindowsRunner(): Promise<string> {
  return windowsRunner ??= promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('../../runtime/service-windows.ps1', import.meta.url)), '-CompileOnly'],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' }).then(result => result.stdout.trim()).catch(cause => {
      windowsRunner = undefined;
      throw Object.assign(new Error('Windows command ownership runtime unavailable', { cause }), { code: 'FACTORY_AGENT_COMMAND_RUNTIME_UNAVAILABLE' });
    });
}

/** End the command tree before returning a timeout so recovery cannot overlap it. */
export async function executeCommand(program: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  const windows = process.platform === 'win32';
  const runner = windows ? await ownedWindowsRunner() : program;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stdout = '', stderr = '', bytes = 0, bufferExceeded = false;
    const child = spawn(runner, windows ? [program, ...args] : args, {
      cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32',
    });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
          if (error) child.kill('SIGKILL');
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) { if (!bufferExceeded) { bufferExceeded = true; stop(); } return; }
      if (stream === child.stdout) stdout += chunk;
      else stderr += chunk;
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr, killed: timedOut }));
    });
    if (!windows) child.once('exit', stop);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut && !bufferExceeded) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(timedOut
        ? `Command timed out after ${options.timeoutMs}ms: ${program}`
        : `Command exited ${code ?? signal}: ${program}`), {
        stdout, stderr, killed: timedOut, signal, code: bufferExceeded ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code ?? 1,
      }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref();
  });
}
