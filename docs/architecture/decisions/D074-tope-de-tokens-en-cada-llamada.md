# D74 · Toda llamada al modelo lleva un tope de tokens, y la reserva cubre una llamada entera

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día; precisada ese día tras verla en una instalación, puntos 12 a 14; el detalle del punto 13 lo propuso un agente y se aceptó ese día por delegación del dueño, que lo confirmó el 2026-10-07; lo que una instalación mostró ese día de ese arreglo, puntos 15 y 16; la reconciliación diaria, comprobada el 2026-10-07, punto 17)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (20: construye su opción (b); 19: la salida que cuenta la reserva cambia para los agentes cuyo tope por llamada supera su máximo de tokens; 6: saca un caso de la fila 6 de su tabla, punto 13 de esta decisión)
- **Precisada por:** —

## Decisión

Origen: hito 1, «instalable por una empresa real». [D73](D073-turno-cortado-nunca-cuesta-cero.md) (20) dejó visto que la reserva de un turno no era su techo: una sola llamada de un agente del Builder generó 10.033 tokens con un máximo de 4.096 y costó USD 0,151 con USD 0,134 reservados. El dueño eligió el 2026-10-06 **«enviar siempre un tope»**, igual al máximo de tokens del agente cuando no tenga otro, y, ante las opciones para la reserva, **«cubrir una llamada entera»**. El detalle que sigue lo propuso un agente con lo medido y **el dueño lo aceptó el 2026-10-06**.

**(1) La regla.** Ninguna llamada al modelo sale sin tope de tokens de salida.

**(2) Cuál es el tope.** El «tokens por llamada» de la versión del agente si lo tiene (`max_tokens_per_call`); si no, sus «tokens máximos por respuesta» (`max_tokens`). Lo calcula el servidor desde la versión publicada (`AgentLimits.call_max_tokens`); la persona no lo envía.

**(3) Dónde va.** En dos sitios, con la misma regla:

- **En cada invocación** (`mango-api`): es lo que hace que valga para **todos los agentes ya publicados, sin republicarlos**, desde que la instalación se actualiza.
- **En la configuración guardada del harness** (el provisioner), para las publicaciones nuevas: si algún día la invocación dejara de enviarlo, el harness lo tendría.
- La reconciliación diaria ([D41](D041-alertas-y-reconciliacion.md)) no cambia ni avisa de nada nuevo: compara de cada harness sus marcas (agente, versión, hash del contenido), su rol y su versión publicada, no la configuración del modelo. Los harness de los agentes existentes no se reescriben.
- No cambia el formato de un agente, el Builder ni la API: el tope se deriva, no se guarda, y el hash del contenido de una versión es el mismo.

**(4) Por qué hace falta: lo que hace hoy cada límite** (trazas de tres días de una instalación de laboratorio, solo lectura, y un turno de comprobación):

- **El `max_tokens` del agente es un límite del harness y no corta una llamada.** No viaja con la llamada al modelo (las 120 llamadas de agentes del Builder no traen tope) y el harness no la detiene al pasarlo: un turno con `max_tokens` 4.096 y tiempo de sobra generó 5.765 tokens en una llamada y terminó normal (`end_turn`), con el texto completo.
- **El tope que viaja con la llamada sí lo aplica el modelo.** Los agentes de la release ya lo envían: 4.000 en sus 633 llamadas.
- **Ninguna llamada llegó a su tope:** la más larga de las 633 fue de 1.360 tokens. Ver el punto 9.

**(5) Qué garantiza ahora la reserva.** La reserva cuenta como salida el mayor entre `max_tokens` y el tope por llamada. Así, **la salida de una llamada nunca cuesta más que la salida reservada**. Con los límites por defecto del Builder (4.096 tokens, 8 iteraciones) y el modelo por defecto:

| | Tokens | USD |
|---|---|---|
| Reserva de un turno (pregunta corta) | 48.000 de entrada + 4.096 de salida | 0,205 |
| Salida de una llamada, como mucho | 4.096 | 0,061 |
| La llamada vista antes de esta decisión | 10.033 de salida | 0,150 |

- Solo cambia la reserva de un agente cuyo tope por llamada es **mayor** que su `max_tokens` (el Builder deja elegir 8.192 por llamada con 1.024 por respuesta): reserva más. No hay ninguno así en la release.
- Un tope por llamada **menor** que `max_tokens` no baja la reserva (FinOps: 4.000 por llamada, 8.000 reservados).

**(6) Qué no garantiza.** La reserva sigue siendo una estimación del turno, no su techo:

- **Varias llamadas.** Un agente con tools hace hasta `max_iterations` llamadas por turno y la reserva cuenta la salida una vez. Con los límites por defecto, ocho llamadas al tope serían USD 0,49 de salida con USD 0,205 reservados en total. No se ha visto nada cercano: el turno con más salida de un agente con tools sumó 1.930 tokens. Un agente sin tools hace una llamada por turno.
- **La entrada.** Se estima en 6.000 tokens más el historial por iteración; no tiene tope. Se vieron 14.525 en una llamada y 58.195 en un turno de cinco.
- **Lo gastado de más se cobra entero,** como antes: cuenta para el turno siguiente.
- El dueño descartó el 2026-10-06 reservar la salida de todas las iteraciones: triplica la reserva (USD 0,64 por defecto) y con USD 5 al mes cabrían 7 turnos a la vez en lugar de 24.

**(7) Qué le pasa a una respuesta larga.** Una respuesta más larga que el tope **se corta ahí**, a media frase si toca. Antes no se cortaba: el modelo seguía hasta terminar (5.765 y 10.033 tokens vistos con 4.096). Con el máximo por defecto son unas 2.400 palabras en español. Quien necesite respuestas más largas sube el máximo del agente (hasta 8.192) en el Builder y publica una versión.

**(8) Qué ve la persona.** El texto hasta el corte, como una respuesta terminada: el chat no distingue hoy este final de uno normal y no hay texto para ello en el diseño (D24). No se añadió ninguno; va al próximo brief de diseño.

**(9) A quién afecta y desde cuándo.**

- A **todos los agentes hechos en el Builder** que no fijan «tokens por llamada»: desde que la instalación se actualiza a la versión que trae esta decisión, en su turno siguiente. No hay que republicar nada.
- Los agentes que ya fijan el suyo, y **los de la release, no cambian.**
- El Builder muestra 4.096 en «Tokens por llamada» cuando la versión no lo fija. El tope real es entonces el de «Tokens máximos por respuesta»: coinciden con los valores por defecto y difieren si alguien cambió solo el segundo. Se anota para el diseño; no se tocó `apps/web`.

**(10) Lo que no cambia.** El límite de tiempo sigue sin detener una llamada en curso: tras un corte, la llamada sigue hasta su tope y se paga (D73 (18) y (19)); ahora ese resto está acotado. No se para la sesión del runtime (D73 (20)). El plazo y las reglas de la conciliación, las alarmas y el precio guardado, iguales. Sin permisos, recursos, parámetros ni supresiones nuevas.

**(11) Lo que queda sin ver en una instalación.** Esta decisión **no está desplegada**.

- **Una llamada que llega a su tope:** qué motivo de fin recibe `mango-api` y qué queda en el chat. Según la API del harness es `max_tokens`. El código lo trata como final conocido si llega el uso de la llamada; si no llega, o si el harness lo informa como error, el turno queda retenido y lo cierra la conciliación (D73). Dos turnos hechos para provocarlo no lo lograron: el agente de la release se negó a escribir un texto largo.
- **Que el tope de la invocación sustituye al guardado en el harness:** lo dice la API y es como ya viaja el modelo elegido; no se vio con dos valores distintos.
- **Cómo comprobarlo tras actualizar:** un turno con un agente del Builder; su traza `chat <id del modelo>` debe traer `gen_ai.request.max_tokens` con el máximo del agente. Y una pregunta que pida un texto largo: la traza termina con `finish_reasons: max_tokens` y no pasa del tope.

**(12) Lo que se vio en una instalación el 2026-10-06, y lo que los puntos 7, 8 y 11 decían de más.** La decisión se desplegó ese día en una instalación de laboratorio. Del punto 11:

- **El tope viaja y corta.** Un agente del Builder publicado antes, sin republicar: su traza `chat <modelo>` trae `gen_ai.request.max_tokens` 4.096, y una pregunta que pedía un texto largo terminó en 4.096 tokens de salida con `finish_reasons: max_tokens`. El agente de la release sigue con su 4.000.
- **Pero la respuesta no quedaba «como una respuesta terminada».** El punto 7 decía que la respuesta «se corta ahí» y el punto 8 que la persona ve «el texto hasta el corte, como una respuesta terminada». El punto 11 lo daba por no visto y avisaba de que, si el harness lo informaba como error, el turno quedaría retenido. Eso es lo que pasó, y peor para la persona de lo que el punto 11 contaba:
  - El harness trata el tope como una excepción. Su stream entrega el fin del mensaje con el motivo `max_tokens`, después el uso de esa llamada y **después un error** (`runtimeClientError`), que el SDK lanza como excepción al leer el stream.
  - `mango-api` lo trató como un turno fallido: la persona vio el texto hasta el corte y debajo el aviso de que el agente no estaba disponible, con «Reintentar»; **la respuesta no se guardó** (al recargar quedaba solo la pregunta); se cobró lo usado (USD 0,092) y el resto de la reserva (USD 0,116) quedó retenido 8 min 27 s, hasta la conciliación.
  - «Reintentar» repite la pregunta: se cortaría en el mismo punto y se cobraría otra vez.
- La conciliación cerró bien ese turno, por sus llamadas al modelo ([D73](D073-turno-cortado-nunca-cuesta-cero.md) (19)). La traza `invoke_agent` de un turno así sale con error y sin tokens.
- Un turno cortado por su límite de tiempo no pasa por aquí: su llamada también acaba en `max_tokens`, pero después del corte, y su texto sí quedaba guardado.

**(13) El arreglo.** El dueño eligió el 2026-10-06 **«arreglarlo ahora»**: `mango-api` trata ese final como conocido, guarda el texto cortado y liquida al momento, sin aviso de error, que es lo que los puntos 7 y 8 decían. Descartó dejarlo para otro día y quitar el tope. El detalle que sigue lo propuso un agente con lo visto y **se aceptó el 2026-10-06 por delegación del dueño**: esa noche encargó tomar la opción recomendada en lo que hubiera que preguntarle. **El dueño lo confirmó el 2026-10-07**, incluido que la sesión de ese turno no se continúa.

- **Qué final es.** Lo último que entregó el stream es el uso de un mensaje cuyo motivo de fin es `max_tokens`, y lo que sigue es un error del harness con el código `runtimeClientError`. Se decide por esos datos, que pone AgentCore; no se lee el texto del error.
- **Qué pasa entonces.** El turno termina como final conocido ([D73](D073-turno-cortado-nunca-cuesta-cero.md) (2)): se guarda el mensaje con el texto hasta el corte, el chat recibe el final normal con `stop_reason: max_tokens`, se cobra el uso real de todas las llamadas del turno, se libera el resto de la reserva y `agent.completed` sale con `settlement: final`. Sin error para la persona ni en el log.
- **Por qué es un final conocido.** La llamada que se cortó ya informó su uso y el harness no sigue después de ese error: no queda ninguna llamada en curso. En un turno con tools, el uso de las llamadas anteriores ya estaba sumado.
- **Qué caso sale de la fila 6 de D73, y solo ese.** La fila 6 («el harness informa un error»: se cobra lo conocido y el resto queda retenido) la decidió el dueño porque el uso de la llamada en curso no se conoce. Aquí sí se conoce. Todo lo demás de la fila queda igual: un error sin ese final justo antes, un tope cuyo uso no llegó, otro código de error después del tope, o cualquier evento entre el uso y el error.
- **La sesión de ese turno no se continúa.** El harness cerró la invocación con un error y no se vio qué guarda su sesión del mensaje cortado. El turno siguiente abre una sesión nueva y reenvía el historial guardado, con el texto cortado una sola vez ([D39](D039-sesion-del-runtime-y-latencia.md): «si no es seguro que siga intacta»). Antes de este punto el código la habría continuado.
- **Lo que no cambia.** La conciliación, la fórmula de la reserva, el tope y los límites de tiempo. `apps/web` tampoco: el chat ya muestra un final con `max_tokens` como cualquier respuesta terminada, con su «Reintentar». Sin permisos, recursos, parámetros ni supresiones nuevas.
- **Lo que la persona todavía no sabe.** Nada le dice que la respuesta se cortó por su límite: ese aviso no está en el diseño (D24). No se añadió ningún texto; va al próximo brief, junto con si «Reintentar» tiene sentido en una respuesta cortada.

**(14) Lo que queda sin ver en una instalación.** El tope **está desplegado en una instalación de laboratorio** desde el 2026-10-06. **El arreglo del punto 13 no está desplegado**: se comprobó con tests que reproducen la secuencia vista.

- La secuencia se vio en **un** turno, de un agente sin tools. Sin ver: el tope en la segunda o tercera llamada de un turno con tools; una llamada a una tool cortada a medias por el tope; que el error llegue alguna vez antes que el uso (ese turno queda retenido, como antes).
- **Cómo comprobarlo tras actualizar:** la misma pregunta larga a un agente del Builder. El texto queda en el chat sin aviso de error y sigue ahí al recargar; `agent.completed` trae `stop_reason: max_tokens`, `settlement: final` y `held_usd: 0`, con los mismos tokens que la traza `chat <modelo>`; no queda fila pendiente ni `budget.reconciled` de ese turno; el log de `mango-api` no trae «chat turn failed»; y un mensaje siguiente en esa conversación se responde con la respuesta cortada a la vista del agente.

**(15) Lo que una instalación mostró del arreglo del punto 13 (2026-10-06, en una instalación de laboratorio).** El punto 14 lo daba por no desplegado. Se desplegó ese día, en una versión que solo cambia `mango-api`, y se repitió la prueba del punto 12: la misma pregunta, letra por letra, al mismo agente del Builder, sin republicarlo. Un turno, a la primera.

- **El final.** El chat mostró el texto hasta el corte (unos 14.300 caracteres, cortados a media frase), sin aviso de error.
- **Quedó guardada.** La conversación tiene en su tabla la pregunta y la respuesta, que termina en el punto del corte, y el turno siguiente la tuvo a la vista. En la instalación del punto 12 quedaba solo la pregunta.
- **La liquidación.** `agent.completed` salió con `stop_reason: max_tokens`, `settlement: final` y `held_usd: 0`, con 10.169 tokens de entrada y 4.096 de salida: los mismos que la traza `chat <modelo>`, que termina en `finish_reasons: max_tokens`. No quedó fila pendiente, ni a los 34 segundos de terminar ni después de la pasada siguiente del conciliador; no hubo `budget.reconciled` de ese turno, y el log de `mango-api` no trae «chat turn failed». Se cobró lo mismo que en el punto 12 (USD 0,092) y no se retuvo nada (allí, USD 0,116 durante 8 min 27 s).
- **La secuencia de eventos es la que el arreglo esperaba:** el fin del mensaje con `max_tokens`, su uso y el error, sin nada entre el uso y el error.
- **El mensaje siguiente.** `agent.invoke` salió con sesión nueva, y su traza es de otra sesión que la del turno cortado. La entrada fue de 14.311 tokens: los 10.169 de antes más la respuesta cortada, una sola vez. El agente citó el punto exacto en el que se había cortado y terminó normal (`end_turn`, `settlement: final`).
- **La traza `invoke_agent` de ese turno sigue saliendo con error y sin tokens.** La escribe el harness, que sigue cerrando esa invocación con su error; lo que cambió es cómo lo lee `mango-api`. Las trazas `chat` y `chat <modelo>` sí traen los tokens. Quien mire las trazas no debe leerlo como un fallo del agente.
- **El resto, igual.** Un turno normal del agente de la release respondió como antes, con su tope de 4.000.
- **Del punto 10:** la llamada que sigue tras un corte por tiempo paró en su tope (4.096 tokens, 47,6 segundos después del corte): [D73](D073-turno-cortado-nunca-cuesta-cero.md) (21).
- **Lo que la persona sigue sin saber,** como decía el punto 13: nada le dice que la respuesta se cortó. Debajo queda «Reintentar», como en cualquier respuesta, y el anuncio para lector de pantalla dice que la respuesta está completa. Va al próximo brief de diseño (D24).

**(16) Lo que sigue sin verse en una instalación, tras el punto 15 (2026-10-06).** Lo visto es **un** turno, de un agente que no llamó a ninguna tool.

- **El tope en una llamada posterior a la primera** de un turno con tools, y **una llamada a una tool cortada a medias** por el tope.
- **Los finales que deben seguir retenidos** (un tope cuyo uso no llega, otro código de error, un evento entre el uso y el error, el error antes que el uso): no se pueden provocar desde fuera y están en los tests.
- **Un turno de varias llamadas que pase de su reserva** (punto 6).
- **Sin comprobar todavía: que la reconciliación diaria ([D41](D041-alertas-y-reconciliacion.md)) no marque desvíos por esta decisión.** El punto 3 dice que no cambia ni avisa de nada nuevo; su resultado posterior a estos despliegues no se ha mirado.

**(17) La reconciliación diaria no marcó desvíos (2026-10-07, en una instalación de laboratorio).** El punto 16 lo dejaba sin comprobar. La primera ejecución de la reconciliación diaria ([D41](D041-alertas-y-reconciliacion.md)) posterior a los dos despliegues, el del tope y el de su arreglo, corrió una vez y sin errores, y terminó con **cero hallazgos y cero limpiezas**, igual que las de los tres días anteriores. Su alarma de hallazgos y la de fallos no cambiaron de estado, y su cola de fallos quedó vacía. Los agentes temporales de las validaciones no dejaron harness ni roles huérfanos.

- **Lo que comprueba:** que enviar el tope en cada invocación no altera lo que la reconciliación compara de los agentes ya publicados (punto 3).
- **Sin ver todavía:** un harness creado ya con el tope guardado que siga vivo a la hora de la reconciliación. Los agentes publicados en esa instalación son anteriores a esta decisión, y el agente temporal publicado después se retiró antes de esa ejecución.

Modelo de amenazas: [`budget-reconciliation-threat-model.md`](../../security/threat-models/budget-reconciliation-threat-model.md) (TM-BR16, TM-BR17 y TM-BR18).
