# D27 · Confirmación de tools de escritura por tramos

- **Estado:** vigente
- **Fecha:** 2026-09-30 (precisada el 2026-10-07: solo un mensaje que terminó como llamada a tool pide confirmar una escritura)
- **Precisa / reemplaza a:** —
- **Precisada por:** [D56](D056-tools-de-escritura-con-aprobacion.md) (la construye); [D74](D074-tope-de-tokens-en-cada-llamada.md) (18: solo un mensaje que terminó como llamada a tool pide confirmar una escritura)

## Decisión

Ninguna tool de escritura se ejecuta sin confirmación. La política de cada tool define un umbral (monto, cantidad de recursos o entorno): **por debajo, confirma el propio usuario** (tarjeta en el chat, auditada); **por encima, N aprobadores distintos de quien la pidió** (1 a 3, con vencimiento; lo vencido se rechaza).

**Fail-closed:** si falta el dato o no se puede interpretar, aplica el tramo de aprobadores. El tramo lo calcula el backend con los argumentos reales de la tool, nunca el LLM ni el texto del chat. La autoconfirmación también emite el approval token ligado a `hash(tool, args)`, para que no se confirme una cosa y se ejecute otra. Cambiar una política requiere doble aprobación

**Cuándo se pide una confirmación (2026-10-07, decidido por el dueño).** Solo de una llamada cuyo mensaje terminó como llamada a tool (`tool_use`). Un mensaje que termina de cualquier otra manera (su tope de tokens, el límite de tiempo, una intervención del guardrail, un final que hoy no se conoce) o cuyo fin no llega no pide confirmar ninguna de sus llamadas de escritura ([D74](D074-tope-de-tokens-en-cada-llamada.md) (18)). Comprobado con tests, sin ver en una instalación.
