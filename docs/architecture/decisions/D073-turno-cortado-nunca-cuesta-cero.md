# D73 · Un turno cortado nunca cuesta cero: la reserva se retiene y se concilia con las trazas de AgentCore

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día; precisada ese día tras validarla en una instalación, puntos 17 a 20; el dueño aceptó ese día la corrección del punto 19 y decidió no parar la sesión, punto 20)
- **Precisa / reemplaza a:** precisa [D41](D041-alertas-y-reconciliacion.md) (la reconciliación diaria sigue siendo de solo lectura; esta es otra función), [D71](D071-alarmas-operativas-y-tablero.md) (1: dos alarmas nuevas), [D16](D016-observabilidad-de-agentes.md) (las trazas pasan a ser, además, la fuente del gasto de un turno cortado) y [D70](D070-dos-tareas-y-limites-compartidos.md) (10: su último párrafo dejaba «aparte» el cobro de un turno cortado; es esta decisión)
- **Precisada por:** [D74](D074-tope-de-tokens-en-cada-llamada.md) (20: el tope por llamada de su opción (b); 19: la salida que cuenta la reserva; 6: de la fila 6 de la tabla sale un caso, el error con el que el harness cierra un turno justo después del uso de un mensaje cortado en su tope, que es un final conocido: su punto 13, detalle propuesto. El resto de la fila queda como la decidió el dueño)

## Decisión

Origen: hito 1, «instalable por una empresa real». La prueba de carga del 2026-10-06 mostró que un turno que `mango-api` dejaba de leer por un error devolvía su reserva entera y anotaba costo cero, aunque el agente siguiera trabajando y Bedrock cobrara: 19 turnos pagados y no contados de 75. Como la reserva volvía, el presupuesto dejaba de ser un tope y se podía provocar a propósito. El dueño leyó la propuesta de diseño ese día y eligió «retener y conciliar, en este hito». Este texto lo registró un agente y espera su aceptación.

**(1) La regla.** «No sé cuánto costó» nunca se anota como «costó cero».

**(2) Tres pasos.**

- **Un registro del turno pendiente.** Al reservar, `mango-api` escribe en la misma transacción una fila del turno en la tabla `Budgets`: persona, agente, periodo, las filas de presupuesto reservadas, el monto, el id de sesión del runtime, la hora, el límite de tiempo del turno y **el precio del modelo en ese momento**. Nunca contenido.
- **Final conocido:** se cobra el uso real, se libera el resto y se borra la fila, en una sola transacción. El final es conocido cuando el turno no llegó a invocar al agente, o cuando el stream se leyó hasta el final y cada llamada al modelo informó su uso.
- **Final desconocido:** se cobra lo que ya se había sumado (nunca cero por un error) y **el resto de la reserva queda retenido**. La fila queda «por conciliar». Es final desconocido cualquier otra cosa: `mango-api` dejó de leer, el harness informó un error, o una llamada al modelo no llegó a informar su uso. Si la tarea muere o la liquidación falla, la fila se queda como estaba y vale lo mismo.

**(3) Un conciliador cada 5 minutos.** Una función Lambda nueva y programada, `Mango-<ns>-BudgetReconciler`, lee las filas vencidas y, para cada una, suma las trazas `invoke_agent` de la sesión del turno:

| Lo que dicen las trazas | Qué se cobra | Base en el evento |
|---|---|---|
| Invocaciones con tokens | Lo real, con el precio guardado; se libera el resto | `trace` |
| Solo invocaciones fallidas, sin tokens | Nada más que lo ya cobrado; se libera todo | `trace` |
| Menos de lo que `mango-api` ya había contado | Lo ya cobrado: una traza nunca devuelve dinero | `partial` |
| El turno no llegó a invocar al agente | Nada; se libera todo | `not_invoked` |
| Nada legible al llegar el plazo | **La reserva entera** | `reservation`, con el motivo |

- **Cuándo mira:** no antes del límite de tiempo del turno más 90 segundos. Una traza se escribe cuando su invocación termina, un turno puede dejar más de una invocación (se vio una vez en 75), y se midieron invocaciones de 148 segundos con un límite de 120.
- **El plazo:** 15 minutos después del límite de tiempo del turno (inicio + límite + 15 min; 17 minutos desde el inicio con el límite por defecto). Lo eligió el dueño el 2026-10-06: sirve igual cuando la tarea muere y nadie anota la hora del corte.
- **Si la consulta de trazas falla o no se puede leer la traza,** no se cobra a ciegas: se reintenta en cada pasada hasta el plazo. Entonces se cobra la reserva y el evento dice por qué (`no_trace`, `trace_unreadable`, `trace_query_failed`). Una traza terminada bien pero sin atributos de tokens es «ilegible», no «cero».
- **Cobrar la reserva entera es el único caso de cobrar de más.** Exige que fallen a la vez el turno y la telemetría. Está acotado por la reserva, queda auditado y dispara una alarma.

**(4) Nada se cobra ni se libera dos veces.** Cada liquidación, la de `mango-api` y la del conciliador, es una transacción condicionada a la fila del turno. La segunda no encuentra la fila en el estado esperado y no cambia nada. El conciliador marca la fila como liquidada, escribe el evento y solo entonces la borra: si muere en medio, la siguiente pasada vuelve a escribir el evento.

**(5) La traza de un turno es solo suya.** El id de sesión lo calcula el servidor con la persona, su acceso, el agente, la conversación y la generación. Y una sesión solo se deja abierta al turno siguiente **después** de liquidar su turno: un turno con fila pendiente es el último de su sesión, así que las invocaciones de esa sesión posteriores a su reserva son todas suyas. Costo: si la liquidación falla, el turno siguiente de esa conversación abre una sesión nueva y reenvía el historial.

**(6) Todas las formas de terminar un turno.**

| # | Cómo termina | Qué se cobra al terminar | Qué queda retenido | Quién lo cierra |
|---|---|---|---|---|
| 1 | Termina bien | El uso real | Nada | `mango-api` |
| 2 | Presupuesto insuficiente (402) | Nada: no se reserva | Nada | — |
| 3 | No puede empezar (conversación ocupada, fallo al guardar, sin auditoría) | Nada: no se invocó | Nada | `mango-api` |
| 4 | Pide confirmar una tool de escritura (D27) y llegó el uso de ese mensaje | El uso real | Nada | `mango-api` |
| 4b | Lo mismo, pero el stream se cerró antes de que llegara ese uso | Lo conocido | El resto | Conciliador |
| 5 | El guardrail interviene | Lo que informe el harness; si no informa uso, como 4b | Nada, o el resto | `mango-api` o el conciliador |
| 6 | El harness informa un error | Lo conocido | El resto | Conciliador |
| 7 | `mango-api` deja de leer (silencio, conexión cortada) | Lo conocido | El resto | Conciliador |
| 8 | La persona cierra la pestaña | El uso real: el turno sigue en el servidor | Nada | `mango-api` |
| 9 | La tarea muere con el turno abierto | Nada todavía | La reserva entera | Conciliador |
| 10 | La liquidación falla | Nada todavía, en ninguna fila | La reserva entera | Conciliador |
| 11 | El título de una conversación nueva | Su uso real, sin reserva previa | Nada | `mango-api` |

Un test por fila dice qué se cobra y qué queda retenido (`apps/api/tests/test_turn_endings.py`, `test_harness.py` y `functions/budget-reconciler/tests/`). La fila 6 la decidió el dueño el 2026-10-06: el uso de la llamada que estaba en curso no se conoce.

**(7) Por qué una función nueva y no el reconciliador diario.** [D41](D041-alertas-y-reconciliacion.md) dice que la reconciliación diaria es de solo lectura: detecta y avisa, no repara. Esta escribe contadores de presupuesto y corre cada 5 minutos. Tampoco va dentro de `mango-api`: metería un trabajo de fondo en las dos tareas y daría a la tarea de la API lectura de las trazas de toda la cuenta.

**(8) La fuente y sus límites.** Las trazas que el harness gestionado escribe en `aws/spans` (Transaction Search, [D16](D016-observabilidad-de-agentes.md)): una `invoke_agent` por invocación, con los tokens, el estado y el id de sesión. Se comprobó, solo lectura, contra una prueba de carga en una instalación de laboratorio: 76 invocaciones de 75 sesiones, con los mismos tokens que la propuesta, entre 0 y 5 segundos después de terminar.

- **Es telemetría, no facturación.** AWS no garantiza que llegue cada traza. Para eso está el plazo.
- **Los nombres de los atributos los pone el harness** y pueden cambiar con una versión. Se leen dos nombres por dato; si ninguno está, la traza es ilegible y la alarma avisa.
- **`aws/spans` es de toda la cuenta.** El rol puede filtrar ese log group entero: en una cuenta dedicada a Mango no hay nada más; en una compartida, quien instala acepta ese alcance. De cada traza la función lee cuatro contadores, el inicio y el estado, cada uno validado, y no guarda nada más.
- **Transaction Search gestionado por fuera (`external`).** Si las trazas no llegan al `aws/spans` de la cuenta de Mango, o el log group no existe, la conciliación degrada: todo turno cortado se cobra por su reserva al llegar el plazo, y la alarma lo dice. No se comprobó en una instalación así.
- **Los tokens de caché** existen en las trazas y valían cero en todas las de la prueba. Se suman con el precio de caché guardado; no se ha visto un caso real.

**(9) Permisos de la función.** `logs:FilterLogEvents` sobre el log group `aws/spans` y nada más de CloudWatch Logs (no se usa Logs Insights: `GetQueryResults` no admite recurso). En `Budgets`: `Query` sobre las particiones de turnos pendientes (`TURN#…`) y `UpdateItem`/`DeleteItem` por clave, limitadas por `dynamodb:LeadingKeys` a `TURN#…`, `USER#…` y `AGENT#…`. Sin `Scan`. Auditoría por el mismo camino que `mango-api`: `firehose:PutRecord` y `PutItem` en el índice. No lee conversaciones ni el catálogo de modelos, y no invoca nada. El dueño aceptó el 2026-10-06 dos reconocimientos de cdk-nag en ese rol: X-Ray, como toda función, y el ARN de `aws/spans`, que IAM exige escrito con el sufijo `:*`.

**(10) Auditoría.** `agent.completed` gana `settlement` (`final`, `pending`, o `reconciler` si el conciliador lo cerró antes) y `held_usd`. El evento nuevo `budget.reconciled` lleva la persona, el agente, la conversación y el turno, lo cobrado, lo que ya se conocía, lo liberado, la base, el motivo, cuántas invocaciones se sumaron y los tokens. Sin contenido. Lo firma `system:budget-reconciler`.

**(11) Lo que ve la persona.** La lista de presupuestos suma lo retenido al gasto mostrado hasta que se concilia: lo retenido nunca aparece como disponible. Se ve como gastado, no como «por conciliar»: ese estado no está en el diseño (D24) y va al próximo brief. La reserva de un turno cuya tarea murió no se ve hasta que el conciliador lo cierra, igual que la de un turno en curso.

**(12) Lo que cuesta retener.** Mientras un turno está por conciliar, su reserva ocupa el presupuesto de la persona y el del agente, que es de todos sus usuarios: entre 3,5 y 8,5 minutos desde que empezó el turno, con el límite por defecto. Una persona con USD 5 puede tener a la vez 14 turnos cortados y ninguno más; antes podía repetirlo sin límite.

**(13) Alarmas ([D71](D071-alarmas-operativas-y-tablero.md)).** `BudgetReconciler-reservation-charged`: un turno se cobró por la reserva entera. Sale de una métrica que la función emite en su log (sin filtros de métricas). `BudgetReconciler-failed`: una pasada acabó en la cola de mensajes fallidos; es asíncrona, así que lleva DLQ. No se construyó la alarma «tokens que ve Bedrock frente a tokens que cuenta Mango» de la propuesta: la métrica de Bedrock es de toda la cuenta y se quedó corta frente a las trazas.

**(14) Costo y tamaño.** Diez recursos más en `Core`. Unos USD 1,50 al mes a precio de lista: cuatro métricas propias (USD 1,20), dos alarmas (USD 0,20) y céntimos de Lambda y de DynamoDB (288 pasadas al día, 16 consultas cada una). `FilterLogEvents` no tiene cargo por consulta; lo que CloudWatch cobra por volumen leído es Logs Insights, que no se usa. Cada turno escribe una fila más y la actualiza una vez. Sin parámetros de stack nuevos, sin supresiones nuevas de cfn-guard ni Checkov y sin excepciones nuevas a las reglas de seguridad.

**(15) Lo que queda fuera.** Parar la sesión del runtime tras un corte (`StopRuntimeSession`): no se pudo confirmar qué hace con un turno a medias, y parar la sesión podría impedir que el harness escriba la traza de la que depende la conciliación. El título de una conversación nueva sigue sin reserva previa. El costo del guardrail sigue fuera de todo presupuesto. La reconciliación del gasto contra la factura (CUR) sigue sin hacer.

**(16) Pendiente de comprobar en una instalación.** Que la condición `dynamodb:LeadingKeys` deja pasar las transacciones de la función; un turno cortado de verdad: la reserva retenida, el evento a los pocos minutos, el gasto final igual al de la traza, y que repetirlo ya no salta el tope; y las dos alarmas.

**(17) Lo que dejó visto la validación del 2026-10-06** (una instalación de laboratorio con esta decisión desplegada; 100 turnos). Del punto 16:

- **El permiso:** la condición `dynamodb:LeadingKeys` deja pasar las 16 consultas de cada pasada y las transacciones. Ningún `AccessDenied`.
- **Un turno cortado de verdad** (dos, cortados por su límite de tiempo): la reserva quedó retenida, `agent.completed` salió con `settlement: pending`, y el evento `budget.reconciled` llegó 3 min 10 s y 4 min 25 s después del inicio del turno (el límite era de 15 segundos; con el de 120 valen los 3,5 a 8,5 minutos del punto 12). Después no quedó fila pendiente ni nada retenido.
- **Lo retenido cuenta para el tope:** con USD 0,27 retenidos, el turno siguiente de esa persona recibió 402; tras conciliar, 200.
- **De la tabla del punto 6:** la fila 4 (la traza de la llamada trae los mismos tokens que `agent.completed`; el turno no deja traza `invoke_agent`), la fila 5 (guardrail: cero tokens, liquidado por `mango-api`) y la fila 8 (el uso real, nada retenido).
- **No se pudo provocar:** las filas 6, 7, 9 y 10. Ni saturar la cuota de Bedrock (90 turnos, todos terminaron, hasta 192 segundos) ni parar una tarea de `mango-api` (drenó y sus 18 turnos terminaron) cortan ya un turno. Tampoco se vio el cobro por la reserva ni saltó ninguna de las dos alarmas.
- **«El gasto final igual al de la traza» se cumplió, y la traza estaba mal:** es el punto 18.

**(18) El defecto: un turno que el harness corta por su límite de tiempo se conciliaba con costo cero** (2026-10-06). Es la fila 6 de la tabla, con una forma que el punto 3 no previó.

- Al llegar el límite, el harness cierra la invocación: `invoke_agent` y `chat` (su registro de la llamada al modelo) terminan `OK` con los atributos de tokens presentes y en cero. `mango-api` recibe `timeout_exceeded` sin uso y retiene, como debe.
- **La llamada al modelo sigue hasta acabar.** Sus tokens solo aparecen en la traza `chat <id del modelo>`, hija de `chat`, que se escribe cuando la llamada termina: entre 69 y 140 segundos después del corte en los turnos vistos.
- El conciliador leía solo `invoke_agent` y su regla de «ilegible» es para atributos ausentes: leyó cero, cobró cero y liberó toda la reserva.
- **Cifras:** 6 turnos cortados (2 de la validación y 4 de la investigación del punto 20), con 5.112 a 10.512 tokens de salida cada uno: unos USD 0,77 que Bedrock cobró y Mango anotó como cero. Se provoca a voluntad con un agente de límite corto y una pregunta que pida un texto largo.
- **El límite de tiempo no limita el gasto**, y la reserva tampoco es un techo: ver el punto 20.

**(19) La corrección.** El dueño eligió el 2026-10-06 **«cobrar lo real»**: el conciliador suma también las llamadas al modelo del turno y espera a que terminen; si al plazo no hay nada legible, cobra la reserva entera. Descartó «cobrar siempre la reserva entera». El detalle que sigue lo propuso un agente con lo medido y **el dueño lo aceptó el 2026-10-06**.

- **Qué se lee.** De la sesión del turno, además de `invoke_agent`, las trazas `chat` y `chat <id del modelo>`. Con el mismo filtro por id de sesión y la misma ventana; el mismo permiso.
- **Qué se suma.** El turno se suma dos veces: por invocaciones (como hasta ahora) y por llamadas al modelo (cada `chat <modelo>`). **Se cobra la mayor.** En los 97 turnos de la validación que terminaron solos las dos sumas son iguales; en uno cortado por tiempo, la de invocaciones es cero; en el que pide confirmar una tool de escritura (fila 4b) no hay invocación. Nunca menos de lo que `mango-api` ya había cobrado (base `partial`, sin cambios).
- **Cuándo se cierra.** Cuando hay al menos una invocación escrita **y** cada llamada que el harness abrió (`chat`) tiene su traza `chat <modelo>`. Una invocación `OK` con cero tokens que no muestra ninguna llamada tampoco cierra: toda invocación hace al menos una. No se espera un tiempo de silencio: una llamada en curso no escribe nada hasta que acaba, así que el silencio no distingue «terminó» de «sigue».
- **Cuánto dura la retención.** Un turno retenido que no fue cortado por tiempo, lo mismo que antes: entre 3,5 y 8,5 minutos desde su inicio con el límite por defecto. Uno cortado por tiempo, hasta la primera pasada después de que su llamada termine (las vistas, entre 69 y 140 segundos después del corte: en la práctica, la misma ventana o una pasada más). Como mucho, el plazo: 17 minutos desde el inicio con el límite por defecto.
- **Qué es ilegible en el caso nuevo.** (a) Una llamada que el harness abrió y cuya traza no llega: al plazo se cobra la reserva, con el motivo nuevo `model_call_unfinished`; si lo ya escrito suma más que la reserva, se cobra eso. (b) Una traza `chat <modelo>` sin tokens que no falló y a la que el harness dejó de esperar (terminó más de un segundo después que su `chat`): `trace_unreadable`. Esa traza omite los contadores que valen cero, así que sin tokens solo se cree si falló (una llamada rechazada por Bedrock no se cobra) o si su `chat` la esperó hasta el final y dice cero, que es como se ve un bloqueo del guardrail.
- **Al plazo, lo legible si lo hay.** Un turno sin invocación escrita pero con sus llamadas terminadas (fila 4b) se cobra por esas llamadas, con base `trace`; antes se cobraba por la reserva.
- **El plazo no cambia,** ni la fórmula de la reserva, ni el precio guardado, ni las alarmas.
- **Solo del turno (punto 5).** Las llamadas que se suman llevan el id de sesión del turno y empezaron después de su reserva, igual que las invocaciones. Un turno anterior de la misma sesión solo dejó la sesión abierta si terminó con todo su uso informado: no tiene llamadas en curso.
- **Estado nuevo:** dos atributos en la fila del turno ya liquidado (cuántas llamadas se sumaron y cuál de las dos sumas se cobró), para que el evento se pueda volver a escribir igual. No son contenido y caben en los permisos que la función ya tiene.
- **Auditoría (punto 10).** `budget.reconciled` gana `model_calls` (cuántas llamadas al modelo terminadas se vieron) y `usage_source` (`invocations` o `model_calls`: de cuál de las dos sumas salen los tokens y el costo). Los demás campos no cambian.
- **Sin permisos, recursos, parámetros ni supresiones nuevas.** En el change set de `Core` solo cambia el código de las funciones que llevan `mango-core`.
- **Límites.** Las trazas de llamada no traen tokens de caché: los de una llamada cortada no se verían (Mango no usa caché hoy). Si una versión del harness cambia los nombres `chat` o `chat <modelo>`, un turno cortado por tiempo se cobra por la reserva al plazo, no por cero.
- **Comprobado** con tests (uno por cada fila de las tablas de los puntos 3 y 6 que cambia, con la forma real de las trazas) y, solo lectura, con el lector nuevo sobre las 100 sesiones de la validación y 4 turnos cortados más: 97 iguales por las dos sumas, 3 turnos cortados con su costo real, 1 sin invocación con el de su llamada, y 3 con la sesión parada que quedan sin terminar. **No está desplegado.**

**(20) Parar la sesión tras un corte, y el techo de un turno: lo que encontró la investigación del 2026-10-06** (4 turnos cortados de un agente temporal con límite de 15 segundos, 3 de ellos con la sesión parada, y 3 turnos siguientes). **Decidido por el dueño el 2026-10-06:** no se para la sesión (el punto 15 sigue como está) y se envía siempre un tope de tokens por llamada ([D74](D074-tope-de-tokens-en-cada-llamada.md)).

- **`StopRuntimeSession` se puede llamar** sobre la sesión de un harness gestionado: con el ARN del harness y su endpoint (`live`). Con el ARN del runtime que hay debajo responde que se use el harness. Pediría un permiso nuevo en el rol de `mango-api` o del conciliador (`bedrock-agentcore:StopRuntimeSession` sobre los harness de la instalación).
- **No detiene el gasto.** Parada unos 4 y 15 segundos después del corte, y una vez a mitad del turno: Bedrock midió 9.895, 9.465 y 10.512 tokens de salida, como en el turno sin parar (10.033). Parada a mitad del turno, el turno siguió entregando texto hasta su límite.
- **Y pierde la traza.** En las tres sesiones paradas la traza `chat <modelo>` no se escribió nunca. Con la corrección del punto 19 esos turnos se cobrarían por la reserva al plazo (USD 0,134 con USD 0,15 reales), con la alarma.
- **La conversación sigue funcionando** con o sin parar: el turno siguiente abre una sesión nueva y reenvía el historial, como dice el punto 5.
- **La reserva no es el techo de un turno.** Las llamadas de un agente del Builder no llevan tope de tokens propio (`max_tokens_per_call` vacío): el `max_tokens` del agente es un límite del harness para el turno y no se envía con la llamada. Una sola llamada generó 10.033 tokens con `max_tokens` 4.096 y costó USD 0,151 con USD 0,134 reservados. Lo gastado de más sí se cobra, así que cuenta para el turno siguiente. Los agentes de la release sí envían su tope en cada llamada (4.000 en las 253 vistas).
- **Opciones, para el dueño:** (a) no parar la sesión y dejar la conciliación como en el punto 19; (b) además, enviar siempre un tope por llamada, igual al `max_tokens` del agente cuando el Builder no fija otro: no corta la llamada en el límite de tiempo, pero la acota (4.096 tokens son poco más de un minuto) y acerca la reserva a un techo; cambia lo que se envía al modelo y habría que revisar la reserva cuando hay varias iteraciones; (c) parar la sesión solo **después** de conciliar, para liberar el runtime: no ahorra modelo. No se construyó ninguna. El dueño eligió (a) y (b) el 2026-10-06 y descartó (c). La opción (b) es [D74](D074-tope-de-tokens-en-cada-llamada.md): hasta que esté desplegada, una llamada de un agente del Builder sigue sin tope.

Modelo de amenazas: [`budget-reconciliation-threat-model.md`](../../security/threat-models/budget-reconciliation-threat-model.md).
