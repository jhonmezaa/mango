# D121 · El turno del chat corre en un trabajador fuera de `mango-api`

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Trabajador desde el inicio»; el cómo, puntos 2 a 8, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** precisa [D70](D070-dos-tareas-y-limites-compartidos.md) (6) (un despliegue de `mango-api` ya no corta un turno, porque el turno no vive en la petición) y [D78](D078-tareas-sin-chat.md) (2) (las ejecuciones de las tareas pasan por el mismo trabajador, no por las tareas de `mango-api`); respeta la regla 4 y la regla 5 de `AGENTS.md` y [D73](D073-turno-cortado-nunca-cuesta-cero.md)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). Hoy el turno vive dentro de la petición `POST /api/chat`: un despliegue drena 120 s y corta lo que dure más ([D70](D070-dos-tareas-y-limites-compartidos.md) (6)), y el sandbox de código alarga los turnos.

**(1) Desde la primera versión (elegido por el dueño, por menú: «Trabajador desde el inicio»).** El turno corre fuera de `mango-api` desde la primera versión; la petición SSE solo lee eventos.

**(2) El camino (propuesto por un agente).** `POST /api/chat` valida, autoriza (Cedar `UseAgent`) y encola el turno en `Mango-<ns>-ChatTurns` (SQS, llave propia, DLQ), y responde `{conversation_id, turn_id}`. El trabajador reserva el presupuesto (regla 4, antes de invocar), llama a `InvokeHarness`, traduce el stream a los parches de [D120](D120-stream-del-chat-en-parches-json.md), escribe los eventos y el mensaje final, y liquida. La SPA lee con `GET /api/chat/turns/{turn}/stream`.

**(3) El trabajador (propuesto por un agente).** `mango-turn-worker`: un servicio de ECS con la misma imagen que `mango-api` y otro punto de entrada, dos tareas, sin balanceador, con los permisos del turno que hoy tiene `mango-api`. Mientras corre un turno protege su tarea (protección de tarea de ECS), así que un despliegue espera a que termine. Antes de construirlo se prueba en AWS que esa protección detiene el despliegue y si la sesión del harness sigue cuando se corta el stream de `InvokeHarness` (R0 del plan, con autorización del dueño).

**(4) Identidad de la persona (propuesto por un agente).** El turno sigue corriendo como la persona: el Gateway recibe su token y la firma de la invocación (regla 5, [D13](D013-identidad-hasta-las-tools.md)). Cómo llega ese token al trabajador lo decide el modelo de amenazas del trabajador (PR P1 del plan), entre el token del turno en el mensaje de la cola, cifrado con su llave, y uno emitido para el turno como el de una ejecución de tarea ([D78](D078-tareas-sin-chat.md) (1)). Nunca en logs.

**(5) Tareas (propuesto por un agente).** Las ejecuciones de [D78](D078-tareas-sin-chat.md) pasan por el mismo trabajador y el mismo camino; la cola `Mango-<ns>-TaskRuns` sigue siendo su entrada.

**(6) Límites (propuesto por un agente).** Un turno a la vez por conversación, como hoy, y un tope de turnos a la vez por tarea del trabajador. El tope de 600 s de un turno no cambia.

**(7) Un turno cortado (propuesto por un agente).** Si el trabajador cae a mitad de turno, la reserva queda retenida y la concilia `BudgetReconciler` ([D73](D073-turno-cortado-nunca-cuesta-cero.md)); el turno queda interrumpido en el stream.

**(8) Antes de construir (propuesto por un agente).** Modelo de amenazas `turn-worker-threat-model.md` (PR P1 del plan). El paso al trabajador mantiene los mismos tests de extremo a extremo del chat antes de mover nada.
