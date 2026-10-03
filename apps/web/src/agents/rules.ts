// Submit rules of an agent version (`mango_api.agent_rules`): the API reports the code and the
// items of each broken rule, never text. Every screen that shows them (Agent Builder, agent
// review) takes the codes from here and has its own wording for its reader.

export const RULE_CODES = [
  'prompt_required',
  'reports_to_required',
  'role_required',
  'groups_required',
  'definition_too_large',
  'secret_detected',
  'reports_to_cycle',
  'reports_to_unknown',
  'model_required',
  'default_model_not_allowed',
  'model_not_enabled',
  'model_without_tools',
  'tool_not_enabled',
  'approval_tool_not_selected',
  'write_tool_without_approval',
  'group_unknown',
  'account_data_for_non_central_group',
  'account_data_for_users',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(RULE_CODES);

/** The code is API data: anything else is shown as an unknown rule, by its code. */
export function isRuleCode(code: string): code is RuleCode {
  return KNOWN.has(code);
}
