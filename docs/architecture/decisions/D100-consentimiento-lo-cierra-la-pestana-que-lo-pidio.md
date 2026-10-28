# D100 · El consentimiento de un MCP remoto lo cierra la pestaña que lo pidió, con el mismo access token

- **Estado:** pendiente
- **Fecha:** 2026-10-28 (elegida por el dueño ese día, por menú: «Opción 1: decisión y brief (Recomendada)», después de investigar el fallo de la vuelta en la primera instalación)
- **Precisa / reemplaza a:** precisa [D98](D098-contratos-de-los-mcp-remotos.md) (1) (quién llama a `POST /api/oauth/callback` y con qué token); respeta [D94](D094-consentimiento-iniciado-por-el-gateway.md) (2) y [D63](D063-sesion-web-con-cookie.md)
- **Precisada por:** —

## Decisión

**(1) Por qué no vale como estaba.** Con D98 (1), la vista `/conexiones/vuelta` renueva la sesión de la SPA y llama a `POST /api/oauth/callback` con el access token que obtiene en ese momento. Pero AgentCore Identity compara el **mismo token** que inició el flujo, no la persona.
- **Lo que dice AWS:** la guía de *session binding* pide presentar «the original inbound identity provider OAuth token or `user_id` … that was used to generate the workload access token». Ese token se toma de la sesión activa del navegador, no de una caché del servidor.
- **Lo que confirmó soporte de AWS:** en un caso público igual al nuestro (Gateway 3LO contra Entra), un token nuevo de la misma persona falla siempre.
- **Lo que vimos en Nutresa** (2026-10-28, dos de dos intentos): el Gateway inicia el flujo con el token de la petición del chat. La vuelta es una carga nueva de la SPA, y como los tokens solo viven en memoria, siempre trae otro token. Identity responde `AccessDeniedException` y la persona ve «Este enlace no es tuyo».

**(2) Cómo queda.**
- **La vista de vuelta no cierra el consentimiento.** Toma el `session_id` de la URL, borra la query con `history.replaceState` y lo pasa a las pestañas de Mango del mismo navegador por un `BroadcastChannel` del mismo origen. El mensaje lleva solo el `session_id`. Después le dice a la persona que vuelva a su pestaña de Mango, o se cierra si la abrió la SPA.
- **La pestaña que pidió «Conectar» llama a `POST /api/oauth/callback`** con su access token en memoria, que es el mismo que usó el Gateway. Pidió «Conectar» desde la tarjeta del chat, del Playground o desde «Mis conexiones», y guarda en memoria el registro que espera.
- **Las demás pestañas ignoran el mensaje.** Si dos pestañas lo intentan, a la que no inició el flujo Identity le responde que no es suyo, y esa pestaña no muestra nada.
- **`mango-api` no cambia sus controles:** exige el consentimiento pendiente del `sub` verificado y cierra con `CompleteResourceTokenAuth` y el token que recibe.

**(3) El token no debe cambiar mientras el consentimiento está pendiente.**
- «Mis conexiones › Conectar» renueva la sesión justo antes de pedir la URL.
- Mientras la pestaña espera una vuelta (como mucho 10 minutos, lo que vale la URL), la SPA no renueva el token si sigue vigente.
- **Si el token cambió o la pestaña ya no existe,** el consentimiento no se puede cerrar. La persona lo pide de nuevo, con un texto propio del diseño.

**(4) Seguridad.**
- El `session_id` sigue solo en memoria. No se guarda en Web Storage ni en cookies, y el `BroadcastChannel` solo llega a páginas del mismo origen.
- TM-014 no empeora: un `session_id` ajeno que llega a la pestaña de la víctima se presenta con el token de la víctima, e Identity lo rechaza.
- Lo nuevo que hay que modelar es que cualquier pestaña del mismo origen en ese navegador recibe el `session_id`. Es la misma persona y la misma sesión de D63, porque la cookie y el origen son los mismos.
- El modelo de amenazas `remote-mcp` se actualiza en el cambio que lo construya.

**(5) Lo que se descartó.**
- **Cerrar con `userIdentifier.userId` (el `sub`):** no está documentado para flujos iniciados con un JWT, y no consta un caso que funcione.
- **Guardar en el servidor el token que inició el flujo:** AWS lo desaconseja y rompe las reglas de secretos.
- **Queda por evaluar en laboratorio el portal de consentimiento gestionado de AgentCore Identity** (2026-09): quitaría el *binding* propio. A cambio, la persona sale de Mango a una página de AWS, vuelve a iniciar sesión, y el chat solo puede mandarla al portal, no a un enlace directo.

**(6) Diseño primero (D24).** La tarjeta y «Mis conexiones» abren la URL de consentimiento como hoy. La vista de vuelta y los textos nuevos van al brief de la próxima ronda:
- «Vuelve a tu pestaña de Mango»;
- «La conexión se completó en otra pestaña»;
- «Pídelo de nuevo: tu sesión cambió o cerraste la pestaña».

Hasta que estén diseñados, la vuelta no funciona en una instalación.

Fuentes: [OAuth 2.0 authorization URL session binding](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html), [aws/bedrock-agentcore-sdk-typescript#37](https://github.com/aws/bedrock-agentcore-sdk-typescript/issues/37), [Configure a consent portal target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-configure-consent-portal-target.html).
