# D120 · El stream del chat pasa a parches JSON (`v1`) sobre mensajes con `recipient` y `channel`, numerados y reanudables

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Migrar a parches JSON»; el cómo, puntos 2 a 8, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** reemplaza el formato de eventos de [D57](D057-progreso-del-turno-en-vivo.md) (la fase del turno, calculada por `mango-api` y sin texto del modelo, se conserva como dato del mensaje); precisa [D39](D039-sesion-del-runtime-y-latencia.md) (el texto sigue llegando en los bloques que revisa el guardrail: cada bloque es un parche)
- **Precisada por:** — (notas de la construcción R3 al final de este archivo)

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). Hoy el chat recibe nueve eventos SSE propios, sin `id:` ni reanudación. Las capacidades nuevas (bloque de código, figuras, archivos, gráficas, Canvas) necesitan un mensaje con partes que cambian durante el turno, y los turnos largos necesitan retomar el stream.

**(1) Formato (elegido por el dueño, por menú: «Migrar a parches JSON»).** El stream manda parches JSON sobre un modelo de mensajes con `recipient` y `channel`, como el cliente de ChatGPT. Se reescriben el cliente y el mock de desarrollo.

**(2) Mensajes (propuesto por un agente).** `{id, author.role, recipient, channel, content_type, content, status, metadata}`. Una llamada al sandbox es un mensaje con `recipient: "code.run_python"`, y su resultado, otro. La fase del turno de [D57](D057-progreso-del-turno-en-vivo.md) va en los metadatos del mensaje, igual de calculada por `mango-api` y sin texto del modelo.

**(3) Parches (propuesto por un agente).** El stream empieza con `event: delta_encoding` y `"v1"`. Cada delta es `{c, p, o, v}`: canal, ruta JSON Pointer, operación (`add`, `replace`, `remove`, `append`, `truncate` o `patch`) y valor. `c`, `p` y `o` se heredan del delta anterior; `v` nunca. El aplicador del cliente es inmutable y rechaza las claves `__proto__`, `constructor` y `prototype`.

**(4) Numerados y reanudables (propuesto por un agente).** Cada evento lleva `id:` con su número. El trabajador del turno ([D121](D121-trabajador-de-turnos.md)) los escribe en `Conversations` (`TURN#<turn>#EVT#<seq>`, con 4 horas de vida) y `GET /api/chat/turns/{turn}/stream?after=<n>` los lee desde cualquier tarea de `mango-api`. El cliente reintenta 12 veces (300 ms × 1,5, tope de 5 s, jitter del 50 %) ante un corte o un 408, 409, 425, 429, 502 o 504, y muestra «Reconectando».

**(5) El guardrail (propuesto por un agente).** El texto sigue llegando en bloques revisados por el guardrail síncrono ([D39](D039-sesion-del-runtime-y-latencia.md)); cada bloque es un `append` sobre el contenido del mensaje.

**(6) Mantener la conexión (propuesto por un agente).** El servidor manda un latido por debajo del tiempo de lectura del origen en CloudFront, con un test que lo fije.

**(7) Transición (propuesto por un agente).** El formato antiguo se retira en un PR propio (R5 del plan), y solo después de una semana con el nuevo instalado sin regresiones.

**(8) Seguridad (propuesto por un agente).** Las rutas de los parches se validan contra el modelo de mensajes; el Markdown del modelo sigue sin HTML crudo; el estado «Reconectando» y el del turno interrumpido salen de una ronda de Claude Design ([D24](D024-diseno-de-la-ui.md)).

## Notas de la construcción (R3, 2026-11-07; propuestas por un agente, se aceptan cuando el dueño integre el cambio)

Lo que el servidor del protocolo (R3) precisa de los puntos 2 a 4, 6 y 8. La web lo adopta en R4; hasta entonces `POST /api/chat` sigue con el stream de D57.

- **Rutas:** `POST /api/chat/turns` (el mismo cuerpo y la misma autorización que `POST /api/chat`) responde `{conversation_id, turn_id}` sin stream; `GET /api/chat/turns/{turn}/stream?after=<n>` lee el turno desde cualquier tarea de `mango-api`; `POST /api/chat/turns/{turn}/cancel` es «Detener» ([D121](D121-trabajador-de-turnos.md) (7)). Solo el dueño: el turno se busca en su partición y Cedar decide `OwnConversation` (auditado), con el mismo 404 para el de otra persona, para uno que no existe y para una denegación (TM-TW3). Cada conexión al stream cuenta en un límite compartido por persona, 60 por minuto (`chat.stream_reads`, TM-TW6).
- **Se traduce al leer:** el trabajador sigue escribiendo los eventos de D57 en `TURN#<turn>#EVT#<seq>` y `mango-api` los traduce a deltas al leerlos, con una función pura del registro: los mismos eventos dan siempre los mismos deltas. Así los dos formatos conviven hasta R5 sobre el mismo registro.
- **Mensajes:** un canal `c` por mensaje. El canal 0 es la respuesta (`author.role: "assistant"`, `channel: "final"`, `content_type: "text"`, el texto en `content.text`); en sus metadatos van la fase del turno de D57 (`metadata.phase`), las búsquedas en knowledge bases, las solicitudes de aprobación, las conexiones que pide un MCP remoto, y al final `metadata.result` (lo que traía `done`) o `metadata.error`. Cada llamada a una tool es un mensaje con `recipient` = su nombre y `content_type: "tool_call"`, y su resultado otro, con `author.role: "tool"` y `content` vacío ([D90](D090-actividad-de-los-agentes.md) (3)). Estados de un mensaje: `in_progress`, `finished`, `error` e `interrupted` (el turno detenido).
- **Numeración:** cada delta lleva `id:` con su número, desde 1, y `after` es el último que el cliente aplicó. Al reanudar, el servidor rehace la traducción desde el primer evento sin enviarla y sigue en `after + 1`. El primer delta de cada conexión lleva `c`, `p` y `o`, para que la herencia nunca dependa de otra conexión; el cliente conserva sus documentos entre conexiones.
- **Un turno que no llegó a empezar** (presupuesto agotado, conversación ocupada, token sin margen…) no responde un error HTTP en el stream, que el cliente reintentaría con un 409: termina con su mensaje en `error` y `metadata.error` = el mismo `status`, `code` y `message` que respondía `POST /api/chat`.
- **El final:** después del último delta, `event: message_stream_complete` (`conversation_id`, `turn_id`) y `data: [DONE]`, cuando el trabajador ya cerró el turno (mensaje, liquidación y título). Latido (`: ping`) cada 15 s, la mitad del tiempo de lectura de 60 s del origen de la API en CloudFront, con un test que lo fija.
- **Rutas de los parches (punto 8):** el servidor solo escribe las rutas de `MESSAGE_PATHS` (test); el texto del modelo solo va en `v`. Hay un aplicador de referencia en Python, solo para los tests, con las reglas del de la web de R4 (herencia de `c`, `p` y `o`, nunca de `v`; `truncate`; bloqueo de `__proto__`, `constructor` y `prototype`; inmutable).
