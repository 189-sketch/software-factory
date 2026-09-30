import { issueFile, readOptionalJson, writeDurableJson } from '../../runtime/durable-json.mjs';
import type { ProviderSessionMap } from './types.js';
import path from 'node:path';

/** Local-only CLI sessions are never embedded into public recovery records. */
export class SessionStore {
  constructor(private readonly root: string) {}
  private file(number: number) {
    return number === 0 ? path.join(this.root, 'sessions', 'maintenance-review.json') : issueFile(this.root, 'sessions', number);
  }

  async load(number: number): Promise<ProviderSessionMap> {
    const record = await readOptionalJson(this.file(number));
    if (!record) return {};
    if (!record.providerSessions || typeof record.providerSessions !== 'object' || Array.isArray(record.providerSessions)) {
      throw new Error('Invalid provider session record');
    }
    return record.providerSessions as ProviderSessionMap;
  }

  async save(number: number, providerSessions: ProviderSessionMap): Promise<void> {
    await writeDurableJson(this.file(number), { providerSessions });
  }
}
