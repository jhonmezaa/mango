# D96 · «Desconectar» un MCP remoto es un bloqueo por persona en Mango; el token del vault no se borra (resultado de P7)

- **Estado:** vigente
- **Fecha:** 2026-10-27 (elegida por el dueño ese día, en el chat, sobre la recomendación tras P7 y la investigación: «vamonos con tu recomendacion, pero el punto 4 no hagamos nada»)
- **Precisa / reemplaza a:** precisa [D93](D093-mcp-remotos-de-terceros.md) (8) (el interceptor `REQUEST` también rechaza a una persona desconectada), D93 (10) (la auditoría de `.disconnect`), D93 (11) (lo que dio P7) y D93 (12) («Desconectar» en «Mis conexiones»); precisa [D94](D094-consentimiento-iniciado-por-el-gateway.md) (4) (P7 ya se probó)
- **Precisada por:** —

## Decisión

Origen: P7 de la prueba en vivo de D93 (11), hecha la noche del 2026-10-26 en el tenant de pruebas del dueño, con dos personas, y la búsqueda posterior en la documentación de AWS y de Microsoft. Informe y hallazgos fuera del repositorio.

**(1) Lo que mostró P7.**
- **P7a.** Identity refresca el token solo: a los ~100 minutos del consentimiento las dos personas seguían leyendo sin pedirlo otra vez.
- **P7b.** `_meta: {"forceAuthentication": true}` en un `tools/call` no cambia nada: el Gateway lo ignora. No sirve para desconectar.
- **P7c.** «Revoke sessions» de una persona en Entra no cortó su acceso: siguió leyendo 1 h 38 min, hasta que se paró la prueba. Microsoft documenta que, tras revocar, la app conserva el acceso hasta que vence su access token, normalmente 1 hora (https://learn.microsoft.com/en-us/entra/identity/users/users-revoke-access). No se averiguó por qué duró más.
- **P7d.** Borrar el proveedor de credenciales corta a todas las personas al instante; el Gateway devuelve un error genérico.

**(2) Lo que no existe hoy (búsqueda del 2026-10-27).**
- AgentCore Identity no tiene una API para borrar el token de **una** persona del vault. Solo borrar el proveedor, que corta a todas.
- Quitar el permiso de la app en Entra (el `oauth2PermissionGrant`) no invalida los tokens ya emitidos (https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-delete?view=graph-rest-1.0). Con el consentimiento de administrador de D93 (6), además, la persona no puede quitarlo sola.
- El Consent Portal de AgentCore (septiembre de 2026) lista las conexiones de cada persona y permite conectar, pero no documenta cómo desconectar. Exige además que el Gateway valide un IdP OIDC con el scope `openid` (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-consent-portal.html). No se adopta ahora.

**(3) «Desconectar» es una marca por persona y registro en Mango.**
- La persona lo pulsa en «Mis conexiones». `mango-api` guarda una marca ligada a su `sub` y al registro remoto. Dónde se guarda se fija al construir.
- El interceptor `REQUEST` lee la marca en cada `tools/call` a un target remoto. Si la persona está desconectada, rechaza la llamada sin llegar a Microsoft y con el mismo `consent_required` sin URL de D93 (4). Si no puede leer la marca, rechaza (deny por defecto).
- El corte es **inmediato y por persona**. Vale para todo lo que pasa por el Gateway con su JWT: el chat, sus tareas (D78), que fallan con «Conecta Azure DevOps» en la Bandeja, y el Playground (D91).
- **El token sigue en el vault.** Mango deja de usarlo, pero no lo borra. Según Microsoft, un refresh token de Entra sin usar deja de servir a los 90 días (https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens); no se ha comprobado si Identity lo refresca mientras la marca está puesta.
- **Volver a conectar** quita la marca y sigue el flujo de D94 (2). Si el token del vault sigue valiendo, queda «Conectado» sin pasar por Microsoft; si no, el Gateway pide el consentimiento de nuevo.
- **La pantalla dice lo que pasa de verdad:** Mango deja de usar la cuenta de la persona, pero no borra su autorización en Microsoft. Nunca dice «borramos tu token». El texto lo pone el diseño (D24), en el brief siguiente; hasta entonces, «Desconectar» queda en «Próximamente».
- **Auditoría (precisa D93 (10)):** `mcp_remote.disconnect` al poner la marca y `mcp_remote.reconnect` al quitarla, sin tokens. Un rechazo por la marca se ve en Actividad (D90) como cualquier llamada rechazada.

**(4) Cuándo hay que cortar de verdad: el runbook.** La marca no protege si el token sale de Mango o si hay que cortar en el lado de Microsoft. Para eso, el runbook de operación ([`operations.md`](../../runbooks/operations.md)) dice:
- **Una persona, en el lado de Microsoft:** sacarla de la organización de Azure DevOps o deshabilitarla en Entra. Azure DevOps comprueba la pertenencia en cada llamada, así que se espera un corte inmediato. **Sin probar.** Se probará en un tenant de pruebas antes de anunciarlo a un cliente.
- **Todas las personas de un registro:** deshabilitarlo en Mango, lo que borra el proveedor (D93 (7)). Probado: P7d.
- **La baja de una persona en Mango** ya corta su uso: sin JWT no hay llamada (TM-010).

**(5) No se pide a AWS una API para borrar un token.** Elegido por el dueño: AWS tarda meses o años en publicar algo así. Si AWS la publica, o el Consent Portal trae «Desconectar», se vuelve a decidir.

Modelo de amenazas: [`remote-mcp-threat-model.md`](../../security/threat-models/remote-mcp-threat-model.md) (TM-010 y TM-013).
