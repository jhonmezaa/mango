# D39 · Sesión del runtime por conversación y latencia del chat

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D42](D042-chat-con-varios-agentes.md) (precisa, punto 4); [D57](D057-progreso-del-turno-en-vivo.md) (precisa)

## Decisión

**El guardrail sigue en modo síncrono:** la salida se evalúa antes de mostrarse, así que Bedrock la entrega en bloques de unos 1.000 caracteres y no token a token; el modo asíncrono queda descartado porque mostraría texto que el guardrail aún no revisó.

**Una sesión de AgentCore por conversación:** el `runtimeSessionId` es un SHA-256 del usuario verificado, su acceso (rol, área y grupos), el agente, la conversación, una generación y la huella de la configuración del agente. Nunca viene del cliente y dos usuarios no pueden compartirlo; es necesario porque la sesión conserva el historial y se direcciona solo por su id (verificado en el laboratorio: otro `actorId` con el mismo id lee el historial). Con la sesión viva, `mango-api` envía solo el mensaje nuevo. Si no es seguro que siga viva o intacta, abre una generación nueva y reenvía el historial guardado: inactividad mayor al timeout menos 60 s, vida máxima próxima, turno en curso, fallido o cortado por el guardrail, cambio de acceso del usuario o de configuración del agente. Cada sesión la toma un solo turno a la vez (escritura condicional en la conversación).

**`idleRuntimeSessionTimeout` baja de 900 a 300 s:** antes cada turno dejaba una sesión viva 15 minutos; ahora hay una por conversación y la memoria en espera se factura un tercio del tiempo.

**Objetivo de latencia:** «primer bloque de la respuesta ≤ 6 s (p50)» reemplaza a «primer token ≤ 3 s», inalcanzable con el guardrail síncrono (`docs/specs/mvp-finops.md` §8)
