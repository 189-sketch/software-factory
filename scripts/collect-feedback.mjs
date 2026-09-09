#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const repo = process.env.FACTORY_GH_REPO?.trim();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)?.trim();
if (!repo || !token) throw new Error('Feedback collection requires FACTORY_GH_REPO and GitHub authentication');
const gh = (args) => JSON.parse(execFileSync('gh', args, {
  encoding: 'utf8', env: { ...process.env, GH_TOKEN: token },
  timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}));
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const candidates = gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '1000', '--json', 'number,url,title,body']);
if (candidates.length === 1000) throw new Error('Feedback window exceeds collection limit; narrow the window before proposing learning');
const items = [];
for (const pr of candidates) {
  for (const [source, endpoint] of [
    ['comment', `repos/${repo}/issues/${pr.number}/comments`],
    ['review', `repos/${repo}/pulls/${pr.number}/reviews`],
    ['inline', `repos/${repo}/pulls/${pr.number}/comments`],
  ]) {
    const pages = gh(['api', endpoint + '?per_page=100', '--paginate', '--slurp']);
    for (const entry of pages.flat()) {
      if (!entry.body?.trim() || entry.user?.type !== 'User') continue;
      items.push({
        id: `${source}-${entry.id}`, pr: pr.number, url: entry.html_url || pr.url,
        author: entry.user.login, source, text: entry.body,
        context: { title: pr.title, body: pr.body, path: entry.path, diffHunk: entry.diff_hunk, replyTo: entry.in_reply_to_id },
      });
    }
  }
}
process.stdout.write(JSON.stringify({ prs: candidates.length, items }));
