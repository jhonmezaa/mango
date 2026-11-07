# D115 · Presupuesto del sandbox de código: se reserva el tiempo de cómputo antes del turno y se liquida con lo medido

- **Estado:** vigente
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat; ninguna de las preguntas del dueño de ese día la eligió por sí sola) · aceptada por el dueño el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)»
- **Precisa / reemplaza a:** precisa la regla 4 de `AGENTS.md` y [D73](D073-turno-cortado-nunca-cuesta-cero.md) (una tool que se cobra por tiempo de cómputo); usa la regla 7 (precios como configuración)
- **Precisada por:** —

## Decisión

Origen: el sandbox de [D114](D114-code-interpreter-detras-del-gateway.md) se cobra por segundo de vCPU y de memoria mientras la sesión vive. La regla 4 pide reservar antes de invocar una tool, así que el turno debe reservar también su tiempo de sandbox. Plan: [`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md).

**(1) Reserva antes del turno.** La reserva del turno suma, a la del modelo y a la de las búsquedas de knowledge bases, la del sandbox: `celdas como mucho × 300 s × precio por segundo (vCPU + GB) + arranque de una sesión nueva`. Las celdas como mucho son el menor de `max_iterations` y un tope de celdas por turno. Solo la reservan las versiones con la capacidad `code_interpreter`.

**(2) Precios como configuración (regla 7).** Los precios por vCPU-hora y por GB-hora del Code Interpreter van en el catálogo, como el de los embeddings de las knowledge bases; nunca en el código.

**(3) Liquidación con lo medido.** La Lambda mide cada celda y escribe su uso (turno, segundos, estado), ligado a la firma de la invocación como `kb.retrieve` liga su auditoría. Al cerrar el turno se suma lo medido. Lo que no se sabe se retiene y se concilia: «no sé lo que costó» nunca se registra como «no costó nada» ([D73](D073-turno-cortado-nunca-cuesta-cero.md)).

**(4) Sesiones ociosas.** El tiempo en que la sesión vive sin celdas se carga al turno que la abrió o la prolongó. La vida corta de [D114](D114-code-interpreter-detras-del-gateway.md) (4) lo acota.

**(5) Ámbitos y Playground.** Persona y agente, como el chat; en el Playground, los mismos ([D91](D091-playground.md) (3)), con una sesión nueva por prueba que se cierra al terminar.

**(6) Orden de magnitud.** Una celda de 300 s con 2 vCPU y 8 GB cuesta unos 0,02 USD a precios de lista de 2026-11; ocho celdas al tope, unos 0,17 USD, comparable a un turno largo de modelo.
