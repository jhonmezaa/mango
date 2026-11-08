# D125 · MCP Apps de solo lectura, con su interfaz curada en el perfil firmado

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Solo lectura, ui:// curado en el perfil (Recomendada)»; el punto 6, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07, en el modelo de amenazas; el cómo, puntos 2 a 5, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** precisa [D98](D098-contratos-de-los-mcp-remotos.md) (16) (el Gateway sigue sin dejar pasar `resources/read`: el HTML de la app viene del perfil firmado, no del servidor) y [D93](D093-mcp-remotos-de-terceros.md) (3) y (8) (el `_meta.ui` de una tool está curado en el perfil; el interceptor sigue borrando el `_meta` del modelo y del servidor); respeta [D93](D093-mcp-remotos-de-terceros.md) (2) (solo lectura)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). MCP Apps (especificación del 2026-01-26) deja que una tool MCP traiga una interfaz HTML (`ui://`) que el cliente muestra en un iframe.

**(1) Qué (elegido por el dueño, por menú: «Solo lectura, ui:// curado en el perfil (Recomendada)»).** Las MCP Apps llegan solo a MCP de solo lectura, y su interfaz no la sirve el servidor: la trae curada el perfil firmado de la release, con el hash de su HTML. Sus `tools/call` pasan por el Gateway, Cedar y el presupuesto, como las del modelo.

**(2) El perfil (propuesto por un agente).** El ítem de la tool en el perfil firmado ([D93](D093-mcp-remotos-de-terceros.md) (3)) gana un `_meta.ui` curado: el HTML con su hash y la CSP que declara. El pipeline de la release verifica el hash. El interceptor del Gateway sigue borrando el `_meta` que pongan el modelo o el servidor ([D93](D093-mcp-remotos-de-terceros.md) (8)), y el Gateway sigue sin `resources/read` ([D98](D098-contratos-de-los-mcp-remotos.md) (16)).

**(3) El host (propuesto por un agente).** La app corre en el runner del segundo origen ([D123](D123-segundo-origen-para-codigo-no-confiable.md)) con el host de MCP Apps: `ui/initialize`, `tool-input`, `tool-result` y `request-display-mode`.

**(4) Las llamadas de la app (propuesto por un agente).** Cada `tools/call` de la app vuelve por la SPA a `mango-api`, que la autoriza, la reserva y la manda al Gateway con el token de la persona y la firma de la invocación: Cedar L2 y presupuesto como una tool del modelo, y solo tools `read`.

**(5) Diseño (propuesto por un agente).** El marco de una app en el chat sale de la ronda de Claude Design de su fase ([D24](D024-diseno-de-la-ui.md)).

**(6) Lo que fijó el modelo de amenazas (2026-11-07, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07).** El modelo [`ui-sandbox-threat-model.md`](../../security/threat-models/ui-sandbox-threat-model.md) fija que, en v1, el host solo atiende los métodos del punto 3 y `tools/call`; `ui/message`, `ui/update-model-context`, `ui/open-link` y las descargas responden «no admitido» hasta una decisión propia (TM-UI7). Una app solo llama tools de su propio ítem del perfil y visibles para la app, con un límite por app y por turno y otro por persona y minuto, y su `tools/call` se audita con origen «app» (TM-UI6). El brief del marco (punto 5) pide, fuera del iframe, la etiqueta de su origen («app de <MCP>»), para que una app no se haga pasar por Mango (TM-UI10).
