import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FactoryIssueState } from './types.js';

export class IssueStore {
  constructor(private readonly root: string) {}

  private file(number: number) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid issue number');
    return path.join(this.root, 'issues', `${number}.json`);
  }

  async load(number: number): Promise<FactoryIssueState | undefined> {
    try {
      const state = JSON.parse(await fs.readFile(this.file(number), 'utf8'));
      if (state.issue?.number !== number) throw new Error('Invalid issue checkpoint');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(state: FactoryIssueState) {
    const file = this.file(state.issue.number);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
}
