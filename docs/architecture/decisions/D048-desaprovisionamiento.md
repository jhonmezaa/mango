# D48 · Desaprovisionamiento al retirar un agente

- **Estado:** vigente
- **Fecha:** 2026-10-01 (IAM exige el boundary de agentes también para borrar el rol, decidido por el dueño el 2026-10-09, punto 7; lo que dos instalaciones mostraron de ese punto, nota propuesta por un agente y aceptada por el dueño el 2026-10-09, punto 8)
- **Precisa / reemplaza a:** en el texto: ajusta [D41](D041-alertas-y-reconciliacion.md) (punto 5)
- **Precisada por:** [D53](D053-alineacion-con-claude-design.md) (precisa, punto 2); [D58](D058-distribucion-para-clientes.md) (precisa; su punto 22 precisa el punto 3 solo para la desinstalación: el `UninstallGuard` sí quita las políticas gestionadas de un rol antes de borrarlo, decidido por el dueño el 2026-10-09. Al retirar un agente, el punto 3 sigue igual)

## Decisión

**(1) Qué se borra.** Retirar un agente (`POST /api/agents/{id}/retire`) inicia, además del retiro, el borrado de sus recursos en AWS: los endpoints del harness salvo `DEFAULT`, el harness `Mango_<ns>_a_<id>` (y con él su Runtime gestionado y su workload identity) y el rol `Mango-<ns>-agent-<id>` con sus políticas inline. Nada más: las versiones quedan `retired`, el puntero `PUBLISHED#<id>` y el historial se conservan ([D22](D022-marketplace-compartir-retirar.md)), y los log groups del Runtime vencen por su retención de 30 días ([D16](D016-observabilidad-de-agentes.md)).

**(2) Cómo.** Por SDK, con el patrón del provisioner: una máquina de Step Functions (`Mango-<ns>-AgentDeprovisioner`) y una Lambda del mismo paquete. **Sin CodeBuild ni `cdk deploy`: [D25](D025-recursos-creados-en-runtime.md) y la regla 2 no cambian.** `mango-api` solo inicia la ejecución con `{agent_id}`; cada paso vuelve a leer que el agente está `retired` y deriva del id qué borra. El orden es obligado (comprobado en el laboratorio): `DeleteHarness` falla mientras exista un endpoint distinto de `DEFAULT` y borrar un endpoint es asíncrono (minutos); el rol se borra al final, cuando el harness ya no existe. Es idempotente y usa el mismo bloqueo por agente que el provisioner.

**(3) Qué no se borra nunca.** Los agentes de la release (FinOps), aunque se retiren: su lista viene del stack y el rol del deprovisioner tiene además un `Deny` explícito sobre sus nombres. Tampoco un agente que no esté `retired`, ni uno cuya versión servida no lo esté, ni un rol sin el permissions boundary de agentes o con políticas gestionadas (se deja para una persona y se reporta).

**(4) Permisos.** Rol propio `Mango-<ns>-Deprovisioner`, separado del provisioner: solo borra, por prefijo de nombre. Sin `Create*`, `Update*`, `PassRole`, `Invoke*` ni `GetHarness`; `DeleteRolePolicy` exige el boundary. En la tabla `Agents` lee seis atributos (nunca la definición) y escribe solo el bloqueo.

**(5) Auditoría y fallos.** Evento `agent.deprovision` con `requested`, `applied` o `rejected`, fail-closed: sin `requested` no se borra nada y sin `applied` no se da por terminado. El retiro no depende del borrado: si la ejecución no arranca o falla, el agente sigue retirado. Una ejecución fallida dispara la alarma `Mango-<ns>-AgentDeprovisioner-failed` (topic de alertas, [D41](D041-alertas-y-reconciliacion.md)) y, si 45 minutos después del retiro queda algo, el reconciliador diario lo reporta como `deprovision_incomplete` (con alarma) hasta que una ejecución lo borre; un operador la reinicia a mano (runbook). **Ajusta [D41](D041-alertas-y-reconciliacion.md):** el reconciliador sigue sin reparar, pero los restos de un agente retirado dejan de ser solo informativos.

**(6) Riesgo aceptado.** «Retirado» lo dice la tabla, que escribe `mango-api`, y el retiro lo decide un solo administrador (spec §3): ahora tiene efecto en AWS. Se acepta porque el retiro ya dejaba al agente sin servicio y no se deshace.

**(7) IAM exige el boundary de agentes también para borrar el rol (2026-10-09, decidido por el dueño el 2026-10-09, por menú).** El punto (4) dice que `DeleteRolePolicy` exige el boundary. `iam:DeleteRole` no llevaba esa condición: un comentario del constructo decía que `iam:PermissionsBoundary` no era una clave de condición de `DeleteRole`, y que el rol tuviera el boundary lo comprobaba solo el código de la función. Con eso, IAM dejaba al rol del deprovisioner borrar cualquier rol bajo `Mango-<ns>-agent-*`, lo hubiera creado el provisioner o no.

- **El comentario estaba desfasado.** La referencia de autorización de servicios de AWS para IAM lista `iam:PermissionsBoundary` entre las claves de condición de `DeleteRole` (leída el 2026-10-09). Y el rol del `UninstallGuard` ya borra roles con esa condición ([D58](D058-distribucion-para-clientes.md)), visto en instalaciones el 2026-10-07 y el 2026-10-08.
- **Qué cambia.** La sentencia que permite `iam:DeleteRole` (ahora `DeleteAgentRoleWithBoundary`, en `infra/lib/constructs/deprovisioner.ts`) lleva la misma condición que `DeleteRolePolicy`: `iam:PermissionsBoundary` igual al boundary de agentes de la instalación. Misma acción y mismo recurso: el rol solo pierde, no gana nada. Las dos escrituras de IAM que tiene el deprovisioner quedan atadas al boundary por IAM.
- **Qué no cambia.** La función sigue comprobando el boundary antes de borrar: es lo que deja el código `role_without_boundary` en la auditoría, y ahora es la segunda barrera en vez de la única. La regla del punto (3) sigue igual: el deprovisioner no desadjunta, y un rol con políticas gestionadas se deja para una persona y se reporta.
- **Las opciones del menú:** añadir la condición en una rama aparte, o anotarlo para después. El dueño eligió la primera («Sí, en una rama aparte»).
- **Con qué se comprobó.** Con tests de la plantilla (`infra/test/deprovisioner.test.ts`): la sentencia con su condición, que toda escritura de IAM del rol la lleva y que la lista de acciones del rol es la misma. Sin ver en una instalación: el borrado de un rol de agente con esta condición en el rol del deprovisioner.

**(8) Lo que dos instalaciones mostraron del punto (7) (nota del 2026-10-09, propuesta por un agente y aceptada por el dueño el 2026-10-09).** No cambia lo decidido: dice con qué se ha comprobado.

- **En una instalación que se actualiza.** Una instalación de laboratorio con datos pasó de `v0.1.0-gd578994` a `v0.1.0-gc1c233a`: la política del rol del deprovisioner (`DeprovisionerRoleDefaultPolicy…`) apareció como `Modify` de `PolicyDocument`, sin reemplazo. El rol mismo no apareció. El change set entero está en [D58](D058-distribucion-para-clientes.md) (23).
- **Leído de IAM después.** 15 sentencias. `iam:DeleteRole` está solo en `DeleteAgentRoleWithBoundary`, con la condición `iam:PermissionsBoundary`. La política en línea mide 4.395 caracteres de los 10.240 que IAM admite (IAM no cuenta los espacios): un 57 % de margen.
- **El deprovisioner borró el rol de un agente retirado, con esa condición (2026-10-09).** En una instalación nueva en una cuenta de ensayo, con `v0.1.0-gc1c233a` (el ensayo de [D58](D058-distribucion-para-clientes.md) (24)).
  - Un agente de prueba, creado por la API y publicado con doble aprobación. Su rol lo creó el provisioner de agentes. Antes de retirarlo, el rol tenía el boundary de agentes, una política en línea y ninguna adjunta.
  - Retirado por la API, con motivo. La ejecución del deprovisioner terminó `SUCCEEDED`. A los 43 s de retirarlo ya no existían ni el harness ni el rol.
  - CloudTrail, por el rol del deprovisioner, todo sin error: `DeleteHarnessEndpoint` 3 s después de retirar, `DeleteHarness` a los 14 s, y `DeleteRolePolicy` y `DeleteRole` a los 35 s.
- **Sin ver en una instalación:** IAM negándole al deprovisioner el borrado de un rol sin el boundary. El rol de ese agente lo llevaba.

Amenazas TM-M21 a TM-M23 en el modelo de Marketplace v1
