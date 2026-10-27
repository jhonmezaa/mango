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
  'knowledge_base_unavailable',
  'knowledge_base_not_usable',
  'skill_unavailable',
  'skill_server_not_enabled',
  'skill_server_without_tools',
  'remote_not_usable',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/**
 * Codes the design has no text for yet (`remote_not_usable`, D98): every screen shows them as an
 * unknown rule, by their code, until Claude Design words them.
 */
const UNWORDED: ReadonlySet<string> = new Set<RuleCode>(['remote_not_usable']);
export type WordedRuleCode = Exclude<RuleCode, 'remote_not_usable'>;

const KNOWN: ReadonlySet<string> = new Set(RULE_CODES);

/** The code is API data: anything else is shown as an unknown rule, by its code. */
export function isRuleCode(code: string): code is RuleCode {
  return KNOWN.has(code);
}

/** A known code that has a text of its own. */
export function isWordedRule(code: string): code is WordedRuleCode {
  return KNOWN.has(code) && !UNWORDED.has(code);
}
