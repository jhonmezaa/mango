# D71 · La instalación avisa: alarmas operativas sobre lo que fallaba en silencio y un tablero

- **Estado:** propuesta
- **Fecha:** 2026-10-06
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
