# D42 · Chat con varios agentes y agentes de la release

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** en el texto: precisa [D34](D034-guardrail-y-agentes-de-la-release.md) (punto 3) y [D39](D039-sesion-del-runtime-y-latencia.md) (punto 4)
- **Precisada por:** —

## Decisión

**(1) Agente y modelo de una conversación.** La conversación guarda el agente de su primer turno y no cambia; el modelo se elige por turno entre los permitidos de la versión publicada y no se guarda. `mango-api` sirve cada turno desde el puntero `PUBLISHED#<id>` ([D40](D040-provisioner-de-agentes.md)) y reserva el presupuesto con el precio de ese modelo en el catálogo de modelos, en el ámbito `AGENT#<id>`.

**(2) Agentes retirados.** Un agente retirado no recibe turnos, ni en conversaciones nuevas ni en las que ya existían (409 `agent_retired`); el historial se sigue leyendo.

**(3) Siembra de los agentes de la release (precisa [D34](D034-guardrail-y-agentes-de-la-release.md)).** El stack escribe la versión 1 de cada agente de la release ya aprobada (`approved_by: release@<versión>`), solo si el agente no existe, e inicia el provisioner. El provisioner solo publica una aprobación de la release para los ids y hashes que el stack trae. No hay evento de auditoría propio de la siembra: los del provisioner llevan ese aprobador. Cambiar la definición en una release posterior no cambia una instalación existente; el cambio se hace en la app ([D18](D018-creacion-y-publicacion-de-agentes.md)).

**(4) Sesión del runtime (precisa [D39](D039-sesion-del-runtime-y-latencia.md)).** La conversación guarda con qué se abrió su sesión (acceso del usuario, versión del agente y modelo); un turno con otro valor abre una sesión nueva y reenvía el historial.

**(5) Riesgo aceptado.** La siembra la hace la Lambda proveedora de CDK, cuyo rol puede escribir la partición de los agentes de la release e iniciar el provisioner; quien pueda invocarla podría publicar otro contenido bajo el id de un agente de la release. Se acepta (TM-M16) con un control de detección: el reconciliador diario ([D41](D041-alertas-y-reconciliacion.md)) alarma si un agente de la release sirve un hash distinto del de la release. Esa alarma también salta, y se mantiene, tras un cambio legítimo aprobado en la instalación: lo confirma una persona.

**(6) Migración de FinOps.** Dos despliegues: en el primero conviven el harness de CDK y el del provisioner, y el interceptor acepta las firmas v1 y v2; el segundo elimina el harness de CDK, la firma v1 y la política Cedar por rol (`docs/runbooks/poc-deploy.md`)
