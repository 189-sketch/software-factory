import type { FactoryIssueState } from '../core/types.js';
import { hasSpecificationApproval } from '../core/completion-contract.js';
export { hasSpecificationApproval } from '../core/completion-contract.js';

/** An approved spec branch is a recovery ref; rejected specs never provide an execution base. */
export function resolveSpecFallbackRef(state: FactoryIssueState): string | null {
  if (!hasSpecificationApproval(state)) return null;
  return `origin/${state.specs!.specBranch}`;
}
