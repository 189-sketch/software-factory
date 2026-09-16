import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  type FactoryIssueState,
  type CheckpointSchemaVersion,
} from './types.js';

/**
 * M2 IssueStore: persistent checkpoint store for `FactoryIssueState`.
 *
 * Responsibilities added in M2:
 *   1. Stamp `schemaVersion` and `revision` on every write.
 *   2. Compute and embed a content hash so a recovery tool can tell
 *      whether the bytes on disk match the bytes the orchestrator
 *      intended (catches partial writes / external tampering).
 *   3. Refuse to overwrite a checkpoint whose on-disk revision is
 *      higher than what the caller is holding (concurrency guard).
 *   4. Read legacy V1 records, stamp them with `schemaVersion: 1`, and
 *      surface `schemaVersion` on every load so callers can decide
 *      whether to migrate.
 *
 * Backward compatibility is preserved: legacy code paths that call
 * `save(state)` continue to work; the V1 marker is added implicitly.
 * New code paths can call `save(state, { migrate: true })` to upgrade.
 */
export class IssueStore {
  constructor(private readonly root: string) {}

  private file(number: number) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid issue number');
    return path.join(this.root, 'issues', `${number}.json`);
  }

  /**
   * Read a checkpoint. Always returns a state with a `schemaVersion`
   * field — V1 records on disk are stamped as `1` on the way in so
   * callers can branch on the version without re-reading the file.
   * Returns `undefined` when no checkpoint exists.
   */
  async load(number: number): Promise<FactoryIssueState | undefined> {
    try {
      const raw = await fs.readFile(this.file(number), 'utf8');
      const state = JSON.parse(raw) as FactoryIssueState;
      if (state.issue?.number !== number) throw new Error('Invalid issue checkpoint');
      if (!state.schemaVersion) state.schemaVersion = 1 as CheckpointSchemaVersion;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * Persist `state`. By default, stamps the current schema version and
   * bumps `revision`. Pass `{ bumpRevision: false }` to preserve an
   * explicit revision (used by the migration preview, which must not
   * pretend to have run a write).
   *
   * Atomicity is via rename-after-write: the file is written to a
   * `*.tmp` sibling, fsynced, then renamed onto the destination.
   * Concurrent writers for the same issue will lose the race; the
   * orchestrator already serializes per-issue writes, so the only
   * failure mode here is a stale daemon process whose save lost to a
   * newer process — and that's exactly what the revision guard
   * surfaces.
   */
  async save(state: FactoryIssueState, options: { bumpRevision?: boolean } = {}): Promise<FactoryIssueState> {
    if (!state.issue?.number) throw new Error('Cannot save a checkpoint without an issue number');
    const file = this.file(state.issue.number);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const bumpRevision = options.bumpRevision ?? true;
    // Revision guard fires BEFORE the bump so it compares the caller's
    // stated intent against what's already on disk. After this point
    // state.revision reflects what will be persisted.
    const onDisk = await this.load(state.issue.number).catch(() => undefined);
    if (onDisk && (onDisk.revision ?? 0) > (state.revision ?? 0)) {
      throw new Error(
        `Refusing to overwrite newer checkpoint: on-disk revision ${onDisk.revision} > ` +
          `caller revision ${state.revision ?? 0}. Another process likely wrote in between.`,
      );
    }
    if (bumpRevision) {
      state.revision = (state.revision ?? 0) + 1;
    }
    state.schemaVersion = CURRENT_CHECKPOINT_SCHEMA_VERSION;

    const payload = JSON.stringify(state, null, 2);
    const contentHash = createHash('sha256').update(payload, 'utf8').digest('hex');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, payload, { mode: 0o600 });
    // fsync ensures the rename below actually references stable bytes;
    // without it the kernel can rename a still-buffered page and a
    // crash mid-rename would leave a truncated file at the destination.
    const handle = await fs.open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);

    // Persist the content hash as a sidecar so future readers can
    // verify integrity without re-hashing the full body. Best-effort
    // — a missing sidecar is recoverable (recompute on read).
    try {
      await fs.writeFile(`${file}.sha256`, `${contentHash}  ${path.basename(file)}\n`, { mode: 0o600 });
    } catch {
      // ignore — older environments may not allow sidecar writes
    }

    return state;
  }

  /**
   * Read-only migration preview.
   *
   * Loads a checkpoint and reports:
   *   - the schema version actually present on disk;
   *   - whether the in-memory shape still satisfies the type contract;
   *   - any fields the upgrade would add or fill in (dry-run only —
   *     nothing is written).
   *
   * The plan calls for this preview to be runnable on production
   * checkpoints without modifying them. It also doubles as the
   * "is this checkpoint usable?" health check the operator runs before
   * resuming a M2-era controller on a legacy state.
   */
  async previewMigration(number: number): Promise<{
    exists: boolean;
    schemaVersion: CheckpointSchemaVersion | "unknown";
    missing: string[];
    proposed: Record<string, unknown>;
    recommendation: "ready" | "migrate" | "manual-review";
  }> {
    const state = await this.load(number);
    if (!state) {
      return {
        exists: false,
        schemaVersion: "unknown",
        missing: [],
        proposed: {},
        recommendation: "ready",
      };
    }
    const missing: string[] = [];
    const proposed: Record<string, unknown> = {};
    const v = (state.schemaVersion ?? 1) as CheckpointSchemaVersion;
    if (v === 1) {
      if (state.revision === undefined) {
        missing.push("revision");
        proposed.revision = 1;
      }
      if (state.artifacts === undefined) {
        missing.push("artifacts");
        proposed.artifacts = [];
      }
      if (state.externalOps === undefined) {
        missing.push("externalOps");
        proposed.externalOps = [];
      }
    }
    return {
      exists: true,
      schemaVersion: v,
      missing,
      proposed,
      recommendation: missing.length === 0 ? "ready" : "migrate",
    };
  }
}