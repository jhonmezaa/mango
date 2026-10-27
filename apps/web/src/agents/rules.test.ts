import { describe, expect, it } from 'vitest';

import { agentReview } from '../i18n/locales/es/agentReview';
import { problemOfViolation } from '../pages/agentBuilder/model';
import { isRuleCode, isWordedRule, RULE_CODES } from './rules';

describe('submit rule codes', () => {
  // `apps/api/tests/test_agent_rules.py` checks this list against the rules of the API.
  it('are listed once each', () => {
    expect(new Set(RULE_CODES).size).toBe(RULE_CODES.length);
  });

  it('never takes a property of Object for a rule', () => {
    expect(isRuleCode('secret_detected')).toBe(true);
    for (const code of ['toString', 'constructor', '__proto__', '']) {
      expect(isRuleCode(code)).toBe(false);
    }
  });

  it('have a text in every screen that shows them', () => {
    for (const code of RULE_CODES) {
      if (!isWordedRule(code)) continue;
      // Agent review: one text per code.
      expect(agentReview.rules[code], code).toBeTruthy();
      // Agent Builder: a known problem, never the "unknown rule" fallback.
      expect(problemOfViolation({ code, field: 'tools', items: ['x'] }).key, code).not.toBe(
        'unknownRule',
      );
    }
    expect(problemOfViolation({ code: 'new_rule', field: 'tools', items: [] }).key).toBe(
      'unknownRule',
    );
  });

  it('shows a code the design has not worded yet as an unknown rule, by its code (D98)', () => {
    expect(isRuleCode('remote_not_usable')).toBe(true);
    expect(isWordedRule('remote_not_usable')).toBe(false);
    const shown = problemOfViolation({
      code: 'remote_not_usable',
      field: 'tools',
      items: ['remote-abcdefghij23.wiki'],
    });
    expect([shown.key, shown.items]).toEqual(['unknownRule', ['remote_not_usable']]);
  });
});
