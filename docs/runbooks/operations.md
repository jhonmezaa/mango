# Operar una instalación de Mango

Para quien opera la cuenta de AWS donde está instalado Mango. Instalar, actualizar y desinstalar están en [`install.md`](install.md).

## Alarmas

La instalación avisa por correo cuando algo falla. Decisión: [D71](../architecture/decisions/D071-alarmas-operativas-y-tablero.md).

- **A dónde llegan:** al topic `Mango-<ns>-Alerts` (output `AlertsTopicArn` de `Core`). El correo del parámetro `AlertsEmail` queda suscrito y **debe confirmar la suscripción**: sin eso no llega nada. Cómo confirmarla para que nadie la dé de baja por accidente: [El enlace de baja del correo](#el-enlace-de-baja-del-correo). Otros destinos (chat, guardia) se suscriben al topic fuera del stack.
- **Qué dice el correo:** el nombre de la alarma, la métrica, el umbral y una descripción con qué mirar primero. Nunca contenido de conversaciones ni correos de personas.
- **Cuándo avisa:** al pasar a `ALARM`. No avisa al volver a `OK`.
- **Una instalación sin uso está callada:** los datos ausentes no cuentan como incumplimiento, y las tasas de error solo se evalúan por encima de un mínimo de peticiones. Es normal ver alarmas en `INSUFFICIENT_DATA` cuando no hay tráfico. La única excepción es `Api-no-healthy-targets`: ahí la falta de datos también avisa (ver su fila).
- **Dónde verlas juntas:** el tablero `Mango-<ns>-Operations` de CloudWatch muestra el estado de todas y las señales de las que salen.

### Qué significa cada una

Los nombres llevan el prefijo `Mango-<ns>-`.

**La aplicación (`mango-api` y su balanceador)**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Api-no-healthy-targets` | Ninguna tarea de `mango-api` pasa la comprobación de salud durante 3 minutos, **o el balanceador no tiene ninguna tarea registrada**. **Nadie puede usar la aplicación** | Eventos del servicio de ECS `Mango-<ns>-api` y las últimas líneas del log group `/mango/<ns>/api` |
| `Api-unreachable` | El balanceador respondió 5 o más errores 5xx propios en 5 minutos: no tenía a quién enviar la petición, la tarea cerró la conexión o tardó demasiado | Las tareas detenidas del servicio y su motivo; las alarmas `Api-no-healthy-targets` y `Api-tasks-below-desired` |
| `Api-errors` | Más del 5 % de las respuestas de `mango-api` fueron 5xx, con al menos 20 peticiones en 5 minutos, en 2 de 3 periodos | Los errores del log group `/mango/<ns>/api`; después, las alarmas de DynamoDB |
| `Api-unhealthy-targets` | Una tarea lleva 5 minutos fallando la comprobación de salud. La aplicación puede seguir respondiendo desde otra tarea | Las tareas detenidas del servicio y su motivo |
| `Api-tasks-below-desired` | Durante 5 minutos corren menos tareas de las que pide el servicio: se detienen o no logran arrancar | Eventos del servicio: descarga de la imagen, comprobación de salud, memoria |
| `Api-slow` | `mango-api` tardó más de 1 segundo en empezar a responder el 5 % de sus peticiones, en 2 de 3 minutos con al menos 60 peticiones cada uno. **La aplicación va lenta para todos, sin errores.** Una respuesta del chat que tarda no cuenta: se mide la espera hasta el primer byte | En el tablero, la CPU de la tarea más cargada (el máximo, no la media): una tarea cerca del 100 % frena todo lo que le llega. Después, las peticiones por minuto y las alarmas de DynamoDB. Qué hacer: abajo, «Cuando la aplicación va lenta» |

`Api-no-healthy-targets` es la única alarma en la que **no tener datos también avisa** (D71, punto 11). El balanceador solo publica el número de tareas sanas mientras tiene alguna registrada: si el servicio se queda sin tareas deja de publicar, y ese silencio es el peor caso.

- **Sin tareas,** salta unos minutos después del último dato (algo más que los 3 minutos de la alarma). También si alguien deja el servicio en cero tareas a propósito.
- **Al instalar** puede marcarse una vez. La alarma se crea después del servicio, cuando sus tareas ya están sanas; si el primer dato tardara en publicarse, pasaría a `ALARM` y volvería sola a `OK`. A esa hora la suscripción del correo suele estar sin confirmar. Una alarma que sigue en `ALARM` minutos después de terminar la instalación sí es un fallo.
- **En una actualización o un despliegue** no debe saltar: mientras hay tareas hay un dato por minuto.

**Ingreso y tools**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `PreTokenGeneration-failing` | La función que arma los permisos de cada token falló o fue limitada 2 o más veces en 5 minutos. **Quien intentó entrar o renovar su sesión no pudo** | Errores del log group `/aws/lambda/Mango-<ns>-PreTokenGeneration`; después, la tabla `Mango-<ns>-Settings` (de ahí lee el registro de grupos) |
| `GatewayInterceptor-failing` | La función por la que pasa toda llamada a una tool falló o fue limitada 2 o más veces en 5 minutos. **Los agentes no pueden usar tools** | Errores del log group `/aws/lambda/Mango-<ns>-GatewayInterceptor`; después, el secreto y las llaves que usa |
| `PreSignUp-throttled` | Lambda limitó la función del registro. Sus errores no alarman: rechaza un registro lanzando un error, y eso lo puede provocar cualquiera desde internet | La concurrencia de Lambda de la cuenta |

**Modelos**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Bedrock-throttled` | Bedrock rechazó 5 o más llamadas a un modelo en 5 minutos porque se alcanzó una cuota de la cuenta (peticiones o tokens por minuto). **Los turnos de chat esperan y reintentan: tardan minutos en vez de segundos.** Mira **todos los modelos de la cuenta** en esa región, también las llamadas que no son de Mango | La cuota aplicada de los modelos en uso: `python3 deployment/check-bedrock-quotas.py --namespace <ns>`. Qué hacer: abajo, «Cuando Bedrock rechaza por cuota» |

**Datos**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Table-<tabla>-throttled` (una por tabla) | DynamoDB limitó lecturas o escrituras de esa tabla en 2 de 3 periodos de 5 minutos | Si una sola clave de partición concentra el tráfico; después, las cuotas de la tabla y de la cuenta |
| `DynamoDB-system-errors` | DynamoDB respondió con errores internos (HTTP 500) en 2 de 3 periodos. Mira **todas las tablas de la cuenta**, también las que no son de Mango | AWS Health Dashboard; después, qué tabla y qué operación reportan `SystemErrors` |

**Borde**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Edge-errors` | Más del 5 % de las respuestas de CloudFront fueron 5xx, con al menos 100 peticiones en 5 minutos, en 2 de 3 periodos | Si las alarmas `Api-…` están calladas, el fallo está entre CloudFront y sus orígenes: el origen de VPC y el security group del balanceador; después, el bucket de la web |
| `Edge-rate-limited` | Los dos límites por dirección IP del WAF del borde bloquearon, entre los dos, 50 o más peticiones en 5 minutos: `ApiRateLimitPerIp` (6.000 peticiones a `/api/*` en 5 minutos) y `RateLimitPerIp` (20.000 en total, archivos de la web incluidos). **Las personas de esa dirección reciben respuestas 429.** O una dirección está inundando la aplicación, o **muchas personas salen por la misma dirección** (una oficina, una VPN) y están siendo bloqueadas | En el tablero, cuál de las dos reglas bloqueó. Después, en la consola de WAF (web ACL `Mango-<ns>-edge`, de CloudFront), las peticiones de muestra de esa regla: de quién es la dirección. Cómo leerlas y cuánto dura el bloqueo: abajo, «A quién se bloqueó» |
| `Cognito-rate-limited` | Los límites por dirección IP del WAF del user pool bloquearon, entre los tres, 50 o más peticiones en 5 minutos: `SecretOperationsPerIp` (1.500 operaciones de ingreso o de código en 5 minutos), `EmailOperationsPerIp` (50 que envían correo) y `RateLimitPerIp` (5.000 en total). **Las personas de esa dirección no pueden ingresar, registrarse ni recuperar su contraseña;** quien ya está dentro no lo nota. O una dirección está probando contraseñas o pidiendo correos, o **muchas personas ingresan a la vez desde la misma dirección** | En el tablero, cuál de las tres reglas bloqueó. Después, en la consola de WAF (web ACL `Mango-<ns>-cognito`, regional), las peticiones de muestra de esa regla: de quién es la dirección y qué operación repite. Cómo leerlas y cuánto dura el bloqueo: abajo, «A quién se bloqueó» |

**Publicación de agentes, packs y desinstalación**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Reconciler-findings` | La reconciliación diaria encontró recursos de agentes sin definición, cambiados fuera de Mango, o un pack fuera de su red | Las líneas `reconciler.finding` del log group `/aws/lambda/Mango-<ns>-Reconciler` |
| `Reconciler-failed` | La reconciliación diaria no pudo correr: no se comparó nada | Los errores de ese mismo log group y el mensaje en la cola `Mango-<ns>-Reconciler-dlq` |
| `AgentProvisioner-failed`, `AgentDeprovisioner-failed` | Publicar o retirar un agente falló, se agotó o se abortó | La ejecución fallida de la máquina de estados (`AgentProvisionerArn`, `AgentDeprovisionerArn`) |
| `AgentProvisioner-volume` | Más de 30 publicaciones de agentes en una hora | Quién las pidió, en Auditoría |
| `UninstallGuard-failed` | Durante una desinstalación, la función que borra agentes y packs falló todos sus reintentos | Errores del log group `/aws/lambda/Mango-<ns>-UninstallGuard` y el mensaje en la cola `Mango-<ns>-UninstallGuard-dlq` |
| `PackDns-blocked` (stack `PackNetwork`) | El DNS Firewall de la red de packs rechazó al menos una consulta de un nombre que no es de sus endpoints ni de los que pide la máquina de AgentCore por su cuenta: **un nombre que nadie esperaba**. No se resolvió nada | El registro de consultas DNS de la red de packs (log group `Mango-<ns>-PackNetwork-dns-queries`): qué nombre fue. Después, qué packs se estaban usando a esa hora |

**Presupuesto: turnos cortados** (D73)

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `BudgetReconciler-reservation-charged` | Un turno de chat cuyo final no se supo se cobró por su reserva entera: las trazas de AgentCore no dejaron saber lo que costó 15 minutos después de su límite de tiempo. No debería pasar casi nunca | Los eventos `budget.reconciled` de Auditoría con `basis: reservation` y su `reason`. Después, el log group `aws/spans` |
| `BudgetReconciler-failed` | La conciliación falló todos sus reintentos: las reservas de los turnos cortados siguen retenidas y nadie las recupera | Los errores del log group `/aws/lambda/Mango-<ns>-BudgetReconciler` y el mensaje en la cola `Mango-<ns>-BudgetReconciler-dlq` |

**Cuando la aplicación va lenta** (`Api-slow`; D70, punto 9). Dos tareas sirven con margen unas 80 lecturas por segundo (unas 300 personas activas a la vez) y se saturan hacia las 200.

- **Una tarea cerca del 100 % de CPU y mucho tráfico:** la instalación está en su techo. Si es un pico, se recupera sola en segundos al bajar la carga, sin reinicios. Si es el uso normal, la instalación necesita tareas más grandes: es un cambio de versión, avisa al proveedor.
- **Mucho tráfico de una sola persona o dirección:** una persona con sesión que repite una ruta cara (el Marketplace) puede saturar una tarea sin llegar al límite por IP. El log de acceso del balanceador dice qué ruta y desde dónde.
- **CPU baja y aun así lenta:** es una dependencia. Mira las alarmas de DynamoDB y las de las funciones de ingreso.
- **Las dos tareas no rinden igual.** Es normal: se midió una que gastaba 1,8 veces la CPU de la otra con el mismo trabajo. El balanceador manda más a la que responde antes, así que la media de CPU del servicio no dice nada: mira el máximo.

**Cuando Bedrock rechaza por cuota** (`Bedrock-throttled`; D71, punto 16). Cada cuenta de AWS tiene, por modelo, un máximo de llamadas y de tokens por minuto. Cada turno de chat es al menos una llamada, y una más por cada vuelta de tools. Al pasarse, Bedrock rechaza; el agente espera unos 30 segundos y reintenta.

**Qué ve la gente: turnos que se alargan, no que fallan** (D70, punto 14). Medido en una instalación de laboratorio el 2026-10-06, con una cuota de 10 llamadas por minuto: 90 turnos terminaron todos con su respuesta. Con 20 a la vez, el más largo tardó 72 segundos; con 35 a la vez, cerca de la mitad tardó más de un minuto, hasta uno de cada cuatro más de tres, y el más largo 192 segundos. Un turno puede durar más que su límite de tiempo, porque el límite cuenta desde que la invocación del agente empieza y no la espera anterior. En versiones anteriores a D70 (punto 10) esos turnos fallaban a los 60 segundos.


1. Ver qué cuota hay: `python3 deployment/check-bedrock-quotas.py --namespace <ns>` (solo lectura, con credenciales de la cuenta de Mango). Dice, por cada modelo habilitado, la cuota aplicada, el valor por defecto de AWS y para cuántas personas alcanza.
2. **Si la cuota aplicada está por debajo del valor por defecto** (pasa en cuentas nuevas o con poco uso: 10 por minuto donde el valor por defecto es 10.000): Service Quotas **rechaza la solicitud de aumento** (visto por API: solo admite valores por encima del valor por defecto). Hay que abrir un caso en la consola de Support Center (Create case › Service limit increase › Amazon Bedrock) y pedir que se restablezca el valor por defecto de esa cuota. El plan básico de soporte permite ese caso; su API no.
3. **Si ya está en el valor por defecto y no alcanza:** Service Quotas › Amazon Bedrock › la cuota del modelo › solicitar un aumento a nivel de cuenta.
4. Mientras tanto: con 10 llamadas por minuto responden en segundos unos 5 turnos a la vez; los demás esperan. Si las llamadas no son de Mango (la alarma cuenta toda la cuenta), el tablero de Bedrock en CloudWatch dice de qué modelo.

**Qué hacer cuando un límite por IP bloquea a una oficina** (D72). Los números son constantes de la versión: no hay parámetro que los suba. El bloqueo se levanta solo cuando el recuento de esa dirección en los últimos 5 minutos baja del límite; mientras dura, el WAF rechaza **todas** las peticiones de esa dirección que cuenta la regla, y cada recarga de quien espera vuelve a contar. Si la dirección es de la empresa y el uso es legítimo (una oficina de más de unas 1.000 personas detrás de una sola dirección, o más de 500 ingresos en 5 minutos), avisa al proveedor: es el caso que D72 deja para redes de confianza. Si no lo es, las peticiones de muestra dicen qué repite. `mango-api` no cuenta en los límites del user pool: renueva las sesiones con una operación firmada que no pasa por ese WAF.

**Qué ve la gente durante un bloqueo** (visto en un navegador en una instalación de laboratorio el 2026-10-06; D72, puntos 16 a 19). Ninguna pantalla dice que es un límite ni cuánto esperar: quien llama a soporte dirá «da error», no «demasiadas solicitudes».

| Qué bloquea | Qué ve la persona |
|---|---|
| Borde, `ApiRateLimitPerIp` (`/api/*`) | La aplicación sigue abierta y cada pantalla muestra su error genérico con «Reintentar»: en el chat, «Ocurrió un error inesperado. Inténtalo de nuevo.» bajo su mensaje; «No se pudo cargar el historial.»; «No se pudo cargar la conversación»; «No se pudieron cargar los agentes». Si recarga, el logo con ese mismo error y «Reintentar». **No vuelve al formulario de ingreso** y no pierde la sesión: cuando el bloqueo se levanta, «Reintentar» la recupera |
| Borde, `RateLimitPerIp` (todo) | La aplicación no carga: una página en blanco con el título «Demasiadas solicitudes» y «Espera unos minutos y vuelve a cargar la página», sin logo ni estilos |
| User pool, `EmailOperationsPerIp` | Quien ya está dentro no nota nada, y se puede ingresar. «¿Olvidaste tu contraseña?» avanza como si hubiera enviado el código, **pero no lo envía**. «Crear cuenta» se queda en el formulario con «No se pudo completar el inicio de sesión. Inténtalo de nuevo.» |
| User pool, `SecretOperationsPerIp` y `RateLimitPerIp` | Sin ver en un navegador. La regla total no se ha podido provocar |

- **«Reintentar» durante el bloqueo vuelve a fallar y vuelve a contar.** Lo que hay que decirle a la gente es que espere unos minutos sin recargar.
- **Puede ser parcial.** El bloqueo es por dirección. Una red con más de una salida a internet reparte las conexiones de un mismo navegador entre varias direcciones: se vio la API bloqueada mientras la sesión se renovaba con normalidad, en la misma pestaña. «A mí me funciona» y «a mí no», desde la misma oficina o el mismo equipo, son compatibles con un bloqueo por IP.

**A quién se bloqueó.** Lo dicen las peticiones de muestra **de la regla** que bloqueó (las de las últimas 3 horas): la dirección, el país, la acción `BLOCK` y el código que se respondió. En la consola de WAF, en el web ACL, eligiendo la regla; o con la CLI, con el nombre de métrica de la regla (`ApiRateLimitPerIp` o `RateLimitPerIp` en el borde; `SecretOperationsPerIp`, `EmailOperationsPerIp` o `RateLimitPerIp` en el user pool). Las peticiones permitidas salen bajo el nombre de métrica del web ACL, no bajo el de la regla.

```sh
# Borde: --scope CLOUDFRONT, siempre en us-east-1. User pool: --scope REGIONAL y el ARN de Mango-<ns>-cognito.
aws wafv2 get-sampled-requests --scope CLOUDFRONT --region us-east-1 \
  --web-acl-arn <ARN del web ACL Mango-<ns>-edge> --rule-metric-name ApiRateLimitPerIp \
  --time-window StartTime=<inicio, UTC>,EndTime=<fin, UTC> --max-items 100
```

- **No uses `get-rate-based-statement-managed-keys` en el web ACL del borde.** Debería listar las direcciones que la regla tiene bloqueadas, pero en una instalación de laboratorio devolvió una lista vacía durante todo un bloqueo, con las dos reglas (2026-10-06; causa sin confirmar). En el web ACL del user pool sí funciona: listó la dirección bloqueada medio minuto después del primer rechazo. Una lista vacía en el borde no quiere decir que no haya nadie bloqueado.
- **La dirección de una oficina puede no ser una sola:** una red que sale por varias direcciones reparte sus peticiones entre ellas, y cada una cuenta aparte.

**Cuánto dura un bloqueo de verdad.** No hay un tiempo fijo, y los números son aproximados (D72, punto 11):

- **Empieza tarde.** El WAF empieza a bloquear entre medio minuto y un minuto después de que una dirección cruza el límite (entre 33 y 52 segundos en seis pruebas, en dos días) y hasta entonces deja pasar todo: entre un 22 % y un 33 % más que el límite con las ráfagas probadas, y más a un ritmo mayor. Con un ritmo apenas por encima del límite puede no bloquear nunca.
- **Se levanta entre 90 y 180 segundos después de que baja el tráfico** de esa dirección (90, 100, 147, 150 y 180 segundos en las pruebas), no al minuto. Si el tráfico no baja, no se levanta.
- **La respuesta del borde pide esperar 180 segundos** (`Retry-After`), y la página dice «Espera unos minutos». Quien reintenta antes vuelve a recibir el 429 y su intento vuelve a contar. El 403 del user pool no trae espera.
- **La alarma** pasa a `ALARM` cerca de un minuto después del primer bloqueo y vuelve sola a `OK` unos 5 minutos después del último.

**Cuando salta `PackDns-blocked`: qué nombre fue.** La red de packs registra cada consulta DNS de sus Runtimes, con lo que el firewall hizo con ella, durante 30 días (D71, punto 14). En CloudWatch › Logs Insights, sobre el log group `Mango-<ns>-PackNetwork-dns-queries` y el rato de la alarma:

```
fields @timestamp, query_name, query_type, srcaddr, firewall_domain_list_id
| filter firewall_rule_action = "BLOCK" and query_name != "time.aws.com."
| stats count(*) as consultas, min(@timestamp) as primera, max(@timestamp) as ultima by query_name, srcaddr
| sort consultas desc
```

- **Lo que sale es lo que disparó la alarma.** `srcaddr` es la interfaz del Runtime que preguntó; su security group dice de qué pack es.
- **`time.aws.com` no cuenta.** Es el servicio público de hora de AWS. Lo pide la máquina de AgentCore al arrancar cada sesión de un Runtime, antes de que corra el código del pack. Se rechaza igual que cualquier otro nombre (la red no tiene salida a internet), pero en una lista aparte, `Mango-<ns>-PackDnsPlatform`, que la alarma no lee. En el registro aparece con `firewall_rule_action` `BLOCK` en cada uso de un pack: es lo normal.
- **Un nombre de AWS que se repite en cada sesión y nadie puso en un pack** quiere decir que AWS cambió lo que pide su máquina. La alarma saltará con el uso normal hasta revisarlo, y eso es correcto: es un nombre nuevo, y darle sitio en la lista de la plataforma es un cambio de versión, no un ajuste en la consola.
- **Muchos nombres distintos bajo un mismo dominio, o nombres largos sin sentido,** son la forma de un intento de sacar datos por DNS (TM-E2). Nada salió, pero ese pack hay que deshabilitarlo y revisarlo.
- **Los números no coinciden con la alarma.** La métrica del firewall puede contar cerca del doble de consultas que filas tiene el registro, en todas las listas por igual. No falta nada distinto: son repeticiones de los mismos nombres.
- **El registro es un dato sensible:** en un intento de fuga, los nombres pedidos son los datos. Lo lee quien pueda leer logs en la cuenta de Mango.

### Turnos cortados y presupuesto

Decisión: [D73](../architecture/decisions/D073-turno-cortado-nunca-cuesta-cero.md). Cuando `mango-api` no llega a saber cómo terminó un turno (el agente falló, se cortó la lectura o murió la tarea), cobra lo que ya había contado y **retiene el resto de la reserva**. La función `Mango-<ns>-BudgetReconciler` corre cada 5 minutos, lee en las trazas de AgentCore lo que el agente gastó, lo cobra y libera el resto.

- **Un turno cortado por su límite de tiempo** (`stop_reason: timeout_exceeded`): el agente deja de responder, pero la llamada al modelo que estaba en curso sigue hasta acabar y se paga entera. La función espera a que esa llamada termine y cobra lo que gastó (D73 (19)). Puede costar más que la reserva del turno: se cobra entero.

- **Qué ve la persona mientras tanto:** su gasto incluye lo retenido, así que durante unos minutos (entre 3,5 y 8,5 desde que empezó el turno, con el límite de tiempo por defecto; un turno cortado por su límite de tiempo, hasta que su llamada al modelo termine, y como mucho 17) figura como gastado más de lo real. Con varios turnos cortados a la vez puede recibir «presupuesto agotado» hasta la siguiente pasada. El presupuesto del agente, que comparten todos sus usuarios, se ocupa igual.
- **Dónde se ve:** en Auditoría, `agent.completed` con `settlement: pending` y, minutos después, `budget.reconciled` con lo cobrado, lo liberado y de dónde salió el dato (`basis`; `usage_source` dice si los tokens son la suma de las invocaciones o la de las llamadas al modelo, y `model_calls` cuántas llamadas se vieron terminadas).
- **Qué dice cada pasada:** una línea `budget_reconciler.summary` en el log de la función, con cuántos turnos cerró, cuántos esperan y cuántas consultas de trazas fallaron.

**Cuando salta `BudgetReconciler-reservation-charged`.** A esa persona se le cobró la reserva entera (el peor caso del turno, unas decenas de veces lo normal) porque no apareció el dato real. El `reason` del evento dice cuál fue el caso:

| `reason` | Qué pasó | Qué hacer |
|---|---|---|
| `no_trace` | No hay ninguna traza de la sesión de ese turno | Si es un caso aislado, nada: la telemetría no garantiza cada traza. Si se repite, comprobar que Transaction Search sigue activo y que el log group `aws/spans` recibe trazas de los harness |
| `trace_unreadable` | Hay traza, terminó bien y no trae los tokens donde se esperan (también una llamada al modelo que siguió tras el corte del turno y no informó tokens) | Una versión del harness cambió los nombres de los atributos. Avisar al proveedor: se corrige en una versión (`functions/budget-reconciler`, `traces.py`) |
| `model_call_unfinished` | El agente abrió una llamada al modelo y su traza no llegó: no se sabe lo que costó. Si lo ya escrito suma más que la reserva, se cobró eso | Si es un caso aislado, nada. Es lo esperado si alguien paró la sesión del runtime de ese turno (`StopRuntimeSession`): parar la sesión no detiene la llamada y sí pierde su traza. Si se repite sin eso, avisar al proveedor: puede haber cambiado el nombre de las trazas de llamada |
| `trace_query_failed` | La consulta al log group falló en cada pasada hasta el plazo | El error en el log de la función. Lo habitual: el log group no existe, o la instalación tiene Transaction Search gestionado por fuera y las trazas no llegan a esta cuenta |

- **No hay forma de corregir un cobro desde la aplicación.** Si hace falta devolverle margen a la persona, sube su límite del mes en Ajustes › Presupuestos por lo cobrado de más (`reserved_usd` menos lo que el turno costó de verdad, si se llega a saber). El presupuesto del agente no se puede editar todavía.
- **Transaction Search gestionado por fuera** (`observability.transactionSearch: external`): la conciliación solo funciona si las trazas de los harness llegan al log group `aws/spans` de la cuenta de Mango. Si no llegan, todo turno cortado acaba cobrado por su reserva y esta alarma lo dirá.
- **El permiso de lectura** de la función alcanza todo `aws/spans`, que es de toda la cuenta. En una cuenta dedicada a Mango no hay nada más ahí.

**Cuando salta `BudgetReconciler-failed`.** La función corre cada 5 minutos: una pasada que falla la repite la siguiente, y nada se cobra ni se libera dos veces. La alarma queda en `ALARM` mientras haya mensajes en la cola.

1. Mirar el error en el log group de la función. Un `AccessDenied` sobre la tabla `Mango-<ns>-Budgets` justo después de instalar la versión que trae D73 quiere decir que la condición por clave del rol no deja pasar la transacción: avisar al proveedor.
2. Cuando las pasadas vuelvan a terminar bien (línea `budget_reconciler.summary`), vaciar la cola para que la alarma vuelva a `OK`: el mensaje es solo el evento programado, sin datos.

   ```sh
   aws sqs purge-queue --queue-url "$(aws sqs get-queue-url --queue-name Mango-<ns>-BudgetReconciler-dlq --query QueueUrl --output text)"
   ```

3. Las reservas retenidas mientras tanto se cierran solas en la primera pasada buena. Las que hayan pasado de su plazo se cobran por la reserva.

### Qué no tiene alarma

- **Bloqueos de las reglas gestionadas del WAF** (borde y Cognito): en internet hay escaneos todos los días y cada uno bloquea peticiones. Una alarma sería ruido. Se ven en el tablero de WAF.
- **Errores del registro** (`PreSignUp`): los provoca cualquiera que intente registrarse con un correo de otro dominio.
- **Consultas de trazas que fallan o turnos que esperan su traza** (función conciliadora): están en las métricas `TraceQueryErrors` y `Waiting` de `Mango/BudgetReconciler`, sin umbral. Lo que avisa es el cobro por la reserva, que es su consecuencia.
- **Cuánto tarda una respuesta del chat:** dura lo que tarda el modelo. `Api-slow` mide solo la espera hasta que `mango-api` empieza a responder.
- **La CPU de `mango-api`:** está en el tablero (la de la tarea más cargada y la media), sin umbral. Lo que avisa es la lentitud.
- **Fuera de `us-east-1`** no existirían `Edge-errors` ni `Edge-rate-limited`: CloudFront solo publica sus métricas en esa región. Hoy Mango solo se instala ahí. `Cognito-rate-limited` sí existiría: su web ACL es regional.

### Comprobar que el correo llega

Después de instalar, y después de cambiar el correo de alertas:

1. La suscripción está confirmada (no dice `PendingConfirmation`):

   ```sh
   aws sns list-subscriptions-by-topic --topic-arn <AlertsTopicArn> \
     --query 'Subscriptions[].[Protocol,SubscriptionArn]' --output text
   ```

2. Forzar una alarma a `ALARM`. No toca nada de la aplicación:

   ```sh
   aws cloudwatch set-alarm-state --alarm-name Mango-<ns>-Api-unhealthy-targets \
     --state-value ALARM --state-reason "Prueba del correo de alertas"
   ```

3. El correo debe llegar en uno o dos minutos, con el asunto `ALARM: "Mango-<ns>-Api-unhealthy-targets"`.
4. La alarma vuelve sola a su estado real en su siguiente evaluación. Cuánto tarda depende del periodo de la alarma: en una instalación de laboratorio fueron 48 s en esta, que evalúa cada minuto, y 79 s en `PackDns-blocked`, que evalúa cada 5. Para no esperar:

   ```sh
   aws cloudwatch set-alarm-state --alarm-name Mango-<ns>-Api-unhealthy-targets \
     --state-value OK --state-reason "Fin de la prueba"
   ```

Para probar también la alarma de la red de packs (está en otro stack y nombra el topic por su nombre), repetir el paso 2 con `Mango-<ns>-PackDns-blocked`.

### El enlace de baja del correo

Cada correo de alerta trae al pie un enlace para darse de baja del topic. **Quien lo pulse deja a la instalación sin avisos:** basta con que sea alguien a quien se reenvió una alerta. No hace falta ninguna credencial, la suscripción desaparece y nadie se entera: las alarmas siguen cambiando de estado, pero el correo ya no sale.

**Comprobar que la suscripción sigue ahí.** Cada cierto tiempo, y siempre que se haya reenviado una alerta:

```sh
aws sns list-subscriptions-by-topic --topic-arn <AlertsTopicArn> \
  --query 'Subscriptions[].[Protocol,Endpoint,SubscriptionArn]' --output text
```

Debe aparecer el correo de alertas con un ARN completo. Si no aparece, alguien se dio de baja; si dice `PendingConfirmation`, nunca se confirmó. En los dos casos no llega nada.

**Confirmar de forma que la baja exija credenciales de AWS.** Al instalar, o al cambiar el correo de alertas, llega un correo de confirmación. En lugar de pulsar su enlace:

1. Copiar la dirección del enlace «Confirm subscription» y sacar de ella el token: el texto largo entre `Token=` y `&Endpoint=`. Es de vida corta: conviene hacerlo al recibir el correo.
2. Confirmar con credenciales de la cuenta:

   ```sh
   aws sns confirm-subscription --topic-arn <AlertsTopicArn> \
     --token <token> --authenticate-on-unsubscribe true
   ```

3. Comprobar que quedó así (`true`):

   ```sh
   aws sns get-subscription-attributes --subscription-arn <SubscriptionArn> \
     --query 'Attributes.ConfirmationWasAuthenticated' --output text
   ```

Con eso solo pueden dar de baja la suscripción el dueño del topic y el de la suscripción, con una petición firmada de AWS; el enlace del pie del correo deja de servir. Fuente: la referencia de [`confirm-subscription`](https://docs.aws.amazon.com/cli/latest/reference/sns/confirm-subscription.html) y la guía de AWS para [evitar bajas no deseadas](https://repost.aws/knowledge-center/prevent-unsubscribe-all-sns-topic).

Una suscripción que ya se confirmó pulsando el enlace sigue admitiendo la baja sin credenciales (`ConfirmationWasAuthenticated` dice `false`). AWS documenta este camino para confirmar por primera vez; cómo pasar a él una suscripción ya confirmada no está comprobado en una instalación de Mango.

### Ver el estado de todas

```sh
aws cloudwatch describe-alarms --alarm-name-prefix Mango-<ns>- \
  --query 'MetricAlarms[].[StateValue,AlarmName]' --output text | sort
```

Ninguna debería estar en `ALARM` sin un motivo que se pueda explicar.

### Cuánto cuesta

**Unos USD 9 al mes** a precio de lista de `us-east-1`, con todas las alarmas de hoy (D71, D72 y D73):

| Qué | Cuánto | USD al mes |
|---|---|---|
| Métricas que leen las alarmas, a USD 0,10 cada una | 51 en la plantilla de ejemplo (2026-10-06): 50 en las 30 alarmas de `Core` y una en la de `PackNetwork` | 5,10 |
| Tablero `Mango-<ns>-Operations` | Uno. Los tres primeros tableros de una cuenta son gratis | 3,00 |
| Métricas propias de la función conciliadora (D73), a USD 0,30 cada una | Cuatro | 1,20 |
| **Total** | | **9,30** |

- **Fuera de la suma:** `DynamoDB-system-errors` no lee una métrica fija, sino una consulta sobre todas las tablas de la cuenta. CloudWatch la cobra por las métricas que la consulta analiza, que dependen de cuántas tablas y operaciones tenga la cuenta. Ninguna cifra de esta tabla está contrastada con una factura.
- **El número de métricas crece con las tablas:** cada tabla nueva suma una alarma con dos métricas.
- La regla del WAF del borde que añadió D72 (USD 1 al mes) va en el costo del WAF, no aquí: §6 de la [arquitectura](../architecture/reference-architecture.md).
