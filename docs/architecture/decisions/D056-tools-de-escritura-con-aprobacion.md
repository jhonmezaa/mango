# D56 · Tools de escritura con aprobación

- **Estado:** vigente
- **Fecha:** 2026-10-02
- **Precisa / reemplaza a:** construye [D27](D027-confirmacion-de-escritura-por-tramos.md); precisa [D43](D043-provisioner-de-packs.md) (3); en el texto: ajusta §4.5 (punto 2). Con [D27](D027-confirmacion-de-escritura-por-tramos.md) construido deja de regir [D40](D040-provisioner-de-agentes.md) (3), que esta fila no cita
- **Precisada por:** —
- **Tema en el registro original:** Tools de escritura con aprobación ([D27](D027-confirmacion-de-escritura-por-tramos.md) construido; precisa [D43](D043-provisioner-de-packs.md) (3))

## Decisión

**(1) Primera tool de escritura:** `aws-budgets.create_budget` en la pagadora, sin notificaciones; rol `Mango-<ns>-BudgetsOperator` con `budgets:ModifyBudget` solo sobre `budget/Mango-<ns>-*` (IAM no separa crear de modificar o borrar; la tool solo crea y la session policy de cada llamada nombra un único presupuesto) (usuario, 2026-10-02).

**(2) Quién ejecuta lo aprobado por terceros:** quien pidió la acción, con su propia sesión («Ejecutar», antes del vencimiento); aprobar no ejecuta nada y todo pasa por el Gateway y Cedar; no existe identidad de servicio que escriba. **Ajusta §4.5** (`waitForTaskToken`) (usuario, 2026-10-02).

**(3)** Approval token firmado con KMS, ligado a `hash(tool, args canónicos)`, de un solo uso y con vencimiento; el interceptor y el approval executor (`functions/approval-executor`, target `ops` del Gateway) lo verifican; fail-closed. El executor abre su sesión MCP antes del `tools/call` ([D47](D047-runtime-de-packs-y-sesiones-mcp.md)).

**(4)** El tramo lo calcula `mango-api` con los argumentos del stream del harness y la política; qué argumento es monto, cantidad o entorno lo declara el manifiesto del conector. Una solicitud conserva la política con la que nació.

**(5)** Solo se abren tools de escritura de **conectores de Mango** marcadas en `approval_tools`; los packs de terceros con escritura siguen rechazados. Aprueban admins y FinOps central (`ApproveToolCall`); las políticas las cambian solo admins, con doble aprobación.

**Riesgo aceptado (TM-W13):** partir una acción grande en varias por debajo del umbral (cada confirmación queda auditada; una política «Siempre» lo cierra).

Verificado en el laboratorio de punta a punta (autoconfirmación, un solo uso, separación de funciones, tramo de aprobadores).

Modelo de amenazas: `docs/security/threat-models/write-tools-approval-threat-model.md`
