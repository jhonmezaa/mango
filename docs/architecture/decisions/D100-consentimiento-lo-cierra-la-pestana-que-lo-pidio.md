# D100 · El consentimiento de un MCP remoto lo cierra la pestaña que lo pidió, con el mismo access token

- **Estado:** vigente
- **Fecha:** 2026-10-28 (elegida por el dueño ese día, por menú: «Opción 1: decisión y brief (Recomendada)», después de investigar el fallo de la vuelta en la primera instalación)
- **Precisa / reemplaza a:** precisa [D98](D098-contratos-de-los-mcp-remotos.md) (1) (quién llama a `POST /api/oauth/callback` y con qué token); respeta [D94](D094-consentimiento-iniciado-por-el-gateway.md) (2) y [D63](D063-sesion-web-con-cookie.md)
- **Precisada por:** —

## Decisión

**(1) Por qué no vale como estaba.** Con D98 (1), la vista `/conexiones/vuelta` renueva la sesión de la SPA y llama a `POST /api/oauth/callback` con el access token que obtiene en ese momento. Pero AgentCore Identity compara el **mismo token** que inició el flujo, no la persona.
- **Lo que dice AWS:** la guía de *session binding* pide presentar «the original inbound identity provider OAuth token or `user_id` … that was used to generate the workload access token». Ese token se toma de la sesión activa del navegador, no de una caché del servidor.
- **Lo que confirmó soporte de AWS:** en un caso público igual al nuestro (Gateway 3LO contra Entra), un token nuevo de la misma persona falla siempre.
- **Lo que vimos en la primera instalación** (2026-10-28, dos de dos intentos): el Gateway inicia el flujo con el token de la petición del chat. La vuelta es una carga nueva de la SPA, y como los tokens solo viven en memoria, siempre trae otro token. Identity responde `AccessDeniedException` y la persona ve «Este enlace no es tuyo».

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

**(6) Diseño primero (D24).** La vista de vuelta y los textos nuevos van al brief de la próxima ronda:
- «Vuelve a tu pestaña de Mango»;
- «La conexión se completó en otra pestaña»;
- «Pídelo de nuevo: tu sesión cambió o cerraste la pestaña».

El diseño los dibujó en su ronda 24 (respuesta del 2026-10-28) y se construyeron con la ronda 25.

**(7) Cómo lo construye la web** (precisado al construirlo, 2026-10-28; desde entonces, vigente):
- **«Conectar» abre el proveedor en otra pestaña,** no en la misma (precisa la nota de D98 sobre la web): la pestaña que pidió tiene que seguir viva con su token. Abre una pestaña vacía dentro del clic, le pone `opener = null` y la lleva a la URL ya validada. El diseño pedía que la vuelta supiera por `window.opener` que la abrió Mango; se decidió al construirlo (2026-10-28) no dejarlo, por seguridad: con `window.opener`, una página de AWS o de Microsoft podría navegar la pestaña de Mango a una copia de su ingreso (*reverse tabnabbing*). La vuelta intenta cerrarse sola unos 2 s después de «Listo» y, si el navegador no la deja, queda «Cerrar esta pestaña».
- **La vista de vuelta se pinta fuera de la sesión:** no inicia sesión ni llama a `mango-api`. Manda `{session_id, ref}` por el canal `mango-consent`, espera unos 3 s a que una pestaña diga que lo tomó (si no, «Pídelo de nuevo desde Mango») y muestra lo que esa pestaña responde. Si el proveedor volvió sin `session_id`, lo dice y se lo avisa a la pestaña que espera.
- **La pestaña que espera** guarda en memoria el registro, la hora y la *generación* de su access token. Al recibir el `session_id` responde que lo tomó; si su token cambió, no llama y dice «Pídelo de nuevo»; si no, cierra con `POST /api/oauth/callback`. Un `consent_not_yours` la deja esperando sin mostrar nada.
- **El token:** «Conectar» (en «Mis conexiones», y también en la tarjeta del chat y del Playground, que usan la misma llamada) renueva la sesión justo antes de pedir la URL, y mientras la pestaña espera (10 minutos como mucho) la SPA no renueva un token vigente. Un token a punto de vencer sí se renueva, y entonces la pestaña sabe que cambió.
- **«Conectado» en la tarjeta** no dice «El agente sigue con tu pregunta», como el diseño: el turno no continúa solo. Dice «Vuelve a enviar tu pregunta», que sí es cierto (se decidió al construirlo, 2026-10-28, y va al brief del diseño).

**(8) «Conectar» siempre inicia un consentimiento nuevo** (visto en la primera instalación, 2026-10-28). `POST /api/me/connections/{reg}/connect` entregaba el consentimiento pendiente si había uno. Pero el que deja un turno del chat lo inició el token de ese turno, y la pestaña acababa de renovar el suyo antes de pedir la URL, así que la vuelta seguía fallando con «no es tuyo». Ahora `connect` borra el pendiente y sondea el Gateway con el token de quien llama, que es el que la pestaña retiene y presenta al cerrar.

Fuentes: [OAuth 2.0 authorization URL session binding](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html), [aws/bedrock-agentcore-sdk-typescript#37](https://github.com/aws/bedrock-agentcore-sdk-typescript/issues/37), [Configure a consent portal target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-configure-consent-portal-target.html).
