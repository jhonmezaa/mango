# D26 · Reglas del ciclo de vida (del diseño de Claude Design, R1–R16)

- **Estado:** parcial. Construidas las validaciones del servidor, los grupos de acceso ([D44](D044-cambios-de-grupos-y-claim-central.md)), las reglas de packs ([D46](D046-api-del-catalogo-de-mcp.md)) y el HITL por tool ([D27](D027-confirmacion-de-escritura-por-tramos.md), [D56](D056-tools-de-escritura-con-aprobacion.md)). Faltan evals, skills y knowledge bases; los schedules los construye [D78](D078-tareas-sin-chat.md), en estado propuesta ([D38](D038-alcance-de-marketplace-v1.md) aplaza las dos primeras).
- **Fecha:** 2026-09-30; 2026-10-21 (el sentido de la alerta de las knowledge bases, decidido por el dueño ese día, por menú: «Sí, cambia el sentido (Recomendada)», en D88 (26))
- **Precisa / reemplaza a:** —
- **Precisada por:** [D38](D038-alcance-de-marketplace-v1.md) (aplaza evals y skills); [D44](D044-cambios-de-grupos-y-claim-central.md) (construye la doble aprobación de grupos); [D60](D060-gestion-de-personas.md) (precisa); [D78](D078-tareas-sin-chat.md) (construye «Schedules», en estado propuesta); [D79](D079-investigacion-de-anomalias-por-evento.md) (precisa «Schedules»: el disparador por anomalía de costo, en estado propuesta); [D88](D088-knowledge-bases-sobre-s3.md) (cambia el sentido de la alerta de las knowledge bases)

## Decisión

**Evals:** una eval obligatoria que falla **bloquea** la aprobación; quitar la obligatoriedad requiere un segundo admin; casos de eval desde conversaciones reales solo si la instalación activó [D23](D023-acceso-de-admins-a-conversaciones.md), enmascarados, auditados y con retención propia (requiere modelo de amenazas).

**Validaciones del servidor** al enviar a revisión: detección de secretos (prompt, skills, tareas, casos de eval) y un modelo sin soporte de tools no puede tener tools.

**Grupos de acceso** con tipo central, de área o general (solo los centrales usan "Datos de cuentas"); crear un grupo o cambiarle el tipo requiere **doble aprobación**.

**Packs MCP:** cambiar parámetros y actualizar a una versión con tools nuevas requieren doble aprobación (mientras tanto sigue la anterior); deshabilitar lo hace un solo admin con motivo.

**Skills versionadas** (el agente usa la versión de su publicación): las skills **con scripts** solo vienen en la release de Mango (revisadas, escaneadas y firmadas); las de **solo instrucciones** las crean admins y creadores, con aprobación por versión ([D18](D018-creacion-y-publicacion-de-agentes.md)) y detección de secretos; los agentes que no ejecutan scripts no tienen `shell`.

**Schedules:** cada tarea corre con la identidad de quien la creó (regla 5) y se pausa si pierde el acceso; entrega a Slack "Próximamente"; requiere modelo de amenazas.

**Knowledge bases:** alerta de exposición si el agente es visible para grupos sin acceso a la KB (al llegar esa fase).

**Knowledge bases, sentido de la alerta (2026-10-21):** una KB solo responde a quien está en sus grupos (regla 5, [D88](D088-knowledge-bases-sobre-s3.md) (15)). La alerta ya no avisa de que esas personas podrían ver su contenido: avisa de que las personas de los grupos que usan el agente sin acceso a la KB **no recibirán respuestas de esa KB**. Decidido por el dueño el 2026-10-21, por menú: «Sí, cambia el sentido (Recomendada)».

**HITL:** umbral y número de aprobadores configurables por tool (p. ej. doble aprobación sobre un monto) y vencimiento por tool (lo vencido se rechaza)
