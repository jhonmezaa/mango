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

**Datos**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Table-<tabla>-throttled` (una por tabla) | DynamoDB limitó lecturas o escrituras de esa tabla en 2 de 3 periodos de 5 minutos | Si una sola clave de partición concentra el tráfico; después, las cuotas de la tabla y de la cuenta |
| `DynamoDB-system-errors` | DynamoDB respondió con errores internos (HTTP 500) en 2 de 3 periodos. Mira **todas las tablas de la cuenta**, también las que no son de Mango | AWS Health Dashboard; después, qué tabla y qué operación reportan `SystemErrors` |

**Borde**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Edge-errors` | Más del 5 % de las respuestas de CloudFront fueron 5xx, con al menos 100 peticiones en 5 minutos, en 2 de 3 periodos | Si las alarmas `Api-…` están calladas, el fallo está entre CloudFront y sus orígenes: el origen de VPC y el security group del balanceador; después, el bucket de la web |
| `Edge-rate-limited` | El límite por dirección IP del WAF del borde (1.000 peticiones en 5 minutos) bloqueó 50 o más peticiones en 5 minutos. O una dirección está inundando la aplicación, o **muchas personas salen por la misma dirección** (una oficina, una VPN) y están siendo bloqueadas | En la consola de WAF, las peticiones de muestra de la regla `RateLimitPerIp`: de quién es la dirección |

**Publicación de agentes, packs y desinstalación**

| Alarma | Qué significa | Qué mirar primero |
|---|---|---|
| `Reconciler-findings` | La reconciliación diaria encontró recursos de agentes sin definición, cambiados fuera de Mango, o un pack fuera de su red | Las líneas `reconciler.finding` del log group `/aws/lambda/Mango-<ns>-Reconciler` |
| `Reconciler-failed` | La reconciliación diaria no pudo correr: no se comparó nada | Los errores de ese mismo log group y el mensaje en la cola `Mango-<ns>-Reconciler-dlq` |
| `AgentProvisioner-failed`, `AgentDeprovisioner-failed` | Publicar o retirar un agente falló, se agotó o se abortó | La ejecución fallida de la máquina de estados (`AgentProvisionerArn`, `AgentDeprovisionerArn`) |
| `AgentProvisioner-volume` | Más de 30 publicaciones de agentes en una hora | Quién las pidió, en Auditoría |
| `UninstallGuard-failed` | Durante una desinstalación, la función que borra agentes y packs falló todos sus reintentos | Errores del log group `/aws/lambda/Mango-<ns>-UninstallGuard` y el mensaje en la cola `Mango-<ns>-UninstallGuard-dlq` |
| `PackDns-blocked` (stack `PackNetwork`) | El DNS Firewall de la red de packs rechazó consultas de nombres que no son de sus endpoints: código de un pack pidió un nombre que no tiene por qué alcanzar. No se resolvió nada | Qué packs se estaban usando a esa hora y las conexiones rechazadas en los flow logs de la VPC de packs |

**`PackDns-blocked` puede saltar con el uso normal de los packs, mientras se ajusta.** En una instalación de laboratorio (2026-10-06) el DNS Firewall rechazó consultas en las horas en que hubo packs en uso, sin que nadie hiciera nada raro. Todavía no se sabe qué nombres son; se está investigando, y el umbral (una consulta rechazada en 5 minutos) se ajustará con lo que salga. Hasta entonces, un correo de esta alarma a la hora en que alguien usó un pack no indica por sí solo un pack comprometido: nada se resolvió ni salió de la red. Sí merece atención si llega sin packs en uso.

### Qué no tiene alarma

- **Bloqueos de las reglas gestionadas del WAF** (borde y Cognito): en internet hay escaneos todos los días y cada uno bloquea peticiones. Una alarma sería ruido. Se ven en el tablero de WAF.
- **Errores del registro** (`PreSignUp`): los provoca cualquiera que intente registrarse con un correo de otro dominio.
- **Tiempo de respuesta de la API:** una respuesta del chat dura lo que tarda el modelo. Está en el tablero, sin umbral.
- **Fuera de `us-east-1`** no existirían `Edge-errors` ni `Edge-rate-limited`: CloudFront solo publica sus métricas en esa región. Hoy Mango solo se instala ahí.

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

Unos USD 6 al mes a precio de lista: USD 0,10 por cada métrica que lee una alarma (unas 33) y USD 3 por el tablero. Los tres primeros tableros de una cuenta son gratis.
