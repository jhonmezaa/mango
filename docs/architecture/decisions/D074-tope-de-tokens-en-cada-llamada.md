# D74 · Toda llamada al modelo lleva un tope de tokens, y la reserva cubre una llamada entera

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (20: construye su opción (b); 19: la salida que cuenta la reserva cambia para los agentes cuyo tope por llamada supera su máximo de tokens)
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

Modelo de amenazas: [`budget-reconciliation-threat-model.md`](../../security/threat-models/budget-reconciliation-threat-model.md) (TM-BR16 y TM-BR17).
