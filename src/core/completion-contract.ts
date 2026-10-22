// One contract shared by the worker and the JavaScript daemon scheduler.
export { hasSpecificationApproval, acceptanceRequirements, acceptanceRequirementsHash, hasAcceptanceCoverage,
  verificationChecksHash, hasVerificationJudgment,
  hasImplementationApproval, canConfirmMergedImplementation, verificationReviewConcerns, hasReviewConcernCoverage,
  needsReviewConcernRecovery } from '../../runtime/completion-contract.mjs';
