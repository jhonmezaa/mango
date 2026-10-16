# D81 · Una ejecución por evento que encuentra su tarea ocupada espera a la anterior

- **Estado:** vigente
- **Fecha:** 2026-10-16 (tomada por el dueño ese día, por menú: «Que espere a la anterior (Recomendada)»; el cómo y el límite, propuestos por un agente; los motivos `task_paused` y `paused_by_admin` en la pantalla, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-10-15, por menú: «Códigos + texto mínimo (Recomendada)»)
- **Precisa / reemplaza a:** precisa [D78](D078-tareas-sin-chat.md) (4) y [D79](D079-investigacion-de-anomalias-por-evento.md) (3)
- **Precisada por:** —

## Decisión

Origen: la primera noche de la instalación del cliente con una tarea de anomalía de costo activa (D79 (13)). AWS publicó 5 anomalías en 3 entregas entre el 2026-10-15 y el 2026-10-16, dos de ellas con dos eventos a la vez, y en las dos la segunda quedó «Omitida» con `overlap` (D78 (4): una ejecución a la vez por tarea). **2 de 5 no se investigaron, entre ellas la de mayor impacto.** Además, la marca de idempotencia de la ejecución (`RUNKEY`, cuyo id sale del id de la anomalía) se escribe antes del `hold`: una omitida por solapamiento gastaba la única ejecución de esa anomalía (D79 (3)), y aunque AWS la volviera a publicar ya no se investigaba.

**(1) Esperar en vez de omitir (tomada por el dueño el 2026-10-16, por menú).** Solo para las ejecuciones por evento (`trigger = event`): la que encuentra la tarea ocupada no se omite. Queda «En cola» (`queued`, el estado que la pantalla ya muestra) y corre cuando la anterior termina. Su anomalía no se pierde. Las ejecuciones por horario y «Ejecutar ahora» no cambian: siguen quedando «Omitida» con `overlap`.

**(2) Lo que se mantiene (tomada por el dueño el 2026-10-16).**
- Una ejecución a la vez por tarea (TM-T5).
- El tope de 5 al día, que se comprueba cuando la ejecución arranca de verdad: esperar no cuenta.
- Una sola ejecución por anomalía: un evento repetido sigue corriendo una vez; la espera no crea otra ejecución ni salta la marca `RUNKEY`.
- Un mensaje nunca trae autoridad (D78 (12)): al reanudar se releen la tarea y su dueño y se repiten todas las comprobaciones (retirada, pausada por su dueño o por un administrador, acceso perdido, persona central, tope, presupuesto).

**(3) Cómo espera (propuesto por un agente).** Con un mensaje con retraso que reanuda la misma ejecución, sin que nada duerma:
- La primera vez que encuentra la tarea ocupada, `mango-api` deja en la cola de ejecuciones un mensaje `wait` con `DelaySeconds` de 60 s (`WAIT_POLL_SECONDS`): la tarea, el evento y un `wake` de 128 bits aleatorios. La ejecución guarda ese `wake` y cuándo empezó a esperar (`waiting_since`). El mensaje que se estaba manejando se borra como cualquier otro: una espera nunca falla, no gasta recepciones y nunca llega a la cola de errores ni a la alarma `TaskRuns-failed`.
- Al llegar el `wait`, solo vale si la ejecución sigue «En cola» y guarda ese mismo `wake`; si no, no hace nada (ya corrió, se omitió, u otro mensaje tomó su espera). Si la tarea sigue ocupada, deja otro `wait` con un `wake` nuevo, sin pedir el token del dueño. Si está libre, sigue el camino completo de una ejecución nueva.
- El mensaje se envía antes de pasar la espera a él: si SQS falla, la ejecución no cambia y el mensaje que se manejaba se entrega otra vez, que retoma la espera.
- Un evento repetido (AWS publica otra vez la misma anomalía, o SQS entrega dos veces) no crea otra ejecución ni otra espera. Si la ejecución quedó «En cola» sin espera porque una entrega falló antes, la siguiente entrega del mismo evento la retoma.
- El `hold` ya no deja que la misma ejecución lo tome dos veces, y tras tomarlo se relee la ejecución: dos entregas de una ejecución nunca corren las dos.
- Las otras formas que dejaba el menú: reanudar la siguiente al soltar el `hold`, con un respaldo si el worker cae (más rápida, pero necesita igual el respaldo y otro índice para encontrar quién espera), o dormir en un hilo (prohibido: hay dos por tarea de `mango-api`).

**(4) El límite (propuesto por un agente).** 30 minutos desde que empezó a esperar (`WAIT_SECONDS`): dos `hold` completos (`HOLD_SECONDS`, 750 s, el turno más largo con su margen). Así la espera dura más que la ejecución anterior aunque esta llegue a su límite, y que otra que esperaba antes. Si al cumplirse la tarea sigue ocupada, la que espera queda «Omitida» con `overlap`, el mismo motivo y el mismo texto de hoy («Otra ejecución seguía en curso»). Un `hold` más viejo que `HOLD_SECONDS` es de una tarea de `mango-api` que murió y no detiene la espera. Con 60 s entre vistazos, una espera son como mucho 30 mensajes y dos lecturas de la tabla por vistazo.

**(5) Motivos nuevos en la pantalla (elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-10-15, por menú).** Una ejecución que esperaba y encuentra su tarea pausada queda «Omitida»: `task_paused` («La tarea se pausó») si la pausó su dueño y `paused_by_admin` («Un administrador pausó la tarea»), el código que ya usaba «Ejecutar ahora» y que la pantalla mostraba en crudo. Se añaden a la lista de motivos con lo mínimo y se reportan a Claude Design en la lista de motivos de 2.7 del brief del hito (D24).

**(6) Auditoría (propuesto por un agente).** `task.run.waiting` (tarea, ejecución, evento y dueño, sin contenido) la primera vez que una ejecución espera; lo demás no cambia (D78 (13)).

Comprobado con tests de Python (`apps/api/tests/test_tasks.py`: dos anomalías a la vez, el límite, una tarea de `mango-api` muerta, un evento repetido y un `wait` repetido o inventado, pausada o retirada mientras espera, acceso perdido mientras espera, el tope contado al arrancar, nada a la cola de errores, SQS que falla, por horario y a pedido igual; `packages/py/mango-core/tests/test_task_runs.py`: el mensaje `wait`) y de la web. Modelo de amenazas: TM-T5 y TM-T9 de [`tasks-threat-model.md`](../../security/threat-models/tasks-threat-model.md). **Sin ver en una instalación.** Sin cambios de infraestructura: `mango-api` ya podía enviar a la cola.
