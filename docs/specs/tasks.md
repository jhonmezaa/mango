# Tareas: agentes que trabajan sin chat (hito 3, ola 1.1)

> Fecha: 2026-10-15 · Estado: **construido** (D78, propuesta). Este texto es el diseño de la fase 1; lo que se decidió después por menú está en D78, que manda donde difieran. Modelo de amenazas: [`../security/threat-models/tasks-threat-model.md`](../security/threat-models/tasks-threat-model.md). Contrato con la ola 1.2 (anomalías): sección «Interfaz».
> Manda: D26 («Schedules»), D56 (2), D73, D74, D25, D20, D24, D58, D76 y las reglas 3, 4 y 5 de `AGENTS.md`. A3 (solo leen; escribir espera, como D56) y A4 (entrega dentro de Mango) los decidió el dueño el 2026-10-15.

## 1. Qué se construye

Un agente publicado hace trabajo sin chat: **a pedido** («Ejecutar ahora») y **por horario**, con estados, historial y resultado visibles en la aplicación, con presupuesto reservado como un turno (D73) y corriendo como la persona que creó la automatización (D26). El modelo admite un tercer disparador, **por evento**, que monta la ola 1.2.

Pantalla: `docs/design/mango-hub/src/schedules.jsx` («Schedules» en Construir), tal cual (D24), con lo que no tiene backend como «Próximamente».

## 2. Modelo

**Automatización** (`schedule` en el diseño): la definición.

| Campo | Qué es | Quién lo pone |
|---|---|---|
| `automation_id` | ULID | servidor |
| `owner` | `sub` de quien la creó, su correo y su nombre (solo para mostrar) | servidor, del access token verificado; nunca cambia |
| `agent_id` | agente publicado | persona, validado contra L1 `UseAgent` |
| `name`, `task` | nombre (≤ 48) e instrucción («Tarea», ≤ 2.000) | persona; la tarea pasa por la detección de secretos de D26 |
| `trigger` | `manual`, `schedule` o `event` | persona (`event` solo lo crea la ola 1.2) |
| `schedule` | frecuencia del diseño (`15m`, `hourly`, `6h`, `daily`, `weekdays`, `days`, `weekly`, `monthly`), día(s), hora, minuto y zona horaria (lista cerrada) | persona; el cron lo calcula el servidor, nunca llega del cliente |
| `event_type` | p. ej. `cost_anomaly` | solo para `event` |
| `deliver` | `inbox` (único disponible en esta ola) | persona |
| `status` | `active`, `paused` (con `paused_reason`: `owner`, `admin`, `access_lost`), `retired` (con motivo, quién y cuándo) | servidor |
| `running_run` | id de la ejecución en curso, si hay una | servidor |

**Ejecución** (*run*): una invocación del agente sin chat.

| Campo | Qué es |
|---|---|
| `run_id` | determinista por disparador: `schedule` = hash(automatización, hora programada); `event` = hash(automatización, id del evento); `manual` = ULID. Idempotencia ante entregas repetidas |
| `trigger`, `scheduled_at`, `event_ref` | de dónde salió |
| `status` | `queued`, `running`, `ok`, `failed`, `skipped` (con motivo: presupuesto, acceso, otra en curso, agente retirado…), `approval` (propuso una escritura: queda la solicitud de D56) |
| `started_at`, `ended_at`, `cost_usd`, `turn_id` | como un turno; `turn_id` enlaza con la fila pendiente de D73 |
| `result` | texto del agente (Markdown sin HTML crudo), cortado a 32 KB; con su retención propia, nunca en logs |
| `error` | código fijo (`budget_exceeded`, `access_lost`, `upstream_error`…), nunca texto del modelo ni del evento |

Las dos viven en una tabla nueva `Mango-<ns>-Tasks` (on-demand, CMK, PITR, `RETAIN`, `deletionProtection`): `PK = AUTO#<id>`, `SK = META` o `RUN#<inverso de la hora>#<run_id>`; un GSI por dueño y otro por tipo de evento (`EVENT#<tipo>` → automatizaciones activas suscritas). TTL de las ejecuciones: **90 días** (propuesta; como las solicitudes de aprobación).

## 3. Dónde corre una ejecución

Un turno puede durar hasta el límite del agente (10 a 600 s, 120 por defecto) más el margen de lectura. Opciones:

| Opción | Cómo | Costo | Riesgo |
|---|---|---|---|
| **(a) En `mango-api`, desde una cola** (recomendada) | EventBridge Scheduler y «Ejecutar ahora» dejan un mensaje en la cola SQS `Mango-<ns>-TaskRuns` (CMK, DLQ). Cada tarea de `mango-api` tiene un consumidor en segundo plano (long polling, pocas ejecuciones a la vez por tarea) que reclama la ejecución con una escritura condicional y corre el mismo camino que `POST /api/chat`: autorización L1, reserva y fila pendiente (D73), firma de la invocación, harness, liquidación, auditoría | Bajo: reutiliza todo el código del turno sin moverlo | Trabajo de fondo en las tareas de la API (D73 (7) lo evitó para el conciliador, por otro motivo: leer las trazas de toda la cuenta). Una ejecución compite por CPU con el chat: se acota con la concurrencia |
| (b) Lambda `Mango-<ns>-TaskRunner` | Scheduler la invoca de forma asíncrona (DLQ) | Alto: mover el turno (`harness.py`, `budget.py`, auditoría, conversación) de `apps/api` a `mango-core`; es un refactor grande mezclado con la función | Dos copias del camino del turno mientras dura la migración |
| (c) Step Functions | Una máquina por ejecución | Alto: igual que (b) más la máquina | Igual que (b) |

Una tarea de `mango-api` que muere con una ejecución abierta deja la fila de D73 «abierta»: el conciliador la cierra como cualquier turno (fila 9). La ejecución se marca `failed` por plazo vencido en la siguiente lectura.

## 4. Planificador

- **EventBridge Scheduler**, una programación por automatización, creada, cambiada y borrada **por SDK desde `mango-api`** al crear, editar, pausar, reanudar o retirar (D25: nada se construye ni despliega; es una llamada a la API).
- Viven en un **grupo de programaciones** `Mango-<ns>-tasks` creado por la plantilla (`AWS::Scheduler::ScheduleGroup`). Las programaciones no aceptan tags (solo el grupo): el grupo lleva los del stack por CloudFormation (D76). **Borrar el stack borra el grupo y, con él, sus programaciones** (D58), sin tocar el `UninstallGuard`.
- Expresión `cron(...)` con `ScheduleExpressionTimezone` y la zona de la lista cerrada del diseño (`America/Mexico_City`, `America/Bogota`, `America/Sao_Paulo`, `UTC`). El servidor traduce la frecuencia del diseño a la sintaxis de Scheduler (6 campos, día de la semana 1–7).
- Destino: la cola, con un mensaje que solo lleva `{"v":1,"automation_id":…,"scheduled_at":<aws.scheduler.scheduled-time>}`. Rol propio del Scheduler con `sqs:SendMessage` solo sobre la cola y `kms:GenerateDataKey` de su llave. Ventana flexible apagada; sin reintentos del Scheduler más allá del suyo por defecto (la idempotencia la da el `run_id`).
- El mensaje nunca da autoridad: el consumidor relee la automatización y su dueño. Un mensaje con datos de más se descarta.

## 5. Identidad: actuar como el creador sin su sesión

Hoy la identidad llega al destino porque el access token de quien pregunta va al Gateway (`harness.py`): el Gateway lo valida (`CUSTOM_JWT`, cliente web), el interceptor exige la firma de `mango-api` (`X-Mango-Invocation`), los conectores lo vuelven a verificar y el broker asume roles con `SourceIdentity` = la persona. En una ejecución programada no hay token. Las opciones están en §5 del modelo de amenazas y se deciden por menú (fase 1).

**«Se pausa si pierde el acceso»**, en cualquier opción: al empezar cada ejecución, `mango-api` lee el estado de la persona **en Cognito** (precisado en D78 (20): antes del flujo, con `ListUsers` por sujeto) (habilitada, sus grupos, con la misma derivación de `mango_role`/`mango_central` que el pre-token) y vuelve a decidir L1 `UseAgent` con esos grupos y la versión servida del agente. Si falla: la ejecución queda `skipped` con `access_lost`, la automatización pasa a `paused` (`access_lost`), se audita (`task.paused`) y no se invoca nada ni se reserva presupuesto. Solo el dueño la puede reanudar, y solo si recupera el acceso (el servidor lo vuelve a comprobar).

## 6. Presupuesto y límites

- **Reserva** como un turno de chat: mismos dos ámbitos (persona y agente), misma estimación (D74), misma fila pendiente (D73) y mismo conciliador. Sin presupuesto: `skipped` con `budget_exceeded`, se audita y la automatización sigue activa (el diseño: «las próximas ejecuciones se omitirán»).
- **Límites propuestos** (constantes de la release, como los de D70):
  - automatizaciones activas o en pausa por persona: **10**; por instalación: **200**;
  - frecuencia mínima: **15 minutos** (la del diseño, con su aviso de «~2.880 ejecuciones al mes»);
  - tope de gasto por ejecución: la reserva del turno (no se agrega otro número);
  - concurrencia: **una ejecución a la vez por automatización** (si la anterior sigue, la nueva queda `skipped` con `overlap`); **dos a la vez por tarea de `mango-api`**;
  - «Ejecutar ahora»: **10 por persona y hora**, contado en `RateLimits` (D70).
- `POST /api/chat` sigue sin límite de tasa; las tareas sí tienen uno porque las dispara una máquina.

## 7. Quién puede qué

- **Ver la pantalla:** como el diseño (`OWNER_VIEWS`: administradores y FinOps central con el grupo de creadores).
- **Crear y editar:** quien puede crear agentes (`mango-agent-creator`) o es administrador, y **solo sobre agentes publicados que puede usar** (L1 `UseAgent`).
- **Ejecutar ahora, editar, reanudar:** solo el dueño (corre con su identidad).
- **Pausar y retirar:** el dueño o un administrador; retirar exige motivo. La pausa de un administrador frena también al dueño y solo la levanta un administrador, que además puede tomar la pausa del dueño (D78 (19) y (21)). El resultado de una ejecución solo lo ve su dueño (D78 (18)). Retirada no vuelve; el historial se conserva.
- Acciones nuevas en Verified Permissions: `CreateTask` y `ManageTask` (por objeto, con el dueño como atributo).

## 8. Resultado, entrega y escrituras

- El resultado se guarda en la ejecución (tabla `Tasks`, retención de 90 días) y se ve en la aplicación. **Ver §10:** el diseño no tiene dónde mostrarlo.
- «Bandeja del creador» es la única entrega de esta ola (A4). «Crear ticket» y «Canal de Slack», «Próximamente».
- **Escrituras (A3):** la ejecución corre sin approval token posible. Si el agente pide una tool de escritura, el Gateway la rechaza y `mango-api` crea la solicitud de D56 a nombre del dueño; la ejecución termina `approval` y el dueño la ejecuta después desde su propia sesión («Ver aprobación»).
- Lo que trae un evento entra como **dato no confiable**, delimitado y nunca como instrucción del sistema (inyección indirecta).

## 9. Auditoría

Eventos nuevos, sin contenido (ni la tarea ni el resultado): `task.created`, `task.updated`, `task.paused` (con motivo), `task.resumed`, `task.retired` (con motivo), `task.run.started`, `task.run.finished` (estado, costo, `turn_id`), `task.run.skipped` (motivo). El turno de una ejecución emite además `agent.invoke` y `agent.completed` como el chat, con `trigger` y `automation_id`. El actor de una ejecución programada es el dueño, marcado `via: task`.

## 10. Lo que no cuadra con el diseño (D24, se reporta antes de construir)

1. **El resultado de una ejecución no se ve en ninguna parte.** «Ejecuciones recientes» muestra estado, duración y costo, y la Bandeja (que no está construida) no tiene un tipo «ejecución». Hace falta dónde leer la respuesta del agente.
2. **«Crear ticket» aparece disponible** en el editor; los tickets no existen y A4 deja la entrega dentro de Mango: va como «Próximamente», igual que Slack.
3. **El selector de agente lista todos los agentes;** solo valen los publicados que la persona puede usar.
4. **La lista y el detalle no prevén el disparador por evento** (ola 1.2): lo reporta m3-anomalias.
5. **«Necesitan atención» por tools no disponibles** necesita leer el estado de los packs del agente: se construye con los datos que la API ya da; si no, «Próximamente».
