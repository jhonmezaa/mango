# D57 · Progreso del turno en vivo en el chat

- **Estado:** vigente
- **Fecha:** 2026-10-02
- **Precisa / reemplaza a:** precisa [D39](D039-sesion-del-runtime-y-latencia.md)
- **Precisada por:** —
- **Tema en el registro original:** Progreso del turno en vivo en el chat (precisa [D39](D039-sesion-del-runtime-y-latencia.md))

## Decisión

El chat recibe en vivo la fase del turno (pensando, consultando una tool, procesando resultados, escribiendo) como evento SSE `status`, calculada por `mango-api` y **sin texto del modelo**; el texto sigue llegando en bloques revisados por el guardrail síncrono. Medido en el laboratorio: con el guardrail síncrono Bedrock no entrega texto ni razonamiento antes del primer bloque revisado y el tamaño del bloque no es configurable; el razonamiento nativo retrasa el primer bloque de 6–7 s a ~16 s. Por eso el razonamiento del modelo no se muestra (usuario, 2026-10-02, opción «progreso estructurado» frente a guardrail propio en bloques chicos o razonamiento al final). Primera señal en el chat a ~0,5 s (antes 4–8 s). La presentación visual la define Claude Design
