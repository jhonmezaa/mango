# D97 · «Desconectar» un MCP remoto borra el token de la persona del vault con `forceAuthentication`; P9 se prueba antes de habilitarlo

- **Estado:** vigente
- **Fecha:** 2026-10-27 (elegida por el dueño ese día, por menú: «Borrar el token con forceAuthentication (Recomendada)» y «Construir ya; P9 antes de habilitarlo (Recomendada)», después de las pruebas de ese día)
- **Precisa / reemplaza a:** reemplaza [D96](D096-desconectar-un-mcp-remoto.md) (3) (la marca por persona) y corrige D96 (1) y (2) (P7b usó una clave de `_meta` equivocada); precisa [D94](D094-consentimiento-iniciado-por-el-gateway.md) (1) (P6 usó la misma clave equivocada) y D94 (4) (lo que queda antes de construir); precisa [D93](D093-mcp-remotos-de-terceros.md) (8) (qué `_meta` deja pasar el interceptor `REQUEST`)
- **Precisada por:** —

## Decisión

Origen: las pruebas del 2026-10-27 en el mismo tenant y la misma organización de pruebas del dueño, con un laboratorio temporal en la cuenta del cliente, creado con la aprobación del dueño, recurso por recurso, y borrado ese mismo día. Hallazgos e informe fuera del repositorio.

**(1) La clave correcta.** El Gateway lee el `_meta` de un `tools/call` 3LO con esta forma (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-auth-ex-3lo.html):

```json
{"aws.bedrock-agentcore.gateway/credentialProviderConfiguration":
  {"oauthCredentialProvider": {"returnUrl": "…", "forceAuthentication": true}}}
```

P7b (D96 (1)) y P6 (D94 (1)) mandaron `forceAuthentication` y `returnUrl` sueltos en `_meta`, una clave que el Gateway no lee. Por eso sus conclusiones no valían: ni «el Gateway ignora `forceAuthentication`» ni «un `_meta` del llamador no fuerza un consentimiento».

**(2) Lo que mostraron las pruebas.**
- **`forceAuthentication`** con el JWT de A y la clave correcta: el Gateway respondió que faltaba el consentimiento. En la llamada siguiente, sin `_meta`, A seguía sin token, y B siguió leyendo. **Borra del vault el token de una sola persona.**
- **Un `returnUrl` fuera de la allowlist** de la identidad de carga del Gateway: el Gateway no dio ninguna URL y devolvió un error genérico. Se rechaza.
- **Cerrar el consentimiento de A con el JWT de B**, en el flujo de D94: `CompleteResourceTokenAuth` respondió `AccessDeniedException`, y ninguna de las dos quedó con token.

**(3) «Desconectar» (reemplaza D96 (3)).**
- La persona lo pulsa en «Mis conexiones». `mango-api` hace por el Gateway un `tools/call` de una tool `read` del perfil, con el JWT de la persona y el `_meta` de (1) con solo `forceAuthentication: true`.
- **El interceptor `REQUEST` deja pasar ese `_meta` solo desde `mango-api`:** cuando la firma `X-Mango-Invocation` (D33) lleva una marca de desconexión que solo pone `mango-api` en esa llamada, como `pg` en D91. Y deja pasar exactamente `forceAuthentication: true`, nunca `returnUrl`. Sin la marca, borra todo `_meta`, como dice D93 (8), y también en las llamadas del modelo.
- La URL de consentimiento nueva que devuelve el Gateway la quita el interceptor `RESPONSE`, como siempre, y `mango-api` no la ofrece: la persona no pidió conectar.
- **El token sale del vault al instante.** Volver a conectar pasa por Microsoft, con el flujo de D94 (2). No hay marca aparte: si un agente usa la tool más tarde, el chat ofrece «Conectar», como a quien nunca se conectó.
- **Lo que no hace:** no revoca la autorización en Entra; el refresh token que tenía AWS deja de existir. La pantalla dice que Mango borró su conexión, no que Microsoft la revocó. El texto lo pone el diseño (D24).
- **Auditoría:** `mcp_remote.disconnect`, sin tokens. Si el Gateway no confirma el borrado (responde otra cosa que «falta el consentimiento»), `mango-api` responde un error y no audita la desconexión como hecha.

**(4) Sigue de D96.** El runbook (D96 (4)) se mantiene para cortar del lado de Microsoft o a todas las personas, y lo de no pedir una API a AWS (D96 (5)) también.

**(5) Antes de construir y antes de habilitarlo (precisa D94 (4)).** De lo que D94 (4) pedía probar antes de construir, solo queda P9 (el Acceso condicional, que necesita un tenant con licencia). Se construye ya. P9 se prueba antes de habilitar un MCP remoto en un cliente, no antes de construir.

Modelo de amenazas: [`remote-mcp-threat-model.md`](../../security/threat-models/remote-mcp-threat-model.md) (TM-006, TM-010 y TM-013).
