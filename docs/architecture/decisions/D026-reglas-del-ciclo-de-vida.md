# D26 · Reglas del ciclo de vida (del diseño de Claude Design, R1–R16)

- **Estado:** parcial. Construidas las validaciones del servidor, los grupos de acceso ([D44](D044-cambios-de-grupos-y-claim-central.md)), las reglas de packs ([D46](D046-api-del-catalogo-de-mcp.md)) y el HITL por tool ([D27](D027-confirmacion-de-escritura-por-tramos.md), [D56](D056-tools-de-escritura-con-aprobacion.md)). Faltan evals, skills, schedules y knowledge bases ([D38](D038-alcance-de-marketplace-v1.md) aplaza las dos primeras).
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** —
- **Precisada por:** [D38](D038-alcance-de-marketplace-v1.md) (aplaza evals y skills); [D44](D044-cambios-de-grupos-y-claim-central.md) (construye la doble aprobación de grupos); [D60](D060-gestion-de-personas.md) (precisa)

## Decisión

**Evals:** una eval obligatoria que falla **bloquea** la aprobación; quitar la obligatoriedad requiere un segundo admin; casos de eval desde conversaciones reales solo si la instalación activó [D23](D023-acceso-de-admins-a-conversaciones.md), enmascarados, auditados y con retención propia (requiere modelo de amenazas).

**Validaciones del servidor** al enviar a revisión: detección de secretos (prompt, skills, tareas, casos de eval) y un modelo sin soporte de tools no puede tener tools.

**Grupos de acceso** con tipo central, de área o general (solo los centrales usan "Datos de cuentas"); crear un grupo o cambiarle el tipo requiere **doble aprobación**.

**Packs MCP:** cambiar parámetros y actualizar a una versión con tools nuevas requieren doble aprobación (mientras tanto sigue la anterior); deshabilitar lo hace un solo admin con motivo.

**Skills versionadas** (el agente usa la versión de su publicación): las skills **con scripts** solo vienen en la release de Mango (revisadas, escaneadas y firmadas); las de **solo instrucciones** las crean admins y creadores, con aprobación por versión ([D18](D018-creacion-y-publicacion-de-agentes.md)) y detección de secretos; los agentes que no ejecutan scripts no tienen `shell`.

**Schedules:** cada tarea corre con la identidad de quien la creó (regla 5) y se pausa si pierde el acceso; entrega a Slack "Próximamente"; requiere modelo de amenazas.

**Knowledge bases:** alerta de exposición si el agente es visible para grupos sin acceso a la KB (al llegar esa fase).

**HITL:** umbral y número de aprobadores configurables por tool (p. ej. doble aprobación sobre un monto) y vencimiento por tool (lo vencido se rechaza)
