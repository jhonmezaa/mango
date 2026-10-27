# D94 · El consentimiento de un MCP remoto lo inicia el Gateway; `mango-api` lo muestra y lo cierra (resultado de la prueba en vivo de D93)

- **Estado:** vigente
- **Fecha:** 2026-10-26 (elegida por el dueño ese día, por menú: «Lo inicia el Gateway (Recomendada)», después de la prueba en vivo de D93 (11))
- **Precisa / reemplaza a:** reemplaza el punto (4) de [D93](D093-mcp-remotos-de-terceros.md) (quién inicia el consentimiento); precisa D93 (8) (qué hace el interceptor `RESPONSE` con la URL), D93 (10) (los permisos de `mango-api` y del rol del Gateway) y D93 (11) (lo que dio la prueba)
- **Precisada por:** [D96](D096-desconectar-un-mcp-remoto.md) (P7 ya se probó; «Desconectar» es una marca en Mango)

## Decisión

Origen: la prueba en vivo de D93 (11), el 2026-10-26. Usó recursos temporales separados del Gateway de la instalación, cada uno creado con la aprobación del dueño, y borrados y comprobados ese mismo día. La organización de Azure DevOps y el tenant de Entra fueron de pruebas, del dueño. El informe y los hallazgos están fuera del repositorio. D93 decía que si P3 o P4 salían distinto, el punto 4 se volvía a decidir antes de construir: P4 salió distinto.

**(1) Lo que mostró la prueba.**
- **P4.** `GetWorkloadAccessTokenForJWT` sobre la identidad de carga del Gateway responde `ValidationException: WorkloadIdentity is linked to a service and cannot retrieve an access token by the caller`. Por eso `mango-api` no puede pedir la URL de consentimiento con esa identidad, como decía D93 (4).
- **El Gateway sí la pide.** Un `tools/call` sin token responde `-32042`, con `data.elicitations` y una URL de AgentCore Identity (protocolo `2025-11-25`). Después del login de Microsoft, Identity manda el navegador al `defaultReturnUrl` del target con `session_id`, sin ningún `state` de Mango. `CompleteResourceTokenAuth` con el JWT de la persona, llamado con credenciales que no son las del Gateway, deja el token en el vault, y la siguiente llamada lee Azure DevOps.
- **P3.** El harness entrega el `-32042` al modelo como el error de una tool. Si el error lleva la URL, el modelo la repite en su respuesta. Sin la URL, solo dice que falta conectar.
- **P8.** El token de una persona no le sirve a otra.
- **P6.** Un `_meta` del llamador no llega al interceptor `REQUEST` ni fuerza un consentimiento nuevo.
- **P11.** Unos 1,4 s por llamada (p95, 2,4 s).
- **P10.** Ante una inyección en una página de wiki, el agente no ejecutó la acción pedida, pero copió en su respuesta la URL del atacante.
- **P2 e IAM.** El esquema fijo da exactamente las tools `read` del perfil, con su hash. El secreto de la app queda en un secreto de Secrets Manager que Identity crea con el prefijo `bedrock-agentcore-identity!`, y se borra con el proveedor. El rol del Gateway necesita `GetResourceOauth2Token` también sobre `workload-identity-directory/default` y `token-vault/default`. Sin eso, el Gateway responde un error genérico, no un `AccessDenied`.
- **Sin probar:**
  - P7: el refresco y el borrado del token de una persona;
  - P9: el Acceso condicional, porque el tenant de pruebas no tiene la licencia;
  - si el Gateway respeta una URL de vuelta en `_meta` cuando sí hace falta consentimiento;
  - cerrar con el JWT de otra persona una URL ajena.

**(2) El flujo.**
- **Quién lo inicia.** El consentimiento lo inicia el Gateway, en el primer `tools/call` de la persona sin token: un turno de chat, una tarea (D78) o el Playground (D91).
- **El interceptor `RESPONSE`** quita la URL del resultado, como antes: nunca llega al modelo ni a los logs. Además se la entrega a `mango-api` ligada a la persona (el `sub` del JWT verificado de esa llamada) y al registro, con 10 minutos de vida, lo mismo que la sesión de Identity. Cómo se la entrega (por ejemplo, un ítem con TTL que el interceptor escribe en una tabla de `mango-api`) se fija al construir.
- **La pantalla.** `mango-api` muestra «Conectar» con esa URL en la tarjeta del chat y en «Mis conexiones». Antes valida que sea `https` y que el host sea el de AgentCore Identity.
- **«Conectar» desde «Mis conexiones», sin chat.** `mango-api` hace un `tools/call` de una tool `read` del perfil por el Gateway, con el JWT de la persona, igual que hizo la prueba. Si el vault ya tiene el token, responde «Conectado».
- **La vuelta.** El `defaultReturnUrl` del target es `/api/oauth/callback` de Mango. El callback exige la sesión web de la persona (D63) y un consentimiento pendiente de esa misma persona, y llama a `CompleteResourceTokenAuth` con el access token de esa sesión. El session binding de Identity impide cerrarlo con otra persona. El `customState` de un solo uso de D93 (4) no existe en este flujo: lo sustituye el consentimiento pendiente ligado a la persona, de un solo uso y de 10 minutos.
- **Sin consentimiento.** Las tareas sin consentimiento siguen fallando con «Conecta Azure DevOps» en la Bandeja, nunca con una URL (D93 (10)).

**(3) Permisos (precisa D93 (10)).**
- `mango-api` ya no necesita `GetWorkloadAccessTokenForJWT` ni `GetResourceOauth2Token`. Conserva `CompleteResourceTokenAuth`, más la lectura del consentimiento pendiente.
- El rol del Gateway añade el directorio y el vault a `GetResourceOauth2Token`.
- El resto de D93 no cambia.

**(4) Antes de construir.**
- Se prueban P7, el `_meta` con URL de vuelta y la URL ajena.
- P9 se prueba en un tenant con Acceso condicional.
- **El riesgo de P10** (un enlace de un tercero en la respuesta del agente) queda en el modelo de amenazas. La forma de mostrar en el chat los enlaces que vienen de tools remotas va en el brief de diseño de D93 (12): aquí no se decide.

Modelo de amenazas: [`remote-mcp-threat-model.md`](../../security/threat-models/remote-mcp-threat-model.md).
