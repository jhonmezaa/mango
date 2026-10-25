# Contexto para Claude Design: la vista Actividad en el producto (2026-10-24)

La ronda 19 dibujó el modo «Disponible hoy» de «Actividad» (`activity.jsx`). El producto lo construye tal cual (D90, `propuesta`): `GET /api/activity` y la pantalla. Esto es contexto para la ronda siguiente, no una especificación: actualiza el diseño y `HANDOFF.md` con lo que corresponda. Lo que no tiene backend no se muestra con datos de ejemplo (D24).

## 1. Respuestas a lo que `HANDOFF.md` dejó pendiente

- **Un admin sí ve la tool de cada llamada de otra persona.** Ve también el resultado y la latencia. Es lo decidido en D90 (1): lo ajeno se ve solo como metadatos, y no se ve la persona, la conversación, la tarea ni la ejecución. Hoy el texto de la fila abierta dice «De otra persona: solo ves el agente, la tool y la hora.», pero la fila enseña además «error» o «N ms». El texto debería nombrar esos dos datos.
- **`budget.block`:** en el producto es `budget.exceeded`, el evento real del turno bloqueado. Lleva desde ahora qué presupuesto se agotó: el de la persona o el del agente. La Actividad muestra solo los turnos que bloqueó el presupuesto del agente («no respondió: se agotó el presupuesto»). Cuando se agota el de la persona, no es un evento del agente.

## 2. Lo que el producto construyó sin dibujo, con los patrones de otras pantallas

- **Carga:** un esqueleto de las filas y de «agentes más activos», con `role="status"`, como Gobernanza. Mientras carga, los KPI muestran un esqueleto en el valor.
- **Error:** «No se pudo cargar la actividad» · «Vuelve a intentarlo en unos segundos.» y «Reintentar», como Gobernanza.
- **Sin acceso** (403): el aviso de las pantallas de gobierno.

Hace falta dibujar los tres estados para Actividad.

## 3. Lo que el diseño muestra y el producto no puede dar

- **El texto bajo un error de tool** («Se agotó el tiempo de espera de Cost Explorer»): sale de la respuesta de la tool, y el producto no la guarda (D90 (3)). La fila de error no lleva línea debajo.
- **La descripción de la tool bajo «pidió aprobación para»:** la pantalla no tiene el catálogo de tools. La fila no lleva línea debajo; la descripción está en Aprobaciones.
- **El estado de la aprobación:** el diseño dice siempre «pidió aprobación para», aunque se haya ejecutado, rechazado o vencido. El producto conoce el estado y lo manda (`approval_status`). Si el diseño quiere otro verbo por estado, que lo dibuje: hoy se muestra el del diseño.

## 4. Límites que el diseño no dibuja

- **1.000 eventos por consulta.** En un periodo con más eventos, el producto trae los más recientes y avisa (`truncated`). La pantalla no dice nada, porque no hay un texto para eso. Hace falta uno (por ejemplo, «Se ven los 1.000 eventos más recientes del periodo»).
- **«En vivo» en el producto:** cada 15 s pregunta por los últimos 11 minutos, el turno más largo posible más un margen, y descarta lo que ya tiene. Así, el turno ajeno que termina tarde llega con la hora de cada llamada. Lo nuevo se marca con `is-fresh`, como en el diseño.
