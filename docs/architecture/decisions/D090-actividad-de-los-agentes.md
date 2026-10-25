# D90 · La Actividad: cada llamada a una tool, como metadatos que escribe `mango-api`; cada persona ve lo suyo y un administrador lo de todos

- **Estado:** vigente
- **Fecha:** 2026-10-24 (los puntos 1 a 6, respondidos ese día por menú con la opción «(Recomendada)», por el agente principal en nombre del dueño, que pidió esa noche seguir con las recomendadas; el punto 7, propuesto por un agente, con lo que pide la ronda de diseño 19; aceptada por el dueño el 2026-10-25, por menú: «Aceptar ambas (Recomendada)»; lo visto en la instalación, punto 8, nota del 2026-10-25 propuesta por un agente)
- **Precisa / reemplaza a:** precisa [D16](D016-observabilidad-de-agentes.md) (las llamadas a tools se registran, fuera de las trazas, como metadatos sin contenido), [D70](D070-dos-tareas-y-limites-compartidos.md) (un límite nuevo por tarea, `activity.reads`) y [D83](D083-la-bandeja.md) (2) (la partición de cada persona guarda también su actividad)
- **Precisada por:** —

## Decisión

Origen: la vista «Actividad» del menú Gobernanza (D24, `activity.jsx`) estaba en «Próximamente». Es operación, no gobierno: qué hacen los agentes, separado del Audit log. La propuesta (fase 1) se llevó al brief de Claude Design y la ronda 19 (2026-10-24) dibujó su modo «Disponible hoy», que manda donde difiere de la propuesta.

**(1) Quién ve qué (respondido el 2026-10-24, por menú: «Lo suyo; admin todo (Recomendada)»).** La vista sigue en `USER_VIEWS`. Cada persona ve la actividad de sus turnos de chat y de sus tareas, y las aprobaciones que pidió. Un administrador (`ViewAudit`) ve la de todos. De otra persona solo el agente, la tool, el resultado, la latencia y la hora: nunca quién fue, su conversación (D23), su tarea ni su ejecución. Ni el creador de un agente ve el uso que otros hacen de él.

**(2) La fuente: un evento propio de `mango-api` (respondido el 2026-10-24, por menú: «Evento propio de mango-api (Recomendada)»).** `mango-api` lee el stream del harness: ve empezar cada llamada (`toolUse`) y llegar su resultado (`toolResult`), con la identidad verificada, el agente y la conversación o la tarea. De ahí sale el evento. Lo que AWS ofrece no sirve para esta vista:
- **Métricas del Gateway** (`AWS/Bedrock-AgentCore`, dimensión `Name` = tool): por minuto, sin persona ni agente.
- **Logs vendidos del Gateway:** traen el cuerpo de cada `tools/call`, argumentos y resultado. Encenderlos rompería D16. Siguen sin configurar.
- **Spans del Gateway y del harness** (`aws/spans`, Transaction Search): sin persona; se escriben al terminar la invocación y son telemetría, sin entrega garantizada. Leerlos desde una pantalla es Logs Insights: 0,005 USD por GB escaneado, segundos por consulta, 100 consultas concurrentes y 10 `StartQuery` por segundo por cuenta, compartidas con el conciliador de D73.

**(3) Sin parámetros de las tools (respondido el 2026-10-24, por menú: «No mostrarlos (Recomendada)»).** Los argumentos y los resultados no se guardan en ningún sitio, como hasta ahora (D16, auditoría sin argumentos). El bloque de parámetros del diseño completo no está en «Disponible hoy».

**(4) Presupuesto: solo el turno que el presupuesto del agente bloqueó (respondido el 2026-10-24, por menú: «Solo bloqueos al 100 % (Recomendada)»).** No hay evento al pasar el 80 %. Para saber qué presupuesto bloqueó, `BudgetService.reserve` dice qué ámbito se agotó: el de la persona o el del agente. Si fue el de la persona, no es un evento del agente. `budget.exceeded` de la auditoría lleva desde ahora `scope` (`user`, `agent` o `null` si no se supo). El diseño lo llama `budget.block`; el producto usa su evento real.

**(5) Diferencias con el diseño (respondido el 2026-10-24, por menú: «Brief y construir ya (Recomendada)»).** Se llevaron al brief y la ronda 19 las resolvió: sin parámetros, sin estado de los agentes («de {n} publicados» para un administrador, «En tus conversaciones y tareas» para el resto; «sin actividad en el periodo» solo para administradores), «En vivo» cada 15 s y sin tickets. Tampoco hay publicaciones en ese modo.

**(6) 30 días (respondido el 2026-10-24, por menú: «30 días (Recomendada)»).** Cada evento caduca a los 30 días por el TTL de DynamoDB, como el índice de auditoría. La vista enseña hasta 7 días.

**(7) Cómo (propuesto por un agente).**
- **Qué se registra:** de cada llamada a una tool de la versión publicada, el nombre como lo muestra el chat, si salió bien y los milisegundos. Una tool con un nombre que no es de la versión no se registra: el nombre lo escribe el modelo (TM-LP1). La latencia va desde que el modelo terminó de escribir la llamada hasta que llegó el resultado: el tiempo de la tool. Una escritura que el Gateway rechazó, y la tool interna de los reportes (D87 (3)), no traen resultado y no se registran: su solicitud de aprobación o su informe dicen qué pasó.
- **Dos copias, porque la lectura de una persona nunca toca filas ajenas:**
  - **La de la persona,** en `Conversations`, en su partición (`USER#<sub>`, `SK = ACT#<ms><16 hex>`), con su cliente RLS (`dynamodb:LeadingKeys`), como la Bandeja. Se escribe en cuanto llega cada resultado: lo propio se ve al momento. En una tarea lleva además el nombre de la tarea, solo en esta copia.
  - **La de todos,** en `AuditIndex`, en particiones por día (`ACTIVITY#<día>`), aparte de las `DAY#` de la auditoría. Se escribe al terminar el turno, cada llamada con su hora («lo de otras personas, al terminar cada turno», ronda 19). Un turno bloqueado se escribe enseguida.
  - Sin tabla ni permiso de IAM nuevos.
- **La ruta:** `GET /api/activity?range=1h|24h|7d&since=<fecha ISO con zona>`. Exige L1 `ViewActivity`, una política nueva para toda persona de Mango (`policies/cedar/platform/activity-view.cedar`), auditada como lectura. `ViewAudit` decide si se leen las particiones de todos; esa decisión también se audita como lectura. Responde hasta 1.000 eventos con `truncated`, los agentes del alcance y los días de retención. `since` trae solo lo nuevo, para «En vivo». Aprobaciones con la regla de Aprobaciones (D56): las propias y, para un administrador, también las que necesitan aprobadores.
- **Límite de tasa:** 60 lecturas por minuto y persona, por tarea (`activity.reads`, como `agents.lists`): no sostiene ninguna excepción, y contarlo en la tabla añadiría dos llamadas a una ruta que se lee cada 15 s.
- **Escribir nunca rompe el turno:** un fallo se registra en el log sin datos del evento y el turno sigue.
- Modelo de amenazas: [`activity-threat-model.md`](../../security/threat-models/activity-threat-model.md).

**(8) Visto en la instalación (2026-10-25).** Con la versión que trae D90: el change set de `Core` añadió la política `ViewActivity`, sin IAM ni tablas. Un turno de chat con FinOps dejó su llamada en la partición de la persona (la política de sesión de las conversaciones permite escribirla) y su copia en `ACTIVITY#<día>` de `AuditIndex`. Un administrador vio sus llamadas y la de otra persona, esta con «De otra persona: solo ves el agente, la tool y la hora.» y sin enlace a la conversación. Las llamadas reales a tools de datos de cuentas tardaron entre 18 y 23 s.
