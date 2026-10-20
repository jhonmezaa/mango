# D82 · Cualquiera con un agente crea tareas; un administrador no ve la instrucción y dice por qué pausa

- **Estado:** vigente
- **Fecha:** 2026-10-16 (los puntos 1 a 3, tomados por el dueño ese día, por menú: «Que cualquiera con un agente cree tareas» y «Las dos (Recomendada)»; el punto 4 y el cómo de los tres primeros, propuestos por un agente; el punto 4, aceptado por el dueño el 2026-10-16, por menú («Aceptar D82 (4)»); lo que mostró la instalación, punto 5, nota del 2026-10-20 propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D78](D078-tareas-sin-chat.md) (5), (18) y (19)
- **Precisada por:** —

## Decisión

Origen: la ronda de Claude Design del 2026-10-16, que respondió al brief de tareas (`docs/design/briefs/sync-2026-10-15-tareas.md`). El diseño (D24) abre «Schedules» a todos los roles y muestra «Nuevo schedule» a cualquiera con un agente publicado que pueda usar; pide un motivo a un administrador que pausa la tarea de otra persona, y que el dueño lo lea; y deja la instrucción de una tarea, como sus resultados, solo para su dueño. Las tres reglas cambian lo que decía D78, así que se registran aquí.

**(1) Cualquiera con un agente crea tareas (tomada por el dueño el 2026-10-16, por menú; precisa D78 (5)).** Ya no solo los creadores de agentes y los administradores: cualquiera con sesión puede crear y editar sus tareas. La política `CreateTask` de Verified Permissions (`policies/cedar/platform/tasks-create.cedar`) permite a toda persona de Mango, con la misma forma que `ViewApprovals`. Lo que limita una tarea sigue igual:
- L1 `UseAgent` sobre un agente publicado, con los grupos y personas de su versión, al guardarla y antes de cada ejecución (D78 (5)).
- Los límites de D78 (4): 10 tareas por persona, 200 por instalación, una ejecución a la vez, «Ejecutar ahora» 10 por hora y cambios 30 por hora.
- El presupuesto por persona y por agente de cada ejecución (D73).
- Las escrituras, como aprobación de su dueño (D56, D78 (11)).
- El disparador por anomalía de costo, solo para personas centrales (D79 (5)).

«Schedules» pasa a la lista de vistas de todos los roles (`USER_VIEWS`). `ViewTask`, `ControlTask` y `OwnTask` no cambian.

**(2) La pausa de un administrador lleva motivo, y el dueño lo lee (tomada por el dueño el 2026-10-16, por menú; precisa D78 (19) y (21)).** Cuando un administrador pausa la tarea de otra persona, sea una activa o tomando la pausa del dueño, la API exige un motivo de 1 a 200 caracteres (`reason_required` si falta). El motivo se guarda con la tarea y lo leen su dueño y los administradores («Motivo: …»); quién la pausó, solo los administradores (el dueño lee «un administrador»). Como el motivo de un retiro, es texto de la persona: no va a la auditoría ni a los logs, y se borra al reanudar. La pausa del dueño sigue sin motivo.

**(3) La instrucción de una tarea solo la ve su dueño (tomada por el dueño el 2026-10-16, por menú; precisa D78 (18)).** Como el resultado, la instrucción es del dueño: la API devuelve `task: null` a quien no es el dueño. Un administrador sigue viendo el nombre, el agente, el dueño, el disparador, el estado y, de cada ejecución, el estado, la duración, el costo, el motivo y la anomalía.

**(4) Lo demás que pide el diseño, sin cambiar reglas (propuesto por un agente; aceptado por el dueño el 2026-10-16, por menú).**
- **El resultado por pasos.** Una ejecución guarda, además del informe, lo que el agente escribió antes de cada llamada a una tool y el nombre de esa tool (`steps`, como mucho 20 de 2.000 caracteres). El nombre solo se guarda si es de una tool de la versión publicada: lo escribe el modelo (TM-LP1). Solo lo lee el dueño, como el resultado (D78 (18)), con la misma retención (D78 (6)). Las ejecuciones anteriores se muestran enteras, sin pasos.
- **Las fechas de la anomalía.** Una ejecución por evento guarda las dos fechas de la anomalía que la arrancó, solo si son fechas ISO válidas y en orden; nada más del evento (D79 (4)). Servicio, cuenta e impacto no llegan al motor, así que no se muestran.
- **Cuándo empezó a esperar** (`waiting_since`, D81): la pantalla dice «Espera a que termine la investigación anterior» y, al correr, «Esperó n min en cola».
- **Las próximas ejecuciones del editor**, calculadas por el servidor con la zona elegida antes de guardar (`POST /api/tasks/next-runs`): cálculo puro sobre un cuerpo validado, sin leer ni escribir nada.

Comprobado con tests de Python (`apps/api/tests/test_tasks.py`, `test_cedar_policies.py`) y de la web, y en el navegador contra el mock. Modelo de amenazas: TM-T4, TM-T8 y TM-T11 de [`tasks-threat-model.md`](../../security/threat-models/tasks-threat-model.md). Visto en una instalación (punto 5). En una actualización, el change set cambia la política `CreateTask` del almacén de políticas.

**(5) Lo que mostró la instalación (nota del 2026-10-20, propuesta por un agente).** En la instalación de un cliente:
- **La pausa de un administrador.** Un administrador pausó la tarea por horario de otra persona: la API exigió el motivo, el detalle dice «Pausada por {administrador}» con el motivo y «Ejecutar ahora» queda desactivado; el dueño lo lee en el mismo aviso. Queda en Auditoría `task.paused` con `reason: admin`. Después se reanudó.
- **Lo que ve un administrador.** La tarea de otra persona sin su instrucción ni su resultado (punto 3).
- **Cualquiera crea tareas.** Ninguna persona del directorio estaba sin grupos, y quitarle `mango-admin` a una de las dos dejaba una sola administradora sin otra que aprobara devolvérselo. Se preguntó en cambio al almacén de políticas de la instalación: una persona sin grupos ni rol obtiene `ALLOW` en `CreateTask` y `DENY` en una acción de administración. Sin ver desde la pantalla.
