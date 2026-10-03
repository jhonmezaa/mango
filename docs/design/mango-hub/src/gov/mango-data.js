// Datos de Gobernanza alineados con el demo de Mango (empresa.com)
(function () {
  const G = window.GovData;
  const me = { id: 'a1b2c3d4-0000-0000-0000-111111111111', email: 'usuario1@empresa.com', area: 'finanzas' };
  G.me = me;
  G.budgets.period = '2026-10';
  G.budgets.users = [
    { id: me.id, email: me.email, ownLimit: null, spent: 1.25 },
    { id: 'b2c3d4e5-0000-0000-0000-222222222222', email: 'usuario2@empresa.com', ownLimit: 20, spent: 17.1 },
    { id: 'c3d4e5f6-0000-0000-0000-333333333333', email: 'usuario3@empresa.com', ownLimit: null, spent: 5 },
    { id: 'd4e5f6a7-0000-0000-0000-444444444444', email: null, ownLimit: null, spent: 0.4 },
    { id: 'e5f6a7b8-0000-0000-0000-555555555555', email: 'usuario4@empresa.com', ownLimit: 50, spent: 0 },
    { id: 'a7b8c9d0-0000-0000-0000-777777777777', email: 'usuario5@empresa.com', ownLimit: 1250, spent: 312.4 },
  ];
  window.MangoStore?.set({ govBudgets: JSON.parse(JSON.stringify(G.budgets)) });
  const portal = document.createElement('div');
  portal.className = 'g-frame g-portal';
  document.body.appendChild(portal);
  window.__govPortal = portal;
})();
