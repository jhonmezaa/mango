// Datos de ejemplo — placeholders neutros, no provienen de ningún entorno real.
(function () {
  const me = { id: 'a1b2c3d4-0000-0000-0000-111111111111', email: 'usuario1@empresa.com', area: 'finanzas' };

  const budgets = {
    period: '2026-09', version: 7,
    defaults: { user: 5, agent: 30 },
    agents: [{ id: 'finops', name: 'Agente FinOps', spent: 25.8 }],
    users: [
      { id: me.id, email: me.email, ownLimit: null, spent: 1.25 },
      { id: 'b2c3d4e5-0000-0000-0000-222222222222', email: 'usuario2@empresa.com', ownLimit: 20, spent: 17.1 },
      { id: 'c3d4e5f6-0000-0000-0000-333333333333', email: 'usuario3@empresa.com', ownLimit: null, spent: 5 },
      { id: 'd4e5f6a7-0000-0000-0000-444444444444', email: null, ownLimit: null, spent: 0.4 },
      { id: 'e5f6a7b8-0000-0000-0000-555555555555', email: 'usuario4@empresa.com', ownLimit: 50, spent: 0 },
      { id: 'f6a7b8c9-0000-0000-0000-666666666666', email: 'usuario8@empresa.com', ownLimit: null, spent: 2.1 },
      { id: 'a7b8c9d0-0000-0000-0000-777777777777', email: 'usuario5@empresa.com', ownLimit: 1250, spent: 312.4 },
    ],
  };

  const ous = [
    { id: 'ou-xxxx-00000001', name: 'Workloads', parent: null },
    { id: 'ou-xxxx-00000002', name: 'Finanzas', parent: 'ou-xxxx-00000001' },
    { id: 'ou-xxxx-00000003', name: 'Plataforma', parent: 'ou-xxxx-00000001' },
    { id: 'ou-xxxx-00000004', name: 'Staging', parent: 'ou-xxxx-00000003' },
    { id: 'ou-xxxx-00000005', name: 'Retail', parent: 'ou-xxxx-00000001' },
    { id: 'ou-xxxx-00000006', name: 'Datos', parent: 'ou-xxxx-00000001' },
    { id: 'ou-xxxx-00000007', name: 'Seguridad', parent: null },
    { id: 'ou-xxxx-00000008', name: 'Sandbox', parent: null },
    { id: 'ou-xxxx-00000009', name: 'No productivo', parent: 'ou-xxxx-00000008' },
  ];
  const byId = Object.fromEntries(ous.map(o => [o.id, o]));
  const pathOf = (o) => { const p = []; let c = o; while (c) { p.unshift(c.name); c = byId[c.parent]; } return p.join(' › '); };
  const depthOf = (o) => { let d = 0, c = byId[o.parent]; while (c) { d++; c = byId[c.parent]; } return d; };
  const order = []; const walk = (parent) => ous.filter(o => o.parent === parent).forEach(o => { order.push(o); walk(o.id); }); walk(null);
  const tree = order.map(o => ({ ...o, path: pathOf(o), depth: depthOf(o) }));
  const treeIndex = Object.fromEntries(tree.map(o => [o.id, o]));

  const mapping = { version: 4, areas: {
    finanzas: ['ou-xxxx-00000002'],
    plataforma: ['ou-xxxx-00000003', 'ou-xxxx-00000004'],
    retail: ['ou-xxxx-00000005'],
    seguridad: ['ou-xxxx-00000007'],
  } };
  const base = mapping.areas;
  const h = (hours) => new Date(new Date('2026-09-29T14:30:00').getTime() - hours * 3600e3).toISOString();

  const proposals = [
    { id: 'prop-0000-0005', by: 'usuario6@empresa.com', createdAt: h(2), baseVersion: 4, reason: 'Datos pasa a reportar a Retail desde el próximo mes.',
      mapping: { ...base, retail: [...base.retail, 'ou-xxxx-00000006'] } },
    { id: 'prop-0000-0004', by: 'usuario7@empresa.com', createdAt: h(26), baseVersion: 4, reason: 'Finanzas también revisa el gasto del entorno no productivo.',
      mapping: { ...base, finanzas: [...base.finanzas, 'ou-xxxx-00000009'] } },
    { id: 'prop-0000-0006', by: me.email, createdAt: h(0.5), baseVersion: 4, reason: 'Crear un área para el equipo que administra Sandbox.',
      mapping: { ...base, sandbox: ['ou-xxxx-00000008', 'ou-xxxx-00000009'] } },
    { id: 'prop-0000-0003', by: 'usuario6@empresa.com', createdAt: h(72), baseVersion: 3, reason: 'Staging deja de ser responsabilidad de Plataforma.',
      mapping: { ...base, plataforma: ['ou-xxxx-00000003'] } },
    { id: 'prop-0000-0001', by: 'usuario7@empresa.com', createdAt: h(200), baseVersion: 3, reason: 'Seguridad se integra en Plataforma.',
      mapping: { finanzas: base.finanzas, plataforma: [...base.plataforma, 'ou-xxxx-00000007'], retail: base.retail } },
  ];

  window.GovData = { me, budgets, tree, treeIndex, mapping, proposals };
})();
