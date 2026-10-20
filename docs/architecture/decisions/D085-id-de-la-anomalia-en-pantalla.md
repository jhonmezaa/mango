# D85 · El id de la anomalía se ve en cada ejecución

- **Estado:** vigente
- **Fecha:** 2026-10-16 (el punto 1, tomado por el dueño ese día, por menú: «Guardarlo y mostrarlo (Recomendada)»; el cómo, punto 2, propuesto por un agente; lo que mostró la instalación, punto 3, nota del 2026-10-20 propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D79](D079-investigacion-de-anomalias-por-evento.md) (4)
- **Precisada por:** —

## Decisión

Origen: la ronda de Claude Design del 2026-10-16b, que respondió al brief unificado. El diseño (D24) muestra en cada ejecución de una tarea por anomalía «Anomalía · {fechas} · {id corto}», con los 8 primeros caracteres del id, para distinguir las anomalías del mismo día, y el id completo en «Anomalía que la arrancó». Hasta ahora la ejecución guardaba solo las fechas.

**(1) El id de la anomalía se guarda y se muestra (tomada por el dueño el 2026-10-16, por menú: «Guardarlo y mostrarlo (Recomendada)»).** D79 (4) ya deja entrar a la ejecución el id, el monitor y las fechas; ahora el id también llega a la pantalla. Lo ven quienes ya ven la línea de la ejecución: su dueño y los administradores (D82). **El servicio, la cuenta y el impacto siguen fuera de la pantalla:** los lee el agente con su tool y van en el informe, que solo ve el dueño (D79 (4), D82 (3)).

**(2) Cómo (propuesto por un agente).**
- El worker de tareas guarda el `anomaly_id` del evento solo si es un UUID (se guarda en minúsculas) y solo junto con unas fechas válidas; cualquier otro valor no se guarda. No es texto escrito por personas.
- `RunOut.anomaly` gana `id` (nulo en las ejecuciones anteriores a esta decisión).
- La lista de ejecuciones muestra los 8 primeros caracteres en mono; la caja «Anomalía que la arrancó» del resultado, el id completo.
- Sin cambios de IAM, de tablas ni de lo que recibe el modelo.

Comprobado con tests de Python (`apps/api/tests/test_tasks.py`) y de la web, y en el navegador contra el mock. Visto en una instalación (punto 3).

**(3) Lo que mostró la instalación (nota del 2026-10-20, propuesta por un agente).** En la instalación de un cliente llegó una anomalía real y la tarea por anomalía de su dueño la investigó sola. La línea de la ejecución dice «Anomalía · {fecha} · {8 caracteres}» y la caja «Anomalía que la arrancó» del resultado, el id completo. Horas después, AWS volvió a publicar la misma anomalía con otro id de evento: el consumidor la recibió y el motor no arrancó una segunda ejecución, porque la clave es el id de la anomalía (D79). Como administrador que no es el dueño, la tarea se ve sin su resultado.
