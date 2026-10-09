# D48 · Desaprovisionamiento al retirar un agente

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** en el texto: ajusta [D41](D041-alertas-y-reconciliacion.md) (punto 5)
- **Precisada por:** [D53](D053-alineacion-con-claude-design.md) (precisa, punto 2); [D58](D058-distribucion-para-clientes.md) (precisa; su punto 22 precisa el punto 3 solo para la desinstalación: el `UninstallGuard` sí quita las políticas gestionadas de un rol antes de borrarlo, decidido por el dueño el 2026-10-09. Al retirar un agente, el punto 3 sigue igual)

## Decisión

**(1) Qué se borra.** Retirar un agente (`POST /api/agents/{id}/retire`) inicia, además del retiro, el borrado de sus recursos en AWS: los endpoints del harness salvo `DEFAULT`, el harness `Mango_<ns>_a_<id>` (y con él su Runtime gestionado y su workload identity) y el rol `Mango-<ns>-agent-<id>` con sus políticas inline. Nada más: las versiones quedan `retired`, el puntero `PUBLISHED#<id>` y el historial se conservan ([D22](D022-marketplace-compartir-retirar.md)), y los log groups del Runtime vencen por su retención de 30 días ([D16](D016-observabilidad-de-agentes.md)).

**(2) Cómo.** Por SDK, con el patrón del provisioner: una máquina de Step Functions (`Mango-<ns>-AgentDeprovisioner`) y una Lambda del mismo paquete. **Sin CodeBuild ni `cdk deploy`: [D25](D025-recursos-creados-en-runtime.md) y la regla 2 no cambian.** `mango-api` solo inicia la ejecución con `{agent_id}`; cada paso vuelve a leer que el agente está `retired` y deriva del id qué borra. El orden es obligado (comprobado en el laboratorio): `DeleteHarness` falla mientras exista un endpoint distinto de `DEFAULT` y borrar un endpoint es asíncrono (minutos); el rol se borra al final, cuando el harness ya no existe. Es idempotente y usa el mismo bloqueo por agente que el provisioner.

**(3) Qué no se borra nunca.** Los agentes de la release (FinOps), aunque se retiren: su lista viene del stack y el rol del deprovisioner tiene además un `Deny` explícito sobre sus nombres. Tampoco un agente que no esté `retired`, ni uno cuya versión servida no lo esté, ni un rol sin el permissions boundary de agentes o con políticas gestionadas (se deja para una persona y se reporta).

**(4) Permisos.** Rol propio `Mango-<ns>-Deprovisioner`, separado del provisioner: solo borra, por prefijo de nombre. Sin `Create*`, `Update*`, `PassRole`, `Invoke*` ni `GetHarness`; `DeleteRolePolicy` exige el boundary. En la tabla `Agents` lee seis atributos (nunca la definición) y escribe solo el bloqueo.

**(5) Auditoría y fallos.** Evento `agent.deprovision` con `requested`, `applied` o `rejected`, fail-closed: sin `requested` no se borra nada y sin `applied` no se da por terminado. El retiro no depende del borrado: si la ejecución no arranca o falla, el agente sigue retirado. Una ejecución fallida dispara la alarma `Mango-<ns>-AgentDeprovisioner-failed` (topic de alertas, [D41](D041-alertas-y-reconciliacion.md)) y, si 45 minutos después del retiro queda algo, el reconciliador diario lo reporta como `deprovision_incomplete` (con alarma) hasta que una ejecución lo borre; un operador la reinicia a mano (runbook). **Ajusta [D41](D041-alertas-y-reconciliacion.md):** el reconciliador sigue sin reparar, pero los restos de un agente retirado dejan de ser solo informativos.

**(6) Riesgo aceptado.** «Retirado» lo dice la tabla, que escribe `mango-api`, y el retiro lo decide un solo administrador (spec §3): ahora tiene efecto en AWS. Se acepta porque el retiro ya dejaba al agente sin servicio y no se deshace.

Amenazas TM-M21 a TM-M23 en el modelo de Marketplace v1
