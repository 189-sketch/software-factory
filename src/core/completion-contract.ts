// One contract shared by the worker and the JavaScript daemon scheduler.
export { hasSpecificationApproval, acceptanceRequirements, acceptanceRequirementsHash, hasAcceptanceCoverage,
  verificationChecksHash, hasVerificationJudgment,
  hasImplementationApproval, canConfirmMergedImplementation } from '../../runtime/completion-contract.mjs';
