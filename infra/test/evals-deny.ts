import { expect } from "vitest";

/**
 * A role's `ManagedPolicyArns` that hold only `Mango-<ns>-evals-content-deny` (D110 (8)): the
 * Deny every role of Core but the evaluator carries, attached by `DenyEvalsContent`. In a
 * nested stack it arrives as a parameter named after it.
 */
export function expectOnlyTheEvalsContentDeny(managedPolicyArns: unknown): void {
  expect(managedPolicyArns).toHaveLength(1);
  expect(JSON.stringify(managedPolicyArns)).toMatch(/EvalsCaptureContentDeny/);
}
