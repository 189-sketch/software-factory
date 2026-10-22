import { randomUUID } from 'node:crypto';
import { listCommitCheckRuns } from '../../runtime/github-rest.mjs';
import type { AgentTool } from './agent-runtime.js';
import type { AgentContext } from './types.js';

export function ciEvidenceTool(ctx: AgentContext, implementationSha: string | undefined,
  record: (receipt: {id:string;kind:string;passed:boolean;detail:unknown}) => void): AgentTool {
  return {
    name: 'collect_ci_checks',
    description: 'Read existing GitHub Actions check executions for this repository and the exact current implementation commit. Args: {}. Does not trigger CI or change GitHub. Returns a current-run receipt with check names, statuses, conclusions and run URLs. Cite it for actual cross-platform CI execution; YAML configuration alone is not execution proof.',
    inputSchema: {type:'object',properties:{},additionalProperties:false},
    execute: async args => {
      if (Object.keys(args).length) throw new Error('CI evidence uses the fixed repository and implementation commit; no overrides are allowed');
      if (!implementationSha) throw new Error('Current implementation commit is unavailable');
      const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)?.trim();
      if (!token) throw new Error('GitHub credentials are unavailable for CI evidence; do not substitute local tests or YAML');
      const repository = `${ctx.repo.owner}/${ctx.repo.name}`;
      const checks = (await listCommitCheckRuns({token,repository,sha:implementationSha})).map(check=>({
        id:check.id,name:check.name,headSha:check.head_sha,status:check.status,conclusion:check.conclusion,
        url:check.html_url ?? check.details_url,startedAt:check.started_at,completedAt:check.completed_at,
      }));
      const receipt = {id:randomUUID(),kind:'ci-checks',
        passed:checks.length>0 && checks.every(check=>check.status==='completed' && check.conclusion==='success'),
        detail:{repository,headSha:implementationSha,observedAt:new Date().toISOString(),checks}};
      record(receipt);
      return receipt;
    },
  };
}
