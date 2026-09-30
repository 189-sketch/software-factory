# Factory decision and execution TODO

Scope: the decision, state-transition, and verification failures observed on test issue #46.
This work does not change the test project's application code or enable automatic PR merging.

- [ ] Preserve newly fetched author comments in freshness decisions and make `needs-info` wake-ups edge-triggered by a new author event.
  Verify with a real issue reply and daemon log showing exactly one fresh re-triage.
- [ ] Represent an author's explicit disposition of known review findings without allowing an unreviewed or safety-critical defect to disappear.
  Verify issue #46 advances or requests a specific, actionable decision instead of repeating the same rubric rejection.
- [ ] Require complete Jev answer coverage and stable finding identities across revisions.
  Verify missing answers stop the gate and a renamed validation-plan item retains its failure history.
- [ ] Enforce decision routes at state transitions and supply real receipt-producing tools to behavior verification.
  Verify `confirm` and `escalate` cannot silently auto-merge and a verification result cites executed receipts.
- [ ] Separate freshness skip-rate telemetry from product-quality health.
  Verify a tick with one fresh issue does not report zero quality solely because it was processed.
- [ ] Build and run the factory against `pi-software-factory-target` with `autoMerge=false`.
  Record the actual issue outcome, stage transitions, and any remaining blockers.
