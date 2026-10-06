# D53 · Ronda de alineación con Claude Design (oct 2026): datos nuevos de la API

- **Estado:** vigente
- **Fecha:** 2026-10-02
- **Precisa / reemplaza a:** en el texto: precisa [D48](D048-desaprovisionamiento.md) (punto 2)
- **Precisada por:** —

## Decisión

**(1) `is_mine` en los agentes:** «Editar» y «Duplicar» solo para admins y para quien creó el agente; la API devuelve un booleano (creador = yo y con rol de creador), nunca el `sub` ni el correo del creador.

**(2) Estado de la limpieza al retirar (precisa [D48](D048-desaprovisionamiento.md)):** `mango-api` gana `states:ListExecutions` sobre `Mango-<ns>-AgentDeprovisioner` (sin `DescribeExecution`, `GetExecutionHistory` ni `StopExecution`) y devuelve a los admins `cleanup: running | done | failed` de los agentes retirados que pueden ver, a partir del nombre y el estado de la ejecución, nunca su entrada ni su salida. El reintento manual lleva el nombre `<id>-retire-manual-…`.

**(3) Servicio requerido por tool** (`requires_service`, p. ej. Compute Optimizer y Cost Optimization Hub en `aws-billing`): dato estático de la release en `mcp_catalog.py`; Mango no consulta a la pagadora si están activos, por eso el texto es «Requiere <servicio>» y no «sin activar» (usuario, 2026-10-02).

**(4) Cuentas miembro en Conectividad:** endpoint de solo admins que invoca la operación `member_access` del AdminProbe ([D51](D051-acceso-a-cuentas-miembro.md)); las cuentas objetivo las calcula el probe desde `orgAccess` (OUs y exclusiones) con las lecturas de Organizations que ya tenía; respuesta con textos fijos, sin ARNs; máximo 50 cuentas por comprobación.

**(5) Mandan los límites de la API** sobre los del diseño (usuario, 2026-10-02): 100 grupos, precio de modelo hasta USD 100.000 y `bu-lead` de tipo general.

**(6) Personas por correo en el Agent Builder:** excepción a la regla «Sin revelar si un usuario existe» para creadores de agentes y admins (usuario, 2026-10-02; tabla de excepciones de AGENTS.md): `POST /api/directory/users/resolve` con límites por llamada, por minuto y por día, auditoría (`directory.lookup`, sin la lista de correos) y `cognito-idp:ListUsers`/`AdminGetUser` sobre el User Pool. Las versiones siguen guardando identificadores. Usuarios federados (SSO): pendiente de decidir antes de habilitar un IdP.

Modelo de amenazas: TM-M23 y TM-M24 en `marketplace-v1-threat-model.md`
