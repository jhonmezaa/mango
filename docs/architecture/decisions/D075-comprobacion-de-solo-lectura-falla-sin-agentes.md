# D75 · La comprobación de solo lectura de una instalación falla si la versión no quedó servible

- **Estado:** vigente
- **Fecha:** 2026-10-08 (propuesta por un agente y aceptada por el dueño el mismo día)
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Origen: hito 1, «instalable por una empresa real». En el ensayo de ciclo de vida del 2026-10-07, la primera instalación quedó sin su agente (la publicación falló) y la comprobación de solo lectura, que es lo primero que el runbook manda correr, dijo «pasó»: 13 recorridos pasaron, ninguno falló y 6 se saltaron. Con cero agentes, el Marketplace y la API coinciden en una lista vacía. Solo lo habría visto el recorrido con efecto `chat`, que es opcional y gasta presupuesto. El detalle que sigue lo propuso un agente y **el dueño lo aceptó el 2026-10-08**, por menú («Integrar, con la decisión nueva»).

**(1) La regla.** `mise run install-check` sin efectos es lo primero que se corre tras instalar o actualizar. Debe **fallar, no saltarse,** cuando falta algo que toda instalación sana tiene.

**(2) Qué exige de los agentes** (recorrido `06-agents` de `tests/install`, solo lectura):

- **Los agentes esperados salen de la versión,** no de la configuración de la prueba: uno por `agents/<id>/agent.json` del repositorio, que debe estar en la etiqueta instalada. Cada versión publica sus agentes al instalarse ([D34](D034-guardrail-y-agentes-de-la-release.md)), así que su ausencia es una instalación rota, tenga o no la configuración una sección `chat`.
- **Publicado y servido:** algún usuario de prueba lo tiene activo en su Marketplace, y `GET /api/agents/<id>` le responde con la versión publicada. Esa ruta responde con la versión que serviría el chat, tras comprobar el puntero del provisioner, el hash del contenido y el harness ([D40](D040-provisioner-de-agentes.md)).
- **Ningún usuario de prueba con un agente activo es un fallo,** traiga lo que traiga la versión.
- Con sección `chat`, su agente está además en el Marketplace de quien preguntaría.

**(3) Lo que no se puede comprobar, falla.** Si un agente de la versión está publicado pero ningún usuario de prueba puede usarlo, el recorrido **falla** diciendo que no puede comprobarlo; no se salta. El defecto de origen fue justamente un «pasó» con recorridos saltados. **Consecuencia: la configuración de la comprobación necesita un usuario de prueba con un grupo de cada agente de la versión.**

**(4) El fallo dice qué mirar.** Si la publicación falló y en qué paso, si sigue en curso o si nunca empezó (lo lee del historial de publicaciones cuando hay un administrador de prueba), y dónde mirar: la alarma `Mango-<ns>-AgentProvisioner-failed`, la ejecución del provisioner, su log y «Problemas conocidos» del runbook de instalación.

**(5) Lo que no es un fallo, y el informe anota:** un agente de la versión que un administrador retiró; tools del agente cuyo pack no está instalado (los packs se habilitan después de instalar); y una actualización cuya publicación falló mientras la versión anterior sigue sirviendo.

**(6) Lo que sigue sin probar la corrida de solo lectura.** Que el agente **responda**: no invoca el modelo ni una tool, no pasa por el Gateway y no reserva presupuesto. Tampoco llama a AgentCore para ver que el harness existe. Eso lo prueba el recorrido con efecto `chat`, que sigue siendo opcional. Sigue sin cambiar nada en la instalación.

**(7) Un código TOTP rechazado no es un tiempo agotado.** En el mismo ensayo, una corrida empezó segundos después de otro ingreso del mismo usuario de prueba y falló con un tiempo agotado: Cognito no acepta dos veces el mismo código en su ventana de 30 s. El ingreso compartido de la suite reconoce el rechazo, espera a la ventana siguiente y reintenta **una sola vez**, nunca en bucle; el informe lo anota. Un segundo rechazo falla diciendo que el código fue rechazado y la causa probable. Cualquier otro rechazo en ese paso falla de inmediato con su nombre. Del rechazo solo se lee el nombre de la excepción: ni el código ni la contraseña llegan a un mensaje.

**(8) Lo visto en una instalación (2026-10-08, en una instalación de laboratorio).**

- **La corrida de solo lectura:** 14 recorridos pasaron, ninguno falló y 6 se saltaron, en 53 s. `06-agents` pasó en 1,0 s y el informe dijo «Agentes de la versión: «FinOps» publicado y servido (visto como «admin»)». El árbol de agentes y el historial de publicaciones respondieron al administrador con la forma esperada.
- **Un código rechazado, provocado a propósito** (un ingreso del administrador de prueba en el mismo segundo en que empezó la corrida): Cognito rechazó el primer código con `ExpiredCodeException`, que es la excepción de un código ya usado en su ventana. El recorrido reintentó una vez y pasó; la corrida entera, 14 pasaron y ninguno falló, en 65 s. El informe anotó el reintento. La vigilancia no contó ningún error de consola ni ningún 4xx no declarado.

**(9) Lo que sigue sin verse en una instalación.** Un veredicto de fallo de `06-agents` (el laboratorio tiene su agente publicado) y un segundo rechazo seguido del código. Los dos están con tests unitarios.

Sin permisos, recursos, parámetros, dependencias ni supresiones nuevas: es código de pruebas (`tests/install`).
