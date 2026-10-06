# D70 · `mango-api` corre con dos tareas y sus límites de tasa se cuentan una sola vez

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día; precisada ese día tras verla en una instalación, punto 8, y tras una prueba de carga, puntos 9 a 11; lo que se vio de esos puntos ya instalados, puntos 12 a 16)
- **Precisa / reemplaza a:** precisa [D33](D033-autorizacion-de-agentes-y-tools.md), [D60](D060-gestion-de-personas.md) y [D66](D066-cambios-de-personas-fuera-del-directorio.md) (los límites de sus excepciones se cuentan entre todas las tareas) y [D63](D063-sesion-web-con-cookie.md) (los límites de la sesión siguen siendo por tarea, a propósito)
- **Precisada por:** [D72](D072-limites-por-ip-para-una-oficina.md) (precisa el punto 4: la sesión se renueva con una operación firmada que no pasa por el WAF del user pool, así que sus límites ya no protegen un límite por IP y la nota de la salida compartida queda resuelta); [D73](D073-turno-cortado-nunca-cuesta-cero.md) (precisa el punto 10: un turno cortado ya no se liquida en cero; su reserva se retiene y se concilia)

## Decisión

Hasta hoy `mango-api` corría con una tarea. Si caía, o caía su zona, el servicio se cortaba. Y sus límites de tasa vivían en la memoria de esa tarea: con N tareas el límite real era N veces el documentado, y un reinicio lo ponía a cero. Varias excepciones de `AGENTS.md` a «sin revelar si un usuario existe» se apoyan en esos límites.

**(1) Dos tareas, una por zona, número fijo.** El servicio de ECS pide dos tareas en las dos subnets públicas (una por zona de disponibilidad) y ECS las reequilibra entre zonas. No hay autoescalado ni parámetro de stack nuevo:

- Dos tareas en dos zonas es lo que hace falta para no depender de una tarea ni de una zona. No hay ninguna medida de carga que pida más.
- Reducir tareas corta los turnos de chat que estén en curso en la tarea que se apaga.
- Los límites que se quedan por tarea (punto 4) se multiplican por el número de tareas: con un número fijo ese factor se conoce.
- El costo de la instalación no cambia solo.

Un test de infraestructura fija el número; cambiarlo es revisar esta decisión.

**(2) Despliegue sin corte.** Con `minHealthyPercent` 100 y `maxHealthyPercent` 200, un despliegue arranca las tareas nuevas y solo apaga las anteriores cuando las nuevas responden; si no llegan a responder, ECS vuelve a la versión anterior. Durante un despliegue conviven hasta cuatro tareas.

**(3) Límites compartidos en DynamoDB.** Los límites que sostienen una excepción de seguridad, o que acotan abuso o costo, se cuentan en la tabla `Mango-<ns>-RateLimits` (`apps/api/src/mango_api/rate_limits.py`). La lista, con el motivo de cada uno, está en `apps/api/src/mango_api/limits.py`.

- **Misma ventana que antes:** deslizante, no fija. Se guardan los momentos de las llamadas de la ventana, así que no hay ráfaga doble en el borde de un minuto o de una hora. El límite documentado es el máximo en cualquier ventana, sume lo que sume cada tarea.
- **Atómico:** una lectura consistente y una escritura condicionada a la versión leída. Si otra llamada escribió antes, se vuelve a leer.
- **Nunca más flojo que lo documentado:** una llamada cuenta un segundo más que su ventana, por si los relojes de dos tareas difieren. «30 por minuto» es, en la práctica, 30 cada 61 segundos.
- **Si la tabla no responde, se rechaza** (429, como un límite alcanzado) y queda en el log con el nombre del límite, nunca con el usuario. Vale para todos los límites compartidos: todas esas rutas ya necesitan DynamoDB para funcionar.
- **Una fila por límite y por persona** (`LIMIT#<límite>#<sub>`): nadie gasta el límite de otro. Las filas caducan solas (TTL). La tarea solo puede leer y escribir por clave en esa tabla (`GetItem` y `PutItem`); no hay `Scan` ni `Query`.
- `mango-api` no arranca sin la tabla.

**(4) Tres límites se quedan por tarea,** con dos tareas valen el doble (cuatro veces durante un despliegue):

| Límite | Por qué por tarea |
|---|---|
| Inicios de sesión web (10 cada 5 min por persona) y renovaciones (30 cada 5 min por sesión) | Protegen el límite del WAF del user pool, que es por IP y por lo tanto por tarea. La renovación está en el camino de cada recarga, y entrar no debe depender de una tabla más. No sostienen ninguna excepción |
| Actualizar el catálogo de modelos (5 por minuto por administrador) | Solo frena un bucle de la pantalla: son dos listados gratuitos de Bedrock |

Lo de «por IP y por lo tanto por tarea» vale mientras cada tarea salga a internet con su propia IP pública, que es la red de la PoC ([D15](D015-red-de-la-poc.md)). Con una salida compartida (un NAT), todas las tareas gastarían el mismo límite del WAF del user pool (300 operaciones cada 5 minutos por IP): quien cambie la red revisa este punto.

El cupo diario de correos del directorio (200 por día) y las cuotas de envíos de agentes ya se contaban en DynamoDB.

**(5) Cachés.** Cada tarea guarda copias de pocos segundos (agente publicado y packs 15 s; presupuestos, modelos y directorio 30 s; organización 60 s). Con dos tareas, un cambio hecho en una tarda como mucho ese tiempo en verse en la otra; las comprobaciones que deciden (quién es administrador, el mínimo de dos administradores, la reserva de presupuesto) ya leían el dato directo. Solo se corrige una: la copia del directorio de personas lleva un número de generación guardado en `Settings`, que avanza con cada cambio aplicado, para que la lista que la pantalla vuelve a leer tras un cambio no muestre el estado anterior si cae en la otra tarea. El inventario completo está en `docs/specs/api-state-inventory.md`.

**(6) Turno de chat en un despliegue.** Una tarea que se va a apagar deja de recibir peticiones y conserva las que tiene abiertas durante 120 segundos (antes 30): el límite por defecto de un turno. Un turno más largo (un agente puede configurarse hasta 600 s) se corta al cumplirse ese tiempo: la persona ve el error de red del chat y la respuesta parcial. No se sube más porque cada despliegue espera ese tiempo.

**(7) Costo.** La segunda tarea (0,5 vCPU, 1 GB, arm64, IP pública) suma unos USD 18 al mes a precios de lista de `us-east-1`. La tabla se paga por uso: céntimos.

**(8) Lo que se comprobó del punto 6 (2026-10-06, en una instalación de laboratorio).** Un turno de chat abierto durante una actualización terminó bien. Duró 36 segundos y lo atendía una de las tareas anteriores: siguió abierto 18 segundos después de que ECS empezara a parar su tarea, 8 de ellos con su destino ya drenando en el balanceador, y la persona recibió la respuesta completa, con sus llamadas a tools. No se probó un turno más largo que los 120 segundos de espera: ese sigue cortándose, como dice el punto 6.

**(9) Precisión del 2026-10-06 al punto 1: lo que aguantan dos tareas, medido, y el reparto del balanceador.** La aprobó el dueño ese día, al ver una prueba de carga en una instalación de laboratorio. El punto 1 decía «no hay ninguna medida de carga que pida más»: ahora la hay.

- **Lo medido,** con dos tareas de 0,5 vCPU y 1 GB y la mezcla de lecturas de una persona (historial, abrir una conversación, `GET /api/me`):

  | Lecturas por segundo | Qué pasa |
  |---|---|
  | 80 | Con margen: el 95 % responde en 0,1 s y la tarea más cargada va al 50 % de CPU |
  | 160 | En el límite: sin errores, ya lento (el 95 % en 0,5 s), una tarea al 93 % |
  | 200 | Se satura: en 30 s el 95 % pasa de 10 s. Sin errores (un 502 en 13.668 peticiones), sin reinicios, y se recupera en 10 s al bajar la carga |

- **Qué se agota primero.** En las lecturas, la CPU de una tarea, no la memoria (170 MB de 1.024), DynamoDB, Verified Permissions ni los hilos. Las dos tareas, iguales, no rindieron igual: una gastó 1,8 veces la CPU de la otra por petición, todo el día. En el chat, mucho antes, la cuota de Bedrock de la cuenta: `mango-api` sostuvo 40 turnos abiertos sin efecto medible, pero con 10 llamadas por minuto al modelo solo funcionan bien unos 5 turnos a la vez.
- **En personas.** Pesando cada llamada por lo que cuesta (un turno de chat, unas 10 lecturas; abrir el Marketplace, unas 6), 80 lecturas por segundo son **unas 330 personas activas a la vez**, cada una con un turno de chat por minuto y algo de navegación. Los supuestos de uso son los de [D72](D072-limites-por-ip-para-una-oficina.md), punto 10: razonados, no datos de una empresa.
- **Qué cambia: el reparto.** El balanceador repartía por turnos: cada tarea recibía exactamente la mitad, y la capacidad era dos veces la de la peor tarea. Ahora manda cada petición a la tarea con menos peticiones abiertas (`least_outstanding_requests`): la que responde antes recibe más. No cuesta nada y es un atributo del grupo de destino, sin reemplazo. Es compatible con lo que hay: sin afinidad, con los 120 s de espera del punto 6 y sin arranque lento (que no está configurado y no se puede combinar con este reparto). Un turno de chat abierto cuenta como petición abierta de su tarea, así que también reparte los turnos largos.
- **Lo que este reparto tiene en contra.** Una tarea que respondiera errores muy rápido recibiría más peticiones, porque se queda sin pendientes. La comprobación de salud y la alarma `Api-errors` ([D71](D071-alarmas-operativas-y-tablero.md)) son lo que lo cubre. Y una tarea recién arrancada recibe de golpe las peticiones nuevas hasta igualarse con las demás.
- **Qué no cambia, y por qué.** El tamaño (0,5 vCPU y 1 GB) y el número (dos, fijo, sin autoescalado). Las razones del punto 1 siguen: reducir tareas corta turnos de chat y los límites por tarea se multiplican. Para la cifra que se promete no hace falta más; subir a 1 vCPU (unos USD 29 más al mes) queda para cuando una instalación lo necesite.
- **La cifra que se promete: hasta unas 300 personas activas a la vez,** con dos condiciones. Que la cuota de Bedrock de la cuenta deje pasar sus turnos: 300 personas con un turno por minuto son al menos 300 llamadas por minuto al modelo, más si el agente usa tools. Cómo comprobarla y pedir más: `docs/runbooks/install.md`. Y que el uso se parezca a los supuestos. Por encima no hay margen.
- **Lo que sigue sin medir.** Cuánto mejora el reparto nuevo (se estima que deja unas 120 lecturas por segundo con margen; la cifra prometida no cuenta con ello). Cuántos turnos de chat a la vez aguanta `mango-api` más allá de 40. Turnos largos de verdad, con tools. Muchas personas distintas a la vez (la prueba usó cinco). Crear y renovar sesiones bajo carga. Un despliegue o la caída de una tarea bajo carga: con una sola tarea la capacidad es la mitad o menos. Por qué una tarea rinde menos que otra, que puede cambiar en cada despliegue.

**(10) Precisión del 2026-10-06 al punto 6: lo que espera `mango-api` a un turno lo decide el límite del turno.** Aprobada por el dueño ese día, con el punto 9. En la prueba, 22 de 40 turnos a la vez fallaron a los 60 s aunque su límite era 120 s: el cliente con el que `mango-api` llama al agente dejaba de esperar tras 60 s sin recibir nada, y un turno que espera a que Bedrock lo deje pasar está callado.

- **El tiempo de lectura es el límite del turno más 30 s.** El agente corta su turno al cumplirse el límite; el margen deja que esa respuesta llegue antes de que `mango-api` se rinda. Un agente con límite de 600 s espera hasta 630 s.
- **Una invocación no se envía dos veces.** El SDK reintentaba por su cuenta una petición cuya respuesta no llegaba. Con un turno eso es repetirlo: la primera invocación puede seguir en curso en la misma sesión del agente, con una sola reserva de presupuesto para dos cobros del modelo. Ahora no hay reintentos: si la invocación falla, la persona ve el error y reenvía. Lo que se pierde: un fallo de red pasajero al empezar un turno ya no se reintenta solo.
- **Conexiones.** Cada tarea guarda hasta 100 conexiones con AgentCore (antes 10). Un turno ocupa una mientras dura: 330 personas activas con turnos de 12 s son unos 66 turnos abiertos, que tienen que caber en una sola tarea mientras la otra se reemplaza. Por encima no falla nada: el turno abre su propia conexión.
- **Con el apagado de una tarea no cambia nada.** Una tarea que se va conserva sus peticiones 120 s (punto 6). Un turno con el límite por defecto que empiece justo antes termina o lo corta el agente dentro de ese tiempo; uno más largo se corta al apagarse la tarea, como ya decía el punto 6.
- **Sin cambiar.** Un turno cortado no se cobra al presupuesto aunque el modelo respondiera: necesita su propio diseño y va aparte.

**(11) Un cuarto límite por tarea y una copia más: las listas de agentes (2026-10-06, aprobado por el dueño; precisa los puntos 4 y 5).** Una prueba de carga midió que `GET /api/agents` cuesta unas seis lecturas y que una persona con sesión que la repita satura una tarea sin pasar del límite por IP ([D72](D072-limites-por-ip-para-una-oficina.md)).

- **Límite `agents.lists`:** 30 llamadas por minuto por persona entre `GET /api/agents` y `GET /api/agents/org`, contado en la memoria de cada tarea (con dos tareas, 60; durante un despliegue, 120). Responde 429 con `Retry-After`. Va por tarea porque no sostiene ninguna excepción y contarlo en la tabla añadiría dos llamadas a la ruta que se quiere abaratar. La pantalla pide como mucho cuatro veces por minuto por pestaña. El test que fija los límites por tarea pasa de tres a cuatro.
- **Copia de 15 s** de las versiones publicadas y retiradas que muestran esas dos listas (`agents_store.ListedVersions`), una por tarea. No depende de la persona ni decide nada: la decisión `UseAgent` se pide en cada llamada y el chat sigue autorizando con el agente publicado. La tarea que retira un agente borra su copia; una publicación tarda hasta 15 s en aparecer en cada tarea. Está en el inventario.
- **No cambia** qué se audita: cada lectura de esas listas sigue dejando su evento.

**(12) El reparto por peticiones abiertas, medido (2026-10-06, en una instalación de laboratorio).** El punto 9 lo dejaba sin medir. Con la versión que lo trae instalada, se repitió el escalón de 120 lecturas por segundo durante 4 minutos (28.800 peticiones, todas con 200) y se comparó con el mismo escalón de la prueba de carga, cuando el balanceador repartía por turnos. Las tareas no eran las mismas que aquel día.

| | Por turnos (prueba de carga) | Por peticiones abiertas |
|---|---|---|
| Peticiones por minuto, tarea rápida / lenta | 3.775 / 3.775 | 4.310 / 3.187 (57 % / 43 %) |
| CPU, rápida / lenta | 38 % / 72 % | 50 % / 70 % |
| El 95 % responde en, dentro de la tarea, rápida / lenta | 29 / 406 ms | 33 / 80 ms |
| El 99 % en la tarea lenta | 839 ms | 160 a 217 ms |
| Visto por el cliente: mediana / 95 % / 99 % | 51 / 179 / 674 ms | 55 / 124 / 201 ms |

- **La tarea que responde antes recibe más,** y la lenta deja de marcar el tiempo de todos.
- **La diferencia entre tareas sigue:** la lenta gastó 1,9 veces la CPU de la rápida por petición. El reparto la compensa en parte, no la quita: la lenta siguió al 70 % de CPU.
- **El primer minuto fue peor** en la tarea lenta (el 95 % en 130 ms y el 99 % en 445 ms).
- **No cambia la cifra prometida.** El punto 9 estimaba unas 120 lecturas por segundo con margen: a ese ritmo no hubo errores y el 95 % respondió en 0,12 s, con la tarea más cargada al 70 %. Es un solo escalón.

**(13) Parar una tarea con turnos abiertos: lo que se vio y lo que garantiza la configuración (2026-10-06, en una instalación de laboratorio).** Se lanzaron 35 turnos a la vez, con la cuota de Bedrock baja para que duraran, y cerca de un minuto después se paró una de las dos tareas, que tenía 18 abiertos. **Los 35 terminaron bien;** el más largo duró 192 segundos.

| Momento | Desde la orden de parar |
|---|---|
| El destino empieza a drenar en el balanceador | Entre 24 y 29 s |
| Termina el último turno | Entre 2 min 18 s y 2 min 24 s |
| El destino deja de drenar (120 s después de empezar) | Entre 2 min 24 s y 2 min 29 s |
| El contenedor sale, con código 0 | 3 min 21 s |

- **No contradice los puntos 6 y 10.** El último turno terminó justo antes de que acabara el drenaje, con segundos de margen o ninguno: la evidencia toma una muestra cada 5 segundos y no da para más. No se vio ningún turno seguir abierto después del drenaje. Lo que esos puntos dicen que se corta, un turno todavía abierto al cumplirse la espera, sigue sin probarse.
- **Lo que garantiza la configuración** (`infra/lib/constructs/api-service.ts`): 120 segundos desde que el destino empieza a drenar (`API_DRAIN_SECONDS`). Durante ese tiempo la tarea no recibe peticiones nuevas y conserva las abiertas.
- **Lo que fue margen de esa vez.** Los cerca de 25 segundos entre la orden de parar y el inicio del drenaje, y los cerca de 55 entre el fin del drenaje y la salida del contenedor, son tiempos de ECS: la plantilla no los fija (la definición de la tarea no declara un tiempo de parada) y pueden ser otros la próxima vez. Tampoco está garantizado lo que ayudó más: los turnos llevaban cerca de un minuto abiertos cuando llegó la orden.
- **En la práctica:** un turno al que le queden menos de 120 segundos cuando su tarea empieza a drenar termina. Con más, depende de márgenes que nadie promete.

**(14) Bedrock saturado alarga los turnos; ya no los rompe (2026-10-06, en una instalación de laboratorio).** Con la misma cuota de la prueba de carga (10 llamadas por minuto al modelo), 90 turnos en tres tandas terminaron todos con su respuesta completa.

| Turnos a la vez | Terminaron bien | Más de 60 s | Más de 180 s | El más largo |
|---|---|---|---|---|
| 20 | 20 | 2 | 0 | 72 s |
| 35 | 35 | 20 | 9 | 189 s |
| 35 (la tanda del punto 13) | 35 | 17 | 6 | 192 s |

- **El punto 9 decía que con 40 a la vez fallaba más de la mitad.** Eso era antes de los cambios del punto 10: `mango-api` dejaba de esperar a los 60 s. Ahora espera lo que dura el límite del turno, y en el log de `mango-api` no hubo ningún `ReadTimeoutError` ni «Connection pool is full».
- **La cuota sigue siendo el techo del chat.** No fallan, pero esperan: con 35 a la vez, cerca de la mitad esperó más de un minuto y hasta una de cada cuatro, más de tres. «Unos 5 turnos a la vez funcionan bien» con esa cuota sigue valiendo si «bien» es responder en segundos.
- **Un turno puede durar más que su límite de tiempo.** El límite cuenta desde que la invocación del agente empieza, no desde que la persona envía: la espera anterior no cuenta. Un agente recién publicado tardó 47 segundos en dar su primera respuesta.

**(15) El límite y la copia de las listas de agentes, medidos (2026-10-06, en una instalación de laboratorio; punto 11).**

- **Costo por llamada.** A 4 llamadas por segundo a `GET /api/agents` durante 3 minutos, repartidas entre cinco personas: 2,2 puntos de CPU por petición por segundo en la tarea lenta (antes 7) y 1,2 en la rápida. La mediana del tiempo en la tarea bajó a entre 51 y 59 ms (antes, entre 73 y 84).
- **El límite corta exacto.** A 10 por segundo durante un minuto, entre cinco personas: 300 respuestas con 200 (60 por persona: 30 por tarea, con dos tareas) y 300 con 429, con `Retry-After` de 1 a 7 segundos.
- **Auditoría.** Un evento por cada respuesta con 200 y ninguno por un 429: 708 y 300 eventos en las dos pruebas, exactos.
- **Quien más pide roza el límite antes de lo que dice la suma.** A 4 por segundo entre cinco personas, 12 de 720 llamadas recibieron 429: el límite es por persona y por tarea, y ni las personas ni las tareas reciben partes iguales.
- **Sin medir:** que una publicación tarde hasta 15 s en aparecer en la otra tarea. Un agente publicado durante la validación se pudo usar enseguida; no se midió la espera aparte.

**(16) Lo que sigue sin medir, tras los puntos 12 a 15.** De la lista del punto 9 salen el reparto (punto 12) y, en parte, la caída de una tarea (punto 13: con turnos abiertos, no bajo carga de lecturas). Siguen: cuántos turnos a la vez aguanta `mango-api` más allá de 40; turnos largos de verdad, con tools; muchas personas distintas a la vez; crear y renovar sesiones bajo carga; un despliegue bajo carga; un turno todavía abierto al terminar el drenaje de su tarea; y por qué una tarea rinde menos que otra.
