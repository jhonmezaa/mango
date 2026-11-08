# D57 · Progreso del turno en vivo en el chat

- **Estado:** vigente
- **Fecha:** 2026-10-02 (el formato de sus nueve eventos se retiró del stream el 2026-11-08, R5b de D120 (7): ver la nota al final)
- **Precisa / reemplaza a:** precisa [D39](D039-sesion-del-runtime-y-latencia.md)
- **Precisada por:** [D120](D120-stream-del-chat-en-parches-json.md) (reemplaza su formato de eventos por parches JSON; la fase del turno, sin texto del modelo, pasa a los metadatos del mensaje)
- **Tema en el registro original:** Progreso del turno en vivo en el chat (precisa [D39](D039-sesion-del-runtime-y-latencia.md))

## Decisión

El chat recibe en vivo la fase del turno (pensando, consultando una tool, procesando resultados, escribiendo) como evento SSE `status`, calculada por `mango-api` y **sin texto del modelo**; el texto sigue llegando en bloques revisados por el guardrail síncrono. Medido en el laboratorio: con el guardrail síncrono Bedrock no entrega texto ni razonamiento antes del primer bloque revisado y el tamaño del bloque no es configurable; el razonamiento nativo retrasa el primer bloque de 6–7 s a ~16 s. Por eso el razonamiento del modelo no se muestra (usuario, 2026-10-02, opción «progreso estructurado» frente a guardrail propio en bloques chicos o razonamiento al final). Primera señal en el chat a ~0,5 s (antes 4–8 s). La presentación visual la define Claude Design

## Nota (2026-11-08, R5b de D120 (7))

`POST /api/chat` y su stream de nueve eventos se retiraron en un PR propio, que se integra una semana después de instalar el formato nuevo sin regresiones (D120 (7)). La web, el cliente de la API y el mock de desarrollo solo usan `POST /api/chat/turns` y el stream `v1` de [D120](D120-stream-del-chat-en-parches-json.md). Lo que esta decisión fija sigue en pie: la fase del turno la calcula `mango-api`, no lleva texto del modelo y va en los metadatos del mensaje. Los eventos de D57 siguen siendo el formato del registro del turno (`TURN#<turn>#EVT#<seq>`), que el stream traduce al leerlo.

