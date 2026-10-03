import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import {
  TEMPLATES,
  applyTemplate,
  blankDefinition,
  changeCount,
  findSecrets,
  firstSecret,
  precheck,
  problemOfError,
  problemOfViolation,
  subordinatesOf,
  supervisorOptions,
  toInput,
  toolIndex,
} from './model';
import { context, definition, orgNodes } from './testFixtures';

const keys = (problems: { key: string }[]) => problems.map((item) => item.key);

describe('precheck', () => {
  it('passes a complete definition', () => {
    expect(precheck(definition(), context, { submitting: true })).toEqual([]);
  });

  it('asks for supervisor and role only when sending', () => {
    const draft = definition({ reports_to: null, role: ' ' });
    expect(precheck(draft, context)).toEqual([]);
    expect(keys(precheck(draft, context, { submitting: true }))).toEqual([
      'reportsToRequired',
      'roleRequired',
    ]);
  });

  it('files each problem under its section', () => {
    const problems = precheck(
      definition({ name: ' ', system_prompt: '', groups: [], tools: ['ghost.tool'] }),
      context,
    );
    expect(problems.map((item) => [item.key, item.section])).toEqual([
      ['nameRequired', 'identity'],
      ['promptRequired', 'brain'],
      ['toolNotEnabledOne', 'tools'],
      ['groupsRequired', 'access'],
    ]);
  });

  it('flags models that are not enabled or cannot use tools', () => {
    const problems = precheck(
      definition({ model: 'model.text', allowed_models: ['model.gone', 'model.text'] }),
      context,
    );
    expect(problems).toMatchObject([
      { key: 'modelNotEnabled', items: ['model.gone'] },
      { key: 'modelWithoutTools', items: ['model.text'] },
    ]);
    expect(keys(precheck(definition({ allowed_models: [] }), context))).toContain(
      'defaultModelNotAllowed',
    );
  });

  it('blocks organization-wide tools for groups that are not central (D35)', () => {
    // Tools filtered per user stay available to area groups.
    expect(precheck(definition({ groups: ['bu-retail'] }), context)).toEqual([]);
    const problems = precheck(
      definition({ tools: ['cost-explorer.org_wide'], groups: ['bu-retail', 'finops-central'] }),
      context,
    );
    expect(problems).toMatchObject([
      {
        key: 'accountDataArea',
        section: 'tools',
        items: ['bu-retail'],
        tools: ['cost-explorer.org_wide'],
      },
    ]);
  });

  it('blocks organization-wide tools shared with people one by one', () => {
    // Tools filtered per user can be shared with people.
    expect(precheck(definition({ users: ['user-7'] }), context)).toEqual([]);
    expect(
      precheck(definition({ tools: ['cost-explorer.org_wide'], users: ['user-7'] }), context),
    ).toMatchObject([{ key: 'accountDataUsers', section: 'access' }]);
  });

  it('reports the kind of a secret, never the text', () => {
    // Split so secret scanners do not take the fixture for a real key.
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const problems = precheck(definition({ system_prompt: `key ${secret}` }), context);
    expect(problems).toMatchObject([
      { key: 'secret', field: 'system_prompt', section: 'brain', items: ['aws_access_key_id'] },
    ]);
    expect(JSON.stringify(problems)).not.toContain(secret);
    // One finding, as in the design: the first field in its order, with only kind and field.
    const both = definition({ role: `pwd: ${secret}`, description: 'password: hunter2222' });
    expect(firstSecret(both)).toEqual({ field: 'description', kind: 'password' });
    expect(precheck(both, context)).toMatchObject([
      { key: 'secret', field: 'description', section: 'identity', items: ['password'] },
    ]);
    expect(firstSecret(definition({ role: `k ${secret}` }))).toEqual({
      field: 'role',
      kind: 'aws_access_key_id',
    });
    expect(findSecrets('password: hunter2222')).toEqual(['password']);
    expect(findSecrets('nothing to see')).toEqual([]);
  });
});

describe('server findings', () => {
  it('maps rule codes to a text and a section', () => {
    expect(
      problemOfViolation({ code: 'reports_to_cycle', field: 'reports_to', items: ['finops'] }),
    ).toMatchObject({ key: 'reportsToCycle', section: 'org' });
    expect(
      problemOfViolation({
        code: 'account_data_for_non_central_group',
        field: 'groups',
        items: ['bu-retail'],
      }),
    ).toMatchObject({ key: 'serverAccountDataArea', section: 'tools' });
    expect(
      problemOfViolation({ code: 'tool_not_enabled', field: 'tools', items: ['a.b', 'c.d'] }),
    ).toMatchObject({ key: 'serverToolNotEnabled', section: 'tools' });
    expect(
      problemOfViolation({ code: 'secret_detected', field: 'role', items: ['password'] }),
    ).toMatchObject({ key: 'secret', field: 'role', section: 'org' });
  });

  it('files every server rule of the design where the design points', () => {
    const of = (code: string, field: string) => {
      const { key, section } = problemOfViolation({ code, field, items: [] });
      return [key, section];
    };
    expect(of('reports_to_unknown', 'reports_to')).toEqual(['reportsToUnknown', 'org']);
    expect(of('model_required', 'model')).toEqual(['modelRequired', 'brain']);
    expect(of('default_model_not_allowed', 'allowed_models')).toEqual([
      'defaultModelNotAllowed',
      'brain',
    ]);
    expect(of('model_not_enabled', 'allowed_models')).toEqual(['serverModelNotEnabled', 'brain']);
    expect(of('model_without_tools', 'allowed_models')).toEqual([
      'serverModelWithoutTools',
      'brain',
    ]);
    expect(of('write_tool_without_approval', 'approval_tools')).toEqual([
      'writeToolApproval',
      'tools',
    ]);
    expect(of('group_unknown', 'groups')).toEqual(['groupUnknown', 'access']);
    expect(of('account_data_for_users', 'users')).toEqual(['serverAccountDataUsers', 'access']);
    // The whole definition is too large: no section to go to.
    expect(of('definition_too_large', 'system_prompt')).toEqual(['definitionTooLarge', null]);
  });

  it('keeps an unknown rule visible by its code', () => {
    expect(problemOfViolation({ code: 'new_rule', field: 'x', items: [] })).toMatchObject({
      key: 'unknownRule',
      section: null,
      items: ['new_rule'],
    });
  });

  it('maps API failures by code and status, never by message', () => {
    const quotas = { drafts: 20, max_drafts: 20, submissions_today: 5, max_submissions_per_day: 5 };
    expect(problemOfError(new ApiError(429, 'submission_limit', 'x'), quotas).key).toBe(
      'dailyLimit',
    );
    expect(problemOfError(new ApiError(403, 'forbidden', 'x'), quotas).key).toBe('forbidden');
    expect(problemOfError(new ApiError(409, 'too_many_drafts', 'x'), quotas)).toMatchObject({
      key: 'tooManyDrafts',
      count: 20,
    });
    expect(problemOfError(new ApiError(409, 'version_conflict', 'x'), quotas).key).toBe(
      'versionConflict',
    );
    expect(problemOfError(new ApiError(503, 'models_unavailable', 'x'), quotas).key).toBe(
      'unavailable',
    );
    expect(problemOfError(new TypeError('fetch failed'), quotas).key).toBe('network');
  });
});

describe('organization', () => {
  it('leaves the agent itself and everything below it out of the supervisors', () => {
    expect([...subordinatesOf(orgNodes, 'finops')].sort()).toEqual(['forecast', 'savings']);
    expect(supervisorOptions(orgNodes, 'finops').map((node) => node.id)).toEqual(['tagging']);
    expect(supervisorOptions(orgNodes, 'savings').map((node) => node.id)).toEqual([
      'finops',
      'tagging',
    ]);
    expect(supervisorOptions(orgNodes, null)).toHaveLength(4);
  });
});

describe('what is sent', () => {
  it('trims texts, sorts sets and marks every write tool for approval', () => {
    const input = toInput(
      definition({
        name: '  Agente  ',
        description: ' ',
        role: ' Rol ',
        tools: ['ops.stop', 'cost-explorer.per_user'],
        approval_tools: ['gone.tool'],
        groups: ['finops-central', 'bu-retail'],
      }),
      context,
      'Agente FinOps',
    );
    expect(input).toMatchObject({
      name: 'Agente',
      description: 'Agente FinOps',
      role: 'Rol',
      tools: ['cost-explorer.per_user', 'ops.stop'],
      approval_tools: ['ops.stop'],
      groups: ['bu-retail', 'finops-central'],
    });
  });

  it('starts blank with the first enabled model and no made-up groups', () => {
    expect(blankDefinition(context)).toMatchObject({
      model: 'model.main',
      allowed_models: ['model.main'],
      groups: [],
      reports_to: null,
    });
  });

  it('applies a template to identity and instructions only', () => {
    const finops = TEMPLATES.find((item) => item.id === 'finops');
    if (!finops) throw new Error('missing template');
    const applied = applyTemplate(blankDefinition(context), finops, 'Analista FinOps', context);
    expect(applied).toMatchObject({ name: 'Analista FinOps', category: 'FinOps', icon: 'Money' });
    expect(applied.system_prompt).toContain('Primero consulta Cost Explorer');
    expect(applied.tools).toEqual([]);
    expect(applied.groups).toEqual([]);
    expect(applied).not.toHaveProperty('budget');
    // What the creator already chose is not replaced by the template.
    const chosen = definition({ tools: ['cost-explorer.per_user'], groups: ['finops-central'] });
    expect(applyTemplate(chosen, finops, 'Analista FinOps', context)).toMatchObject({
      tools: ['cost-explorer.per_user'],
      groups: ['finops-central'],
      limits: chosen.limits,
    });
  });

  it('counts changes against the published version', () => {
    const base = definition();
    expect(changeCount(base, base)).toBe(0);
    expect(
      changeCount(base, {
        ...base,
        name: 'Otro',
        system_prompt: 'Otro prompt',
        tools: [],
        groups: [...base.groups, 'bu-retail'],
        limits: { ...base.limits, max_iterations: 12 },
      }),
    ).toBe(5);
    // Design: category, icon, color, people, tokens per call and temperature count too.
    expect(
      changeCount(base, {
        ...base,
        category: 'Data',
        icon: 'Bot',
        color: 3,
        users: ['user-7'],
        limits: { ...base.limits, max_tokens_per_call: 2048, temperature: 0.3 },
      }),
    ).toBe(6);
  });
});

describe('tools the catalog serves', () => {
  /** A pack in the middle of an update: installed, but it does not serve one of its tools yet. */
  const updating = context.catalog.map((connector) =>
    connector.id === 'ops'
      ? {
          ...connector,
          tools: [
            ...connector.tools,
            { ...connector.tools[0], ref: 'ops.reboot', name: 'reboot', enabled: false },
          ],
        }
      : connector,
  ) as typeof context.catalog;

  it('decides by each tool, not only by its server', () => {
    const index = toolIndex(updating);
    expect(index.get('ops.stop')?.enabled).toBe(true);
    expect(index.get('ops.reboot')?.enabled).toBe(false);
    // A server that is not installed serves nothing, whatever its tools say.
    expect(index.get('billing.invoices')?.enabled).toBe(false);
  });

  it('flags a tool its pack does not serve yet', () => {
    const problems = precheck(definition({ tools: ['ops.reboot'] }), {
      ...context,
      catalog: updating,
    });
    expect(keys(problems)).toEqual(['toolNotEnabledOne']);
  });
});
