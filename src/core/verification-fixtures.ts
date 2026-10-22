import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { confinedPath, assertSafeReadPath } from './tools.js';
import { readOptionalJson, writeDurableJson, removeOptionalFile } from '../../runtime/durable-json.mjs';
import type { AgentContext } from './types.js';
import type { AgentTool } from './agent-runtime.js';

type Entry = { path: string; hash: string; archive: string };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

/** Owned, archived test fixtures; product files never need shell redirection. */
export class VerificationFixtures {
  private entries: Entry[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly journal: string;
  constructor(private ctx: AgentContext, private archive: string) {
    this.journal = path.join(path.dirname(archive), 'active-fixtures.json');
  }

  async recover(): Promise<void> {
    try {
      const saved = await readOptionalJson(this.journal);
      if (!saved) return;
      if (saved.issue !== this.ctx.issue.number || !Array.isArray(saved.entries)) throw new Error('Invalid verification fixture journal');
      this.entries = saved.entries as Entry[];
      await this.close();
    } catch (cause) { throw this.unavailable(cause); }
  }

  tool(): AgentTool {
    return {
      name: 'write_acceptance_fixture',
      description: 'Create or update a temporary acceptance test without shell quoting. Args: {directory:string,name:string,content:string}. directory is an existing repository-relative test directory; name is a filename such as persistence.test.tsx. The returned path has a run-owned prefix: use that exact path when executing the test. Only files created by this tool may be updated. Source is archived and unchanged temporary files are removed after verification. Never use shell redirection or node -e to write test files. This write is setup, not passing acceptance evidence.',
      inputSchema: { type:'object', additionalProperties:false, required:['directory','name','content'], properties: {
        directory:{type:'string'}, name:{type:'string'}, content:{type:'string'},
      } },
      execute: args => {
        const task = this.pending.then(() => this.write(args));
        this.pending = task.catch(() => {});
        return task;
      },
    };
  }

  private async write(args: Record<string, unknown>) {
    if (typeof args.directory !== 'string' || typeof args.name !== 'string' || typeof args.content !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(args.name) || !/^[a-zA-Z0-9_-]+$/.test(this.ctx.runId)) throw new Error('Use directory, filename and literal content for the acceptance fixture');
    const relative = path.join(args.directory, `factory-acceptance-${this.ctx.runId}-${args.name}`);
    assertSafeReadPath(relative);
    const file = await confinedPath(this.ctx.repo.workdir, relative);
    if (!(await fs.stat(path.dirname(file))).isDirectory()) throw new Error('Acceptance test directory does not exist');
    const previous = this.entries.find(entry => entry.path === relative);
    if (previous && hash(await fs.readFile(file, 'utf8')) !== previous.hash) throw this.conflict(relative);
    if (!previous) {
      try { await fs.lstat(file); throw new Error('Acceptance fixture already exists; choose another name'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const digest = hash(args.content);
    const archive = path.join(this.archive, 'fixtures', `${digest}-${args.name}`);
    await fs.mkdir(path.dirname(archive), {recursive:true});
    await fs.writeFile(archive, args.content, 'utf8');
    // Persist ownership before creation so an interrupted worker can clean up on resume.
    const entry = {path:relative, hash:digest, archive};
    this.entries = [...this.entries.filter(item => item.path !== relative), entry];
    await writeDurableJson(this.journal, {issue:this.ctx.issue.number, entries:this.entries});
    await fs.writeFile(file, args.content, {encoding:'utf8', flag:previous ? 'w' : 'wx'});
    return {path:relative.replace(/\\/g,'/'), sourceHash:digest, archive, acceptanceEvidence:false};
  }

  async sources(args: Record<string, unknown>) {
    if (!Array.isArray(args.args)) return [];
    const argv = args.args;
    const cwd = await confinedPath(this.ctx.repo.workdir,String(args.cwd ?? '.'));
    const referenced = this.entries.filter(entry => argv.some((arg: unknown) => typeof arg === 'string'
      && path.resolve(cwd,arg) === path.resolve(this.ctx.repo.workdir,entry.path)));
    return Promise.all(referenced.map(async entry => {
      const content = await fs.readFile(await confinedPath(this.ctx.repo.workdir,entry.path),'utf8');
      if (hash(content) !== entry.hash) throw this.conflict(entry.path);
      return {path:entry.path,sourceHash:entry.hash,content};
    }));
  }

  async close(): Promise<void> {
    try { await this.cleanup(); }
    catch (cause) { throw this.unavailable(cause); }
  }

  private async cleanup(): Promise<void> {
    await this.pending;
    for (const entry of this.entries) {
      if (typeof entry.path !== 'string' || !path.basename(entry.path).startsWith('factory-acceptance-')
        || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Invalid verification fixture entry');
      assertSafeReadPath(entry.path);
      const file = await confinedPath(this.ctx.repo.workdir,entry.path);
      let content: string;
      try { content = await fs.readFile(file,'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (hash(content) !== entry.hash) throw this.conflict(entry.path);
      await fs.unlink(file);
    }
    this.entries = [];
    await removeOptionalFile(this.journal);
  }

  private conflict(file: string) {
    return Object.assign(new Error(`Acceptance fixture changed outside its owner; preserving ${file}`), {code:'FACTORY_STATE_FIXTURE_CONFLICT'});
  }

  private unavailable(cause: unknown) {
    if (String((cause as NodeJS.ErrnoException)?.code ?? '').startsWith('FACTORY_STATE_')) return cause;
    return Object.assign(new Error('Acceptance fixture recovery unavailable', {cause}), {code:'FACTORY_STATE_FIXTURE_UNAVAILABLE'});
  }
}
