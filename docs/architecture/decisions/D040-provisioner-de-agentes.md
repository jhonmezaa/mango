# D40 · Provisioner de agentes: quién publica y con qué permisos

- **Estado:** parcial. Rigen (1), (2) y (4). El punto (3) ya no rige: con [D56](D056-tools-de-escritura-con-aprobacion.md) el provisioner publica agentes con tools de escritura de conectores de Mango marcadas en `approval_tools` (`functions/provisioner/src/mango_provisioner/harness.py`).
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D56](D056-tools-de-escritura-con-aprobacion.md) (deja sin efecto el punto 3)

## Decisión

**(1) Puntero de publicación.** Qué versión sirve un agente lo dice el ítem `PUBLISHED#<id>` de la tabla `Agents` (versión, `content_hash`, harness y su versión), que el provisioner escribe en la misma transacción que publica. Solo el provisioner puede escribir esa partición; `mango-api` tiene un `Deny` explícito (`dynamodb:LeadingKeys`). El chat debe servir desde ese puntero y verificar el contenido contra su hash (A5); el provisioner ya compensa a partir de él.

**(2) `CreateHarness` sobre `Resource: *` con tags obligatorios.** AgentCore autoriza `CreateHarness` sobre `harness/*` y, como un harness es un Runtime gestionado, crea ese Runtime, su endpoint y su workload identity con los permisos de quien llama, también sobre `runtime/*` y `workload-identity/*`: el id se genera al crear, así que IAM no puede acotar por nombre. `aws:CalledVia` y `aws:ViaAWSService` no sirven (probado en el laboratorio: la creación falla). En su lugar esas acciones exigen los tags `mango:namespace=<ns>` y `mango:component=agent` (`aws:RequestTag`), que AgentCore propaga del harness al Runtime; el resto de acciones (update, delete, endpoints) sí va por prefijo `Mango_<ns>_a_*`, y el provisioner solo puede pasar roles `Mango-<ns>-agent-*` con el permissions boundary. Riesgo residual aceptado: un provisioner comprometido podría crear un Runtime propio, pero solo con un rol de agente acotado por el boundary.

**(3) Tools de escritura.** El provisioner no publica agentes con tools de escritura ni con `approval_tools` (`write_tools_unsupported`) hasta que exista la aprobación por llamada ([D27](D027-confirmacion-de-escritura-por-tramos.md)).

**(4) Trust de los roles de agente.** Solo AgentCore, de la cuenta de la instalación y con `aws:SourceArn` limitado al harness y al Runtime de ese agente (el ARN del harness es obligatorio: sin él `CreateHarness` rechaza el rol)
