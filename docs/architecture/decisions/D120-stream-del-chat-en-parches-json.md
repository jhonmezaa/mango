# D120 · El stream del chat pasa a parches JSON (`v1`) sobre mensajes con `recipient` y `channel`, numerados y reanudables

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Migrar a parches JSON»; el cómo, puntos 2 a 8, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** reemplaza el formato de eventos de [D57](D057-progreso-del-turno-en-vivo.md) (la fase del turno, calculada por `mango-api` y sin texto del modelo, se conserva como dato del mensaje); precisa [D39](D039-sesion-del-runtime-y-latencia.md) (el texto sigue llegando en los bloques que revisa el guardrail: cada bloque es un parche)
- **Precisada por:** —

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
