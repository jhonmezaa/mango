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
| `Bedrock-throttled` | Bedrock rechazó 5 o más llamadas a un modelo en 5 minutos porque se alcanzó una cuota de la cuenta (peticiones o tokens por minuto). **Los turnos de chat esperan y reintentan, y fallan si la espera dura más que el turno.** Mira **todos los modelos de la cuenta** en esa región, también las llamadas que no son de Mango | La cuota aplicada de los modelos en uso: `python3 deployment/check-bedrock-quotas.py --namespace <ns>`. Qué hacer: abajo, «Cuando Bedrock rechaza por cuota» |

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

**Cuando la aplicación va lenta** (`Api-slow`; D70, punto 9). Dos tareas sirven con margen unas 80 lecturas por segundo (unas 300 personas activas a la vez) y se saturan hacia las 200.

- **Una tarea cerca del 100 % de CPU y mucho tráfico:** la instalación está en su techo. Si es un pico, se recupera sola en segundos al bajar la carga, sin reinicios. Si es el uso normal, la instalación necesita tareas más grandes: es un cambio de versión, avisa al proveedor.
- **Mucho tráfico de una sola persona o dirección:** una persona con sesión que repite una ruta cara (el Marketplace) puede saturar una tarea sin llegar al límite por IP. El log de acceso del balanceador dice qué ruta y desde dónde.
- **CPU baja y aun así lenta:** es una dependencia. Mira las alarmas de DynamoDB y las de las funciones de ingreso.
- **Las dos tareas no rinden igual.** Es normal: se midió una que gastaba 1,8 veces la CPU de la otra con el mismo trabajo. El balanceador manda más a la que responde antes, así que la media de CPU del servicio no dice nada: mira el máximo.

**Cuando Bedrock rechaza por cuota** (`Bedrock-throttled`; D71, punto 16). Cada cuenta de AWS tiene, por modelo, un máximo de llamadas y de tokens por minuto. Cada turno de chat es al menos una llamada, y una más por cada vuelta de tools. Al pasarse, Bedrock rechaza; el agente espera unos 30 segundos y reintenta, y las personas ven turnos que tardan 40 o 70 segundos, o «the agent failed».

1. Ver qué cuota hay: `python3 deployment/check-bedrock-quotas.py --namespace <ns>` (solo lectura, con credenciales de la cuenta de Mango). Dice, por cada modelo habilitado, la cuota aplicada, el valor por defecto de AWS y para cuántas personas alcanza.
2. **Si la cuota aplicada está por debajo del valor por defecto** (pasa en cuentas nuevas o con poco uso: 10 por minuto donde el valor por defecto es 10.000): Service Quotas **rechaza la solicitud de aumento** (visto por API: solo admite valores por encima del valor por defecto). Hay que abrir un caso en la consola de Support Center (Create case › Service limit increase › Amazon Bedrock) y pedir que se restablezca el valor por defecto de esa cuota. El plan básico de soporte permite ese caso; su API no.
3. **Si ya está en el valor por defecto y no alcanza:** Service Quotas › Amazon Bedrock › la cuota del modelo › solicitar un aumento a nivel de cuenta.
4. Mientras tanto: con 10 llamadas por minuto funcionan bien unos 5 turnos a la vez. Si las llamadas no son de Mango (la alarma cuenta toda la cuenta), el tablero de Bedrock en CloudWatch dice de qué modelo.

**Qué hacer cuando un límite por IP bloquea a una oficina** (D72). Los números son constantes de la versión: no hay parámetro que los suba. El bloqueo se levanta solo cuando el recuento de esa dirección en los últimos 5 minutos baja del límite; mientras dura, el WAF rechaza **todas** las peticiones de esa dirección que cuenta la regla, y cada recarga de quien espera vuelve a contar. Si la dirección es de la empresa y el uso es legítimo (una oficina de más de unas 1.000 personas detrás de una sola dirección, o más de 500 ingresos en 5 minutos), avisa al proveedor: es el caso que D72 deja para redes de confianza. Si no lo es, las peticiones de muestra dicen qué repite. `mango-api` no cuenta en los límites del user pool: renueva las sesiones con una operación firmada que no pasa por ese WAF.

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

- **Empieza tarde.** El WAF empieza a bloquear entre medio minuto y un minuto después de que una dirección cruza el límite (34, 41 y 52 segundos en las tres reglas probadas) y hasta entonces deja pasar todo: entre un 23 % y un 33 % más que el límite con las ráfagas probadas, y más a un ritmo mayor. Con un ritmo apenas por encima del límite puede no bloquear nunca.
- **Se levanta entre 90 y 180 segundos después de que baja el tráfico** de esa dirección (90, 150 y 180 segundos en las pruebas), no al minuto. Si el tráfico no baja, no se levanta.
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

### Qué no tiene alarma

- **Bloqueos de las reglas gestionadas del WAF** (borde y Cognito): en internet hay escaneos todos los días y cada uno bloquea peticiones. Una alarma sería ruido. Se ven en el tablero de WAF.
- **Errores del registro** (`PreSignUp`): los provoca cualquiera que intente registrarse con un correo de otro dominio.
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

Unos USD 6 al mes a precio de lista: USD 0,10 por cada métrica que lee una alarma (unas 33) y USD 3 por el tablero. Los tres primeros tableros de una cuenta son gratis. Con D72, cuatro métricas más (USD 0,40) y una regla más en el WAF del borde (USD 1). Con las dos alarmas de saturación (D71, punto 16), tres métricas más (USD 0,30).
