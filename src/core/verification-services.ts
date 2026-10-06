import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from './types.js';
import type { AgentTool } from './agent-runtime.js';
import { agentProcessEnvironment, assertSafeReadPath, confinedPath, resolveAgentProcess, validateAgentProcess } from './tools.js';

interface OwnedService {
  id: string;
  child: ChildProcess;
  closed: Promise<void>;
  url: string;
  cwd: string;
  applicationPid?: number;
  exited?: { code: number | null; signal: string | null };
  error?: string;
  stopping?: boolean;
  cleanupError?: boolean;
  log: string;
}
type ServiceReceipt = { id: string; kind: 'service-action'; passed: boolean; detail: Record<string, unknown> };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function redact(text: string): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key) && value && value.length >= 4) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

async function portInUse(url: URL): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) });
    const finish = (used: boolean) => { socket.destroy(); resolve(used); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true)); // Unknown is not permission to attach.
  });
}

/** Scoped to one verification run; readiness is environment evidence, never acceptance. */
export class VerificationServices {
  private services = new Map<string, OwnedService>();
  constructor(private context: AgentContext, private record: (receipt: ServiceReceipt) => void) {}

  tools(): AgentTool[] {
    return [{
      name: 'start_service',
      description: 'Start an owned application without a shell and wait for HTTP readiness. Args: {program,args,cwd?,url,timeoutMs?}. Discover the command/cwd from the repository. url must be credential-free numeric loopback HTTP. To allocate an unused port, use url http://127.0.0.1:0 and {port} in args. Existing listeners are rejected, not reused. Returns serviceId and actual url. A ready service is not a passing AC. Services are cleaned up when verification or its worker ends.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['program', 'args', 'url'], properties: {
        program: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' }, url: { type: 'string' }, timeoutMs: { type: 'number' },
      } },
      execute: args => this.start(args),
    }, {
      name: 'stop_service',
      description: 'Stop only a serviceId issued by start_service in this verification run, including its process tree. Args: {serviceId:string}. Never takes an arbitrary PID.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['serviceId'], properties: { serviceId: { type: 'string' } } },
      execute: async args => {
        if (Object.keys(args).some(key => key !== 'serviceId') || typeof args.serviceId !== 'string') throw new Error('Invalid service stop request');
        const service = this.services.get(args.serviceId);
        if (!service) throw new Error('Unknown serviceId in this verification run');
        const receipt = await this.stop(service);
        return { ...receipt, serviceId: service.id, stopped: true };
      },
    }];
  }

  private receipt(passed: boolean, detail: Record<string, unknown>): ServiceReceipt {
    const receipt: ServiceReceipt = { id: randomUUID(), kind: 'service-action', passed, detail };
    this.record(receipt);
    return receipt;
  }

  private async start(args: Record<string, unknown>) {
    if (process.env.FACTORY_TRUSTED_EXECUTION !== '1') throw new Error('Service execution requires FACTORY_TRUSTED_EXECUTION=1');
    if (Object.keys(args).some(key => !['program', 'args', 'cwd', 'url', 'timeoutMs'].includes(key))
      || typeof args.url !== 'string' || (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0))) {
      throw new Error('Invalid service start request');
    }
    const url = new URL(args.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error('Service readiness requires credential-free numeric loopback HTTP');
    }
    let request = validateAgentProcess(args);
    assertSafeReadPath(String(args.cwd ?? '.'));
    const cwd = await confinedPath(this.context.repo.workdir, String(args.cwd ?? '.'));
    if (url.port === '0') {
      if (!request.argv.some(value => value.includes('{port}'))) throw new Error('Dynamic service port requires {port} in args');
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, url.hostname.replace(/^\[|\]$/g, ''), resolve);
      });
      const address = reservation.address();
      if (!address || typeof address === 'string') throw new Error('Service port allocation failed');
      url.port = String(address.port);
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      request = validateAgentProcess({ ...args, args: request.argv.map(value => value.replaceAll('{port}', url.port)) });
    }
    if (await portInUse(url)) throw new Error('Service port is occupied; refusing to attach to an unrelated listener');
    request = await resolveAgentProcess(request.program, request.argv);
    const ceiling = this.context.commandTimeoutMs ?? 120_000;
    const timeoutMs = Math.min(Number(args.timeoutMs ?? 30_000), ceiling);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../runtime/service-supervisor.mjs', import.meta.url)), JSON.stringify({ ...request, cwd })], {
      cwd, env: agentProcessEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const service: OwnedService = { id: randomUUID(), child, url: url.href, cwd, log: '', closed: new Promise(resolve => child.once('close', () => resolve())) };
    child.once('error', error => { service.error = (error as NodeJS.ErrnoException).code ?? 'SERVICE_SUPERVISOR_FAILED'; });
    child.stdin!.on('error', error => { service.error = (error as NodeJS.ErrnoException).code ?? 'SERVICE_CONTROL_PIPE_FAILED'; });
    let buffer = '';
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.kind === 'spawned') service.applicationPid = message.pid;
        else if (message.kind === 'exited') service.exited = { code: message.code, signal: message.signal };
        else if (message.kind === 'output') service.log = (service.log + String(message.text)).slice(-8192);
        else if (message.kind === 'stopping') service.stopping = true;
        else if (message.kind === 'cleanup-error') { service.error = String(message.code); service.cleanupError = true; }
        else service.error = String(message.code ?? 'SERVICE_SUPERVISOR_FAILED');
      }
    });
    child.stderr!.on('data', chunk => { service.log = (service.log + String(chunk)).slice(-8192); });
    this.services.set(service.id, service);
    this.context.logger.info(`verification service starting id=${service.id} url=${service.url}`);
    const startedAt = Date.now();
    let lastHttpStatus: number | undefined;
    let lastConnectionError: string | undefined;
    try {
      while (Date.now() - startedAt < timeoutMs) {
        if (service.error || service.exited || child.exitCode !== null || child.signalCode !== null) throw new Error(service.error ?? 'SERVICE_EXITED_BEFORE_READY');
        if (service.applicationPid) {
          try {
            const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(1000, timeoutMs - (Date.now() - startedAt)))) });
            lastHttpStatus = response.status;
            await response.body?.cancel();
            if (response.status >= 200 && response.status < 400 && !service.exited) {
              const receipt = this.receipt(true, { action: 'start', serviceId: service.id, url: service.url, cwd, pid: service.applicationPid, httpStatus: response.status });
              this.context.logger.info(`verification service ready id=${service.id} url=${service.url}`);
              return { ...receipt, serviceId: service.id, url: service.url };
            }
          } catch (error) {
            // Connection refusal during startup is expected; retain the final observation for diagnosis.
            lastConnectionError = String((error as Error).message).slice(0, 500);
          }
        }
        await pause(Math.min(100, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      }
      throw new Error('SERVICE_READY_TIMEOUT');
    } catch (error) {
      const detail = { action: 'start', serviceId: service.id, url: service.url, cwd, error: String((error as Error).message),
        exitCode: service.exited?.code ?? null, signal: service.exited?.signal ?? null,
        lastHttpStatus: lastHttpStatus ?? null, lastConnectionError: lastConnectionError ? redact(lastConnectionError) : null, logTail: redact(service.log) };
      const receipt = this.receipt(false, detail);
      await this.stop(service);
      this.context.logger.warn(`verification service failed id=${service.id} error=${detail.error}`);
      return { ...receipt, serviceId: service.id, url: service.url, error: detail.error };
    }
  }

  private async stop(service: OwnedService): Promise<ServiceReceipt> {
    service.child.stdin!.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([service.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Owned verification service cleanup did not finish'), { code: 'FACTORY_VERIFY_SERVICE_CLEANUP_FAILED' })), 10_000);
      })]);
      if (service.cleanupError || (service.applicationPid && !service.stopping)) {
        throw Object.assign(new Error('Owned verification service cleanup is unconfirmed'), { code: 'FACTORY_VERIFY_SERVICE_CLEANUP_FAILED' });
      }
      const deadline = Date.now() + 2000;
      while (await portInUse(new URL(service.url))) {
        if (Date.now() >= deadline) throw Object.assign(new Error('Owned verification service listener remains after cleanup'), { code: 'FACTORY_VERIFY_SERVICE_CLEANUP_FAILED' });
        await pause(100);
      }
      this.services.delete(service.id);
      this.context.logger.info(`verification service stopped id=${service.id}`);
      return this.receipt(true, { action: 'stop', serviceId: service.id, url: service.url });
    } catch (error) {
      this.receipt(false, { action: 'stop', serviceId: service.id, url: service.url, error: 'SERVICE_CLEANUP_UNCONFIRMED' });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.services.values()].map(service => this.stop(service)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
