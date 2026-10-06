# D65 · El Org Chart dice quién usa un agente que no puedes usar

- **Estado:** vigente
- **Fecha:** 2026-10-04
- **Precisa / reemplaza a:** precisa [D38](D038-alcance-de-marketplace-v1.md)
- **Precisada por:** —
- **Tema en el registro original:** El Org Chart dice quién usa un agente que no puedes usar (precisa [D38](D038-alcance-de-marketplace-v1.md))

## Decisión

Origen: la ronda de Claude Design del 2026-10-04 (novena) resolvió el caso de quien crea un agente y no está en sus grupos. El uso va por grupos y personas, también para administradores y para quien lo creó ([D33](D033-autorizacion-de-agentes-y-tools.md)); ver un agente en el Org Chart no es poder usarlo.

**(1)** `GET /api/agents/org` añade a cada nodo `can_use` (resultado de `UseAgent` para quien llama) y `groups`.

**(2) `groups` solo viene en los nodos que quien llama ve y no puede usar**, es decir, solo para administradores y creadores, que son quienes ven el árbol completo ([D38](D038-alcance-de-marketplace-v1.md)); en los demás nodos es `[]`. Nunca incluye las personas con las que se comparte. Es el mínimo para la caja «No puedes usar este agente · Lo usan» del diseño. El resto de la API sigue sin exponer grupos ni personas de un agente (`Agent` del Marketplace no cambia).

**(3)** `can_use` es solo para mostrar: el chat y el Marketplace autorizan cada petición por su cuenta.

**(4)** Agent Builder › Acceso avisa, sin bloquear, cuando quien edita elige grupos en los que no está; lo calcula la SPA con los grupos de `GET /api/me`, como ayuda. Efecto en TM-M17: un creador aprende los ids de los grupos de agentes ajenos que no puede usar; ya conoce el registro de grupos (`GET /api/groups`) y los nombres y jerarquía de esos agentes.

**(5) `can_edit` (2026-10-04, completa el punto 1):** cada nodo dice además si quien llama puede editar el agente, con la regla que ya aplica la API al abrir una versión (`EditAgent` en Cedar y, en el proceso, quien lo creó o un administrador). Origen: la prueba del laboratorio mostró que «Editar» lleva a «No puedes editar este agente» a un creador que no creó ese agente. No expone nada nuevo: un creador ya sabe qué agentes creó (`GET /api/agents/mine`) y un administrador edita todos. Es solo para mostrar; el Agent Builder autoriza cada petición. **La pantalla no cambia todavía:** qué hacer con «Editar» está pedido a Claude Design (`docs/design/briefs/sync-2026-10-04c.md` §3.2 y §3.3, [D24](D024-diseno-de-la-ui.md)).

**(6) La pantalla usa `can_edit` (2026-10-04, ronda undécima de Claude Design):** «Editar» sale solo con `can_edit`; a quien puede crear agentes y no puede editar ese, el panel le dice «Solo quien lo creó o un administrador puede editarlo.» y la caja «No puedes usar este agente» le pide acudir a quien lo creó o a un administrador. El diseño nombra además a quien lo creó («({creador})») y admite omitirlo si no se conoce. **Se omite por decisión del usuario:** el Org Chart sigue sin nombrar a ninguna persona ni decir quién creó un agente ajeno (punto 2 y TM-M17); la API no cambia
