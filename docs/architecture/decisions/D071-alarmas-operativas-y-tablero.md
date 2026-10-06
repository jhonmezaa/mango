# D71 · La instalación avisa: alarmas operativas sobre lo que fallaba en silencio y un tablero

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día; precisada ese día tras validarla en una instalación: puntos 11 y 12)
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Origen: la revisión del proyecto del 2026-10-05 (infraestructura, H6). El usuario aprobó ese día el hito 1, «instalable por una empresa real», y eligió empezar por «dos tareas y alarmas». Hasta aquí las únicas alarmas eran las cinco del camino de publicación de agentes. Qué significa cada alarma y cómo probar el correo: `docs/runbooks/operations.md`.

**(1) Qué alarma.** Lo que deja a las personas sin servicio y hoy solo se sabría por ellas: `mango-api` sin tareas sanas, con 5xx o con menos tareas de las pedidas; el balanceador respondiendo 5xx; las funciones de las que depende entrar (`PreTokenGeneration`) y usar tools (`GatewayInterceptor`); lecturas o escrituras limitadas en cada tabla y errores internos de DynamoDB; 5xx de CloudFront; la cola de mensajes fallidos de `UninstallGuard`; y las consultas que rechaza el DNS Firewall de la red de packs (TM-E2). Todas notifican al topic `Mango-<ns>-Alerts`, solo al pasar a `ALARM`.

**(2) Que no hagan ruido.** Datos ausentes nunca cuentan como incumplimiento. Una tasa de error solo se evalúa por encima de un mínimo de peticiones (20 en la API, 100 en CloudFront, en 5 minutos) y en 2 de 3 periodos. Un solo error de una función no alarma; dos en 5 minutos, sí. Los umbrales son constantes del código (`OPERATIONAL_THRESHOLDS`), no parámetros del stack: se ajustan en una versión, con lo que se vea en instalaciones reales.

**(3) Cada alarma dice qué mirar primero.** Su descripción, en inglés, lo dice en una frase («Look first at …»). Un test lo exige.

**(4) Nada se enumera a mano.** Las alarmas de DynamoDB recorren las tablas que tenga el stack: una tabla nueva queda vigilada sin tocar este código. La de tareas compara dos métricas de Container Insights (deseadas y en ejecución): vale para una tarea, para dos o con autoescalado. Los errores internos de DynamoDB se leen con una sola consulta de Metrics Insights sobre todas las tablas y operaciones **de la cuenta**: en una cuenta compartida avisaría también por tablas ajenas a Mango.

**(5) Lo que no alarma, y por qué.** (a) Los bloqueos de las reglas gestionadas del WAF: internet escanea a diario y cada escaneo bloquea peticiones. Sí alarma el **límite por IP del borde**, que es el que puede dejar fuera a una oficina entera que sale por una sola dirección. (b) Los errores de `PreSignUp`: rechaza un registro lanzando un error, así que cualquiera desde internet los provoca; solo alarman sus throttles. (c) El tiempo de respuesta: una respuesta del chat dura lo que tarda el modelo. (d) La alarma de `directory.signup` (TM-P11): depende de un evento aplazado.

**(6) La alarma del DNS Firewall vive en `PackNetwork` y nombra el topic por su nombre.** `PackNetwork` se instala antes que `Core`, que es quien tiene el topic: no puede importarlo. El nombre del topic es fijo (`Mango-<ns>-Alerts`), y su política ya admite cualquier alarma de la cuenta. Entre la instalación de `PackNetwork` y la de `Core` la alarma existe sin destino; no hay packs en ese intervalo.

**(7) CloudFront, solo en `us-east-1`.** CloudFront y su web ACL publican métricas solo en esa región y una alarma solo lee métricas de la suya. La plantilla está fijada a `us-east-1`, así que las dos alarmas del borde caben sin trucos. Una plantilla para otra región saldría sin ellas (el código lo decide por la región del stack); las del balanceador seguirían viendo lo que llega a la API.

**(8) Un tablero.** `Mango-<ns>-Operations`: el estado de todas las alarmas del stack y las señales de las que salen. Es un recurso y unos USD 3 al mes (gratis si la cuenta tiene menos de tres). No se añade nada que mida por su cuenta: sin filtros de métricas, sin métricas propias nuevas.

**(9) Costo y tamaño.** 20 alarmas y un tablero en `Core` (de 249 a 270 recursos con la síntesis de ejemplo, ya con la tabla de [D70](D070-dos-tareas-y-limites-compartidos.md); el máximo es 500) y una alarma en `PackNetwork`. Unos USD 6 al mes a precio de lista. Sin supresiones nuevas de cdk-nag, cfn-guard ni Checkov, y sin cambios de permisos.

**(10) Pendiente de comprobar en una instalación.** Que una alarma de prueba llega al correo, y cuál es el nivel normal de consultas rechazadas por el DNS Firewall: si el propio AgentCore pide nombres fuera de la lista, el umbral de `PackDns-blocked` (una consulta en 5 minutos) habrá que subirlo.

**(11) Precisión del 2026-10-06 al punto 2: en `Api-no-healthy-targets`, y solo en ella, la falta de datos cuenta como incumplimiento.** La aprobó el dueño ese día, al ver la validación en una instalación de laboratorio. El motivo: el balanceador solo publica `HealthyHostCount` mientras tiene algún destino registrado. Con tareas que fallan la comprobación de salud publica 0 y la alarma ya saltaba; con el servicio sin ninguna tarea no publica nada, y la alarma callaba justo en el peor caso. En las demás alarmas los datos ausentes siguen sin contar: sus métricas solo existen cuando hay tráfico o cuando ocurre el fallo. Un test nombra esta única excepción y falla si aparece otra. Qué cambia en cada momento:

- **Instalación nueva.** La alarma se crea después del servicio de ECS (depende de él), y CloudFormation da el servicio por creado cuando sus tareas ya están registradas y sanas: no existe mientras todavía no hay una primera tarea. Si aun así el primer dato tardara en publicarse, saltaría una vez y volvería sola a `OK`; a esa hora lo normal es que la suscripción del correo siga sin confirmar.
- **Actualización o despliegue.** No falta el dato mientras haya tareas: en la validación hubo un dato por minuto durante dos paradas de tarea y un despliegue. Una actualización de una instalación existente cambia la alarma sin recrearla.
- **Servicio sin tareas.** La alarma salta unos minutos después del último dato, cuando ese dato sale de la ventana que CloudWatch evalúa (algo más que los 3 minutos de la alarma). Vale también si alguien deja el servicio en cero tareas a propósito: nadie puede usar la aplicación.
- **Desinstalación.** La alarma se borra antes que el servicio, así que no avisa al apagarse la última tarea.

**(12) Lo que se comprobó del punto 10 (2026-10-06, en una instalación de laboratorio).** El correo llega: dos alarmas de prueba, una de `Core` y la de `PackNetwork`, llegaron al buzón de alertas y el dueño lo confirmó. Sigue pendiente el nivel normal de consultas rechazadas por el DNS Firewall: con packs en uso no es cero. Se está investigando qué nombres se rechazan; hasta saberlo, el umbral de `PackDns-blocked` no es de fiar y la alarma puede saltar con el uso normal de los packs.
