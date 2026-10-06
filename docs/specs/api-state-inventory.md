# Estado en memoria de `mango-api` con varias tareas

> Fecha: 2026-10-06 · Decisión: [D70](../architecture/decisions/D070-dos-tareas-y-limites-compartidos.md) · Código: `apps/api/src/mango_api/`

`mango-api` corre con dos tareas (cuatro durante un despliegue). Cada tarea es un proceso con su propia memoria. Este inventario dice qué guarda cada una, qué pasa cuando hay varias y tras un reinicio, y qué se decidió.

**Regla para lo nuevo:** un límite de tasa nuevo se añade a `limits.py`, con su motivo, y es compartido salvo que se justifique lo contrario. Una caché nueva se añade a la tabla de abajo; si lo que guarda decide autorización o gasto, la comprobación que decide lee el dato directo.

## Límites de tasa

Los compartidos se cuentan en la tabla `Mango-<ns>-RateLimits` (`rate_limits.py`): el número vale para todas las tareas juntas y sobrevive a un reinicio. Si la tabla no responde, la llamada se rechaza (429). Los que son por tarea viven en memoria: con N tareas valen N veces, y un reinicio de la tarea los pone a cero.

| Límite (`limits.py`) | Número, por persona | Qué acota | Dónde se cuenta | Por qué |
|---|---|---|---|---|
| `people.reads` | 120 por minuto | Lecturas del directorio y de sus cambios | Compartido | Sostiene la excepción de `AGENTS.md` (2026-10-03 y 2026-10-04) |
| `people.invitations` | 20 por hora | Invitaciones | Compartido | Sostiene la excepción de `AGENTS.md` (2026-10-03) |
| `directory.emails` | 30 por minuto | Correos que un creador de agentes resuelve | Compartido | Sostiene la excepción de `AGENTS.md` (2026-10-02) |
| `directory.ids` | 300 por minuto | Identificadores resueltos a correos | Compartido | Cada uno es una lectura del user pool, cuya cuota comparte el ingreso |
| `mfa_reset.proposals` | 5 por hora | Solicitudes de restablecer MFA | Compartido | La solicitud responde si el correo existe (excepción del 2026-09-30) |
| `people.changes` | 200 por hora | Cambios de grupos y de acceso | Compartido | Cada uno escribe en el user pool |
| `people.proposals` | 20 por hora | Cambios que esperan a otro administrador | Compartido | Acota ruido en la doble aprobación |
| `group_admin.proposals` | 20 por hora | Cambios del registro de grupos | Compartido | Igual |
| `tool_policies.proposals` | 10 por hora | Cambios de políticas de tools de escritura | Compartido | Igual |
| `mcp.writes` | 10 por minuto | Solicitudes y ejecuciones de packs MCP | Compartido | Costo: pueden iniciar una máquina de estados (TM-B20) |
| `approvals.runs` | 10 por minuto | Ejecuciones de una tool de escritura aprobada | Compartido | Costo: cada una firma con KMS y llama al Gateway |
| `admin.probe` | 5 por minuto | Árbol de la organización y prueba de conexión | Compartido | Costo: invoca la Lambda de sondeo, que asume roles |
| `admin.member_access` | 5 por minuto | Comprobación de las cuentas miembro | Compartido | Costo: hasta 50 invocaciones del sondeo por llamada |
| `models.refreshes` | 5 por minuto | Actualizar el catálogo de modelos | **Por tarea** | Solo frena un bucle de la pantalla: dos listados gratuitos de Bedrock. N veces 5 no hace daño |
| `session.starts` | 10 cada 5 min | Crear una sesión web | **Por tarea** | Frena el bucle de una persona antes de que gaste la cuota de Cognito, que es de toda la cuenta. Desde D72 no hay un límite por IP detrás: la renovación es una operación firmada que no pasa por el WAF del user pool. Entrar no debe depender de una tabla más |
| `session.renewals` | 30 cada 5 min, por sesión | Renovar el access token | **Por tarea** | Igual, y está en el camino de cada recarga de la página |
| `agents.lists` | 30 por minuto | Listas de agentes: `GET /api/agents` (Marketplace) y `GET /api/agents/org` (organigrama), contadas juntas | **Por tarea** | Frena el bucle de una persona sobre dos rutas que cualquiera con sesión puede leer, cuestan varias lecturas y escriben un evento de auditoría cada una. No sostiene ninguna excepción, y contarlo en la tabla añadiría dos llamadas a la ruta que se quiere abaratar. La pantalla pide como mucho cuatro veces por minuto por pestaña; N veces 30 sigue muy por debajo de lo que sirve una tarea (D70 (11)) |

Ya se contaban en DynamoDB antes de D70, y no cambian: el cupo diario de correos del directorio (200 por día, `Settings`), los envíos a revisión por creador y día (`Agents`), una solicitud abierta por objeto en cada flujo de doble aprobación, y el presupuesto (`Budgets`).

**Latencia que añade un límite compartido:** una lectura consistente y una escritura condicional por llamada permitida (unos 10 ms en la misma región; estimado, no medido en una instalación), y dos lecturas en una llamada rechazada. Ninguna ruta con límite compartido está en el camino de un turno de chat: `POST /api/chat` no tiene límite de tasa (lo acota el presupuesto) y la renovación de sesión conserva su límite en memoria.

## Cachés y otras copias

| Qué | Dónde | Caduca | Con varias tareas | ¿Decide algo? | Decisión |
|---|---|---|---|---|---|
| Copia del directorio de personas | `people.DirectoryCache` | 30 s | Cada tarea tiene la suya | No: quién es administrador y el mínimo de dos se leen de Cognito en el momento | **Corregido:** cada cambio aplicado avanza una generación en `Settings` que todas leen antes de servir su copia (si esa lectura falla, la copia dura sus 30 s, como antes). Sin eso, la lista que la pantalla vuelve a leer tras un cambio podía mostrar el estado anterior. Altas por registro y cambios hechos fuera de Mango tardan hasta 30 s, como antes |
| Agente publicado (versión, grupos y personas con acceso, tools) | `published.PublishedAgents` | 15 s | La tarea que retira un agente deja de servirlo al instante; las demás, en 15 s como mucho | Sí: sus grupos entran en la decisión `UseAgent` | Aceptado: 15 s ya era el retraso de toda publicación (la hace el provisioner, no `mango-api`). Un agente retirado puede responder un turno más en la otra tarea durante esos segundos |
| Versiones publicadas y retiradas que muestran las listas de agentes (Marketplace y organigrama) | `agents_store.ListedVersions` | 15 s | La tarea que retira un agente lo muestra retirado en su siguiente lectura; las demás, en 15 s como mucho. Una publicación (la hace el provisioner, no `mango-api`) aparece en cada tarea en 15 s como mucho | No. Lo que guarda no depende de quién pregunta: cada petición pide su propia decisión `UseAgent` sobre esas versiones con los grupos de su token, y un turno se autoriza con el agente publicado de la fila anterior. Un fallo al leer no se guarda ni se sustituye por una copia anterior | Aceptado (D70 (11)): a quien una versión nueva quita el acceso puede seguir viendo la tarjeta hasta 15 s, el mismo retraso con el que el chat deja de servírsela |
| Estado de los packs MCP | `mcp_catalog.CatalogSource` | 15 s | Igual que el anterior | Dice qué tools ofrece un agente; el Gateway decide en cada llamada | Aceptado. La administración de packs lee siempre el estado directo |
| Límites de presupuesto (por defecto y por persona) | `settings_store.BudgetLimits` | 30 s; hasta 5 min si `Settings` no responde | La tarea donde se cambia un límite lo aplica al instante; las demás, en 30 s | Sí: el tope contra el que se reserva | Aceptado: con una tarea el cambio era inmediato; ahora tarda hasta 30 s en la otra. La reserva es una escritura condicional en `Budgets`: lo más que puede pasar es que, en esos segundos, un turno se reserve contra el límite anterior |
| Catálogo de modelos y precios | `model_catalog.ModelCatalogCache` | 30 s | Sin invalidación ya con una tarea | Sí: si un modelo está habilitado y su precio | Aceptado: ya eran 30 s con una tarea |
| Árbol de la organización | `probe.OrganizationCache` | 60 s | Una por tarea | No (lista de OU para elegir) | Aceptado |
| Declaraciones firmadas de packs | `pack_release.ReleasePacks` | Vida del proceso; un pack rechazado se vuelve a leer a los 60 s | Igual en todas: salen de la release | La verificación de firma se hace en cada tarea | Sin cambio |
| Conectores de la release | `functools.cache` en `app.build_services` | Vida del proceso | Igual en todas: viene en la imagen | No | Sin cambio |
| Retiros de agentes en curso | `provisioner.DeprovisionerClient` | 15 s | Una por tarea | No (estado que se muestra) | Aceptado |
| Credenciales de datos por persona (RLS) | `conversations.RlsClientFactory` | 10 min (la sesión de STS dura 15). Desde el 2026-10-06 la entrada caducada **se suelta** cuando llega la siguiente persona sin credenciales vigentes, y hay un tope de 1.000 clientes por tarea (al pasarlo sale el más antiguo) | Una por tarea y persona; cada una solo alcanza las filas de esa persona | La autorización está en la política de sesión | **Corregido (2026-10-06):** antes cada tarea guardaba un cliente por cada persona que hubiera visto, hasta su siguiente despliegue: unos 255 KB cada uno (medido en local), 250 MB con mil personas distintas. Ahora guarda los de los últimos 10 minutos, como mucho 1.000 (unos 250 MB de 1 GB). Un cliente solo se guarda y se devuelve bajo la persona para la que STS emitió sus credenciales; soltar una entrada no cierra el cliente, así que una petición en curso termina con el suyo. A quien se suelta, su siguiente petición le cuesta una llamada a STS (unos 70 ms, medido) |
| Clientes de AgentCore, uno por límite de turno | `harness.TurnClients` | Vida del proceso; como mucho 8 (sale el que lleva más sin usarse) | Uno por tarea y por límite de turno en uso (120 s salvo que un agente lo cambie) | No | Nuevo (2026-10-06): el tiempo de lectura de cada cliente es el límite del turno más 30 s, sin reintentos del SDK, con 100 conexiones. Antes un solo cliente cortaba a los 60 s de silencio |
| Llaves públicas de Cognito (JWKS) | `mango_core.identity.AccessTokenVerifier` | 1 h | Una por tarea | Verifican la firma del token | Sin cambio: una llave nueva se busca al verla |

## Locks, hilos y estado de un turno

| Qué | Dónde | Con varias tareas |
|---|---|---|
| `threading.Lock` de cada caché y del limitador en memoria | Los módulos de arriba | Solo ordenan los hilos de un proceso. Ninguno protege una regla de negocio |
| Un cambio de administradores a la vez | `people.MemberChangeStore.claim_admins` | Ya es un reclamo en DynamoDB con escritura condicional |
| Un turno a la vez por conversación | `conversations.begin_session` | Ya es una escritura condicional en DynamoDB |
| Hilo de cada turno de chat | `app.with_heartbeat` | Vive en la tarea que recibió la petición, con una conexión a AgentCore mientras dura. No hay tope de turnos abiertos por tarea: 20 por tarea no tuvieron efecto medible (2026-10-06); más de 100 abren conexiones de más, sin fallar. Si esa tarea se apaga antes de terminar, el turno se corta (D70, punto 6) y su reserva de presupuesto no se libera: queda contada hasta el cambio de mes. Pendiente aparte |
| Grupos de hilos para consultar Cognito o el sondeo | `people`, `directory`, `admin` | Se crean y se cierran en cada petición |
| Sesión web | Cookie cifrada y tabla `WebSessions` | Sin estado en la tarea: cualquier tarea renueva cualquier sesión |
| Sesión del runtime del agente | Tabla `Conversations` | Sin estado en la tarea: cualquier tarea continúa una conversación |
| Reserva de presupuesto de un turno en curso (D73) | Fila `TURN#…` de la tabla `Budgets`, escrita con la reserva | Sin estado en la tarea. Si la tarea muere con el turno abierto, la fila queda y la función conciliadora cierra la reserva; antes se quedaba colgada hasta fin de mes. D73 no añade cachés ni contadores en memoria |

El balanceador no fija una persona a una tarea (`stickiness.enabled: false`). Desde el 2026-10-06 manda cada petición a la tarea con menos peticiones abiertas (`least_outstanding_requests`, D70 punto 9); un turno de chat abierto cuenta como una petición abierta de su tarea.
