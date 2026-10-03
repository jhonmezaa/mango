import { describe, expect, it } from 'vitest';

import { agentReview } from '../i18n/locales/es/agentReview';
import { problemOfViolation } from '../pages/agentBuilder/model';
import { isRuleCode, RULE_CODES } from './rules';

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
});
