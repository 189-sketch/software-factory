import { businessInputHash } from './business-input.mjs';
import { ACTIVE_PIPELINE_LABELS, RETIRED_PIPELINE_LABELS } from './pipeline-definition.mjs';
import { recoveryHash } from './recovery-scheduler.mjs';

const workflowLabels = new Set([...ACTIVE_PIPELINE_LABELS, ...RETIRED_PIPELINE_LABELS]);

/** Only new business input, product progress or executor changes reopen recovery immediately. */
export function runtimeRecoveryInputHash(issue, checkpoint, runtime) {
  const labels = (issue.labels ?? []).filter(label => !workflowLabels.has(typeof label === 'string' ? label : label.name));
  return recoveryHash({input:businessInputHash({...issue,labels}),runtime,
    progress: {
      specs:checkpoint?.specs?.commitSha ?? null,
      specificationReview:checkpoint?.specReviewedKey ?? null,
      implementation:checkpoint?.implementation?.commitSha ?? null,
      review:checkpoint?.reviewedSha ?? null,
      base:checkpoint?.reviewedBaseSha ?? null,
      verification:checkpoint?.verifiedSha ?? null,
      merged:checkpoint?.merged === true,
      confirmedOperations:(checkpoint?.externalOps ?? []).filter(op=>op.receipt?.operatorConfirmation)
        .map(op=>({id:op.id,status:op.status})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
    },
  });
}
