import { Stack, Validations } from "aws-cdk-lib";

interface Acknowledgment {
  id: string;
  reason: string;
}

/**
 * Justified cdk-nag acknowledgments (AGENTS.md: no silent exceptions). Each entry states why
 * the rule does not apply or is accepted for the lab/PoC (see D15 and AGENTS.md exceptions).
 */
const STACK_ACKNOWLEDGMENTS: Acknowledgment[] = [];

export function applyNagSuppressions(stack: Stack): void {
  if (STACK_ACKNOWLEDGMENTS.length > 0) {
    Validations.of(stack).acknowledge(...STACK_ACKNOWLEDGMENTS);
  }
}
