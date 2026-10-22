import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acceptableLessonText,
  creditLessons,
  isLearnableError,
  learnFromFailure,
  lessonRoleFor,
  lessonsTurnFor,
  LessonStore,
  parseDistillOutput,
  type DistillOutput,
  type Distiller,
  type LearningContext,
} from '../core/lessons.js';

const logger = { info() {}, warn() {}, error() {}, child() { return logger; } };
const ENV = { FACTORY_LEARNING: '1' } as NodeJS.ProcessEnv;

async function fixture(t: import('node:test').TestContext) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-lessons-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const ctx: LearningContext = {
    logger, artifactStateDir: stateDir,
    repo: { owner: 'local', name: 'demo', defaultBranch: 'main', workdir: path.join(stateDir, 'checkout') },
    issue: { number: 7, title: 't', body: '', labels: [], author: 'a', url: '', createdAt: '', comments: [] } as never,
  };
  return { ctx, store: new LessonStore(path.join(stateDir, 'lessons')) };
}

const signal = (kind = 'REVIEW_REJECTED') => ({ role: 'implementation', stage: 'review', issue: 7, kind, detail: 'AC2 exact error message was not asserted' });
const distiller = (output: DistillOutput): Distiller => async () => output;
const RULE = 'Before returning, confirm a test in the diff asserts the exact error message every acceptance criterion specifies.';

test('only the agent\'s own mistakes are learnable, never infrastructure faults', () => {
  assert.deepEqual(isLearnableError(Object.assign(new Error('x'), { code: 'FACTORY_AGENT_OUTPUT_CONTRACT_INVALID' })),
    { learnable: true, kind: 'AGENT_FORMAT_ERROR' });
  for (const code of ['FACTORY_STATE_UNAVAILABLE', 'FACTORY_AGENT_REQUEST_TIMEOUT', 'FACTORY_AGENT_EXECUTION_FAILED', 'FACTORY_AGENT_CANCELLED']) {
    assert.equal(isLearnableError(Object.assign(new Error('x'), { code })).learnable, false, code);
  }
  assert.equal(isLearnableError(new Error('ECONNRESET socket hang up')).learnable, false);
});

test('stage and dispatch names map to the agent that owns the lesson', () => {
  assert.equal(lessonRoleFor('spec-product'), 'spec');
  assert.equal(lessonRoleFor('spec-tech'), 'spec');
  assert.equal(lessonRoleFor('review'), 'review-pr');
  assert.equal(lessonRoleFor('verify'), 'verify-behavior');
  assert.equal(lessonRoleFor('merge-spec-pr'), null);
});

test('a lesson may add care but never weaken a check', () => {
  assert.equal(acceptableLessonText(RULE), RULE);
  assert.equal(acceptableLessonText('Skip the unit tests when the change is small to save time.'), null);
  assert.equal(acceptableLessonText('Ignore review findings marked SUGGESTION entirely.'), null);
  assert.equal(acceptableLessonText('too short'), null);
  assert.equal(acceptableLessonText('x'.repeat(600)), null);
});

test('distiller output is parsed strictly', () => {
  assert.deepEqual(parseDistillOutput('{"lesson":null,"replaces":null,"reason":"flaky network"}'),
    { lesson: null, replaces: null, reason: 'flaky network' });
  assert.throws(() => parseDistillOutput('{"lesson":null}'), /reason/);
});

test('a failure creates a lesson that is applied to the next attempt and credited when it passes', async t => {
  const { ctx, store } = await fixture(t);
  const created = await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: RULE }, reason: 'AC2 assertion missing' }), env: ENV });
  assert.equal(created.outcome, 'created');

  const turn = await lessonsTurnFor(ctx, 'implementation', ENV);
  assert.match(turn!.content, /exact error message/);
  assert.match(turn!.content, new RegExp(created.lessonId!));
  // Other agents do not receive implementation lessons.
  assert.equal(await lessonsTurnFor(ctx, 'review-pr', ENV), null);

  assert.deepEqual(await creditLessons(ctx, 'implementation', 7, ENV), [created.lessonId]);
  const [lesson] = await store.active('implementation');
  assert.deepEqual(lesson!.stats, { applied: 1, successes: 1, recurrences: 0 });
  // Credit is consumed: a second pass without a new application credits nothing.
  assert.deepEqual(await creditLessons(ctx, 'implementation', 7, ENV), []);
});

test('near-duplicate lessons merge their evidence instead of growing the prompt', async t => {
  const { ctx, store } = await fixture(t);
  await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: RULE }, reason: 'r' }), env: ENV });
  const merged = await learnFromFailure(ctx, { ...signal(), issue: 8 },
    { distill: distiller({ lesson: { text: RULE.replace('Before returning, confirm', 'Confirm') }, reason: 'r' }), env: ENV });
  assert.equal(merged.outcome, 'merged');
  const lessons = (await store.read('implementation')).lessons;
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0]!.evidence.length, 2);
});

test('a lesson that keeps failing is retired, and the distiller can rewrite it', async t => {
  const { ctx, store } = await fixture(t);
  const first = await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: RULE }, reason: 'r' }), env: ENV });
  const decline = distiller({ lesson: null, reason: 'already covered' });
  for (let i = 0; i < 3; i++) {
    await lessonsTurnFor(ctx, 'implementation', ENV);
    await learnFromFailure(ctx, signal(), { distill: decline, env: ENV });
  }
  let [lesson] = (await store.read('implementation')).lessons;
  assert.equal(lesson!.status, 'retired');
  assert.equal(lesson!.stats.recurrences, 3);
  // A different failure kind is not a recurrence of this lesson.
  await lessonsTurnFor(ctx, 'implementation', ENV);

  const rewritten = 'When an acceptance criterion names an error message, assert it with assert.throws(fn, { message }) rather than a bare throw check.';
  const revised = await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: rewritten }, replaces: first.lessonId, reason: 'previous rule too vague' }), env: ENV });
  assert.equal(revised.outcome, 'revised');
  [lesson] = (await store.read('implementation')).lessons;
  assert.equal(lesson!.status, 'active');
  assert.equal(lesson!.revision, 2);
  assert.equal(lesson!.text, rewritten);
  assert.equal(lesson!.stats.recurrences, 0);
});

test('weakening or failed distillation never stores a lesson and never throws', async t => {
  const { ctx, store } = await fixture(t);
  assert.equal((await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: 'Disable the failing tests so the review passes next time.' }, reason: 'r' }), env: ENV })).outcome, 'rejected-text');
  assert.equal((await learnFromFailure(ctx, signal(), { distill: async () => { throw new Error('backend down'); }, env: ENV })).outcome, 'failed');
  assert.equal((await store.read('implementation')).lessons.length, 0);
  const episodes = (await fs.readFile(path.join(ctx.artifactStateDir!, 'lessons', 'episodes.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(episodes.map(line => JSON.parse(line).outcome), ['rejected-text', 'failed']);
});

test('learning can be switched off and judges never receive or consume agent lessons', async t => {
  const { ctx } = await fixture(t);
  assert.equal((await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: RULE }, reason: 'r' }), env: { FACTORY_LEARNING: 'off' } })).outcome, 'skipped');
  await learnFromFailure(ctx, signal(), { distill: distiller({ lesson: { text: RULE }, reason: 'r' }), env: ENV });
  assert.equal(await lessonsTurnFor({ ...ctx, agentId: 'judgment-123' }, 'implementation', ENV), null);
  assert.notEqual(await lessonsTurnFor(ctx, 'implementation', ENV), null);
});

test('concurrent updates from parallel workers are not lost', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.update('triage', file => {
    file.pending[`issue-${index}`] = { ids: [], at: '' };
  })));
  assert.equal(Object.keys((await store.read('triage')).pending).length, 20);
});

test('lessons never land inside the product checkout', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-lessons-repo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', root]);
  const { lessonsDirectory } = await import('../core/lessons.js');
  assert.equal(lessonsDirectory(path.join(root, '.factory'), {}, root), path.join(root, '.git', 'factory-lessons'));
  assert.equal(lessonsDirectory('/srv/state', {}, root), path.join('/srv/state', 'lessons'));
  assert.equal(lessonsDirectory(undefined, { FACTORY_LESSONS_DIR: '/shared/lessons' }, root), '/shared/lessons');
});

test('factory-owned git failures are environment faults, not lessons', () => {
  const error = new Error('Command failed: git push --force-with-lease -u origin spec/x\n ! [rejected] (stale info)');
  assert.deepEqual(isLearnableError(error), { learnable: false, kind: 'ENVIRONMENT' });
});
