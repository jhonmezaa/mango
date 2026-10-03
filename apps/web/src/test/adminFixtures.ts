import type { Budgets, BusinessUnits, Organization } from '../api/adminSchemas';

export const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-0000000000ad';

export function budgetsFixture(overrides: Partial<Budgets> = {}): Budgets {
  return {
    period: '2026-09',
    version: 4,
    defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
    agents: [{ agent_id: 'finops', limit_usd: '2000.00', spent_usd: '412.35' }],
    users: [
      {
        user_id: ADMIN_ID,
        email: 'ana.perez@example.com',
        limit_usd: '50.00',
        override: false,
        spent_usd: '12.40',
      },
      {
        user_id: 'c9a0f311-luis',
        email: '<img src=x onerror=alert(1)>@example.com',
        limit_usd: '150.00',
        override: true,
        spent_usd: '160.00',
      },
    ],
    ...overrides,
  };
}

export const ORGANIZATION: Organization = {
  ous: [
    {
      id: 'ou-a1b2-22222222',
      name: 'Finanzas',
      parent_id: 'r-a1b2',
      path: ['Producción', 'Finanzas'],
    },
    { id: 'ou-a1b2-33333333', name: 'Retail', parent_id: 'r-a1b2', path: ['Producción', 'Retail'] },
    { id: 'ou-a1b2-55555555', name: 'Datos', parent_id: 'r-a1b2', path: ['Producción', 'Datos'] },
    {
      id: 'ou-a1b2-77777777',
      name: 'Sandbox <img src=x onerror=alert(1)>',
      parent_id: 'r-a1b2',
      path: ['No productivo', 'Sandbox <img src=x onerror=alert(1)>'],
    },
  ],
};

export function businessUnitsFixture(overrides: Partial<BusinessUnits> = {}): BusinessUnits {
  const units = { finanzas: ['ou-a1b2-22222222'], retail: ['ou-a1b2-33333333'] };
  return {
    version: 3,
    units,
    pending: [
      {
        change_id: 'CHG-OTHER',
        proposed_by: 'admin-2',
        proposed_by_email: 'otra.admin@example.com',
        created_at: '2026-09-29T10:00:00Z',
        expires_at: '2026-10-06T10:00:00Z',
        base_version: 3,
        units: { ...units, retail: ['ou-a1b2-33333333', 'ou-a1b2-55555555'] },
        reason: '<script>alert(1)</script> Datos pasa a Retail',
      },
      {
        change_id: 'CHG-MINE',
        proposed_by: ADMIN_ID,
        proposed_by_email: 'ana.perez@example.com',
        created_at: '2026-09-29T11:00:00Z',
        expires_at: '2026-10-06T11:00:00Z',
        base_version: 3,
        units: { ...units, plataforma: ['ou-a1b2-55555555'] },
        reason: 'Plataforma tiene equipo propio',
      },
      {
        change_id: 'CHG-MY-AREA',
        proposed_by: 'admin-3',
        proposed_by_email: null,
        created_at: '2026-09-29T12:00:00Z',
        expires_at: '2026-10-06T12:00:00Z',
        base_version: 3,
        units: { ...units, finanzas: ['ou-a1b2-22222222', 'ou-a1b2-77777777'] },
        reason: 'Sandbox para Finanzas',
      },
    ],
    ...overrides,
  };
}
