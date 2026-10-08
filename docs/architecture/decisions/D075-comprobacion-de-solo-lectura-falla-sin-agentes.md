# D75 · La comprobación de solo lectura de una instalación falla si la versión no quedó servible

- **Estado:** vigente
- **Fecha:** 2026-10-08 (propuesta por un agente y aceptada por el dueño el mismo día; el punto 10, un agente cuyo harness ya no existe, decidido por el dueño ese día, con su detalle propuesto por un agente y aceptado por el dueño ese día; lo que una instalación mostró ese día de la pregunta a AgentCore; el veredicto de fallo y el turno de un agente sin harness, vistos en una instalación, propuesto por un agente y aceptado por el dueño el 2026-10-08, punto 11)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (6: de su fila 6 sale un caso, la invocación que AgentCore rechaza porque el harness no existe; es el punto 10 de esta decisión)
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

**(6) Lo que sigue sin probar la corrida de solo lectura.** Que el agente **responda**: no invoca el modelo ni una tool, no pasa por el Gateway y no reserva presupuesto. Tampoco llama a AgentCore para ver que el harness existe (desde el punto 10 sí, cuando su configuración trae `aws.namespace`). Que responda lo prueba el recorrido con efecto `chat`, que sigue siendo opcional. Sigue sin cambiar nada en la instalación.

**(7) Un código TOTP rechazado no es un tiempo agotado.** En el mismo ensayo, una corrida empezó segundos después de otro ingreso del mismo usuario de prueba y falló con un tiempo agotado: Cognito no acepta dos veces el mismo código en su ventana de 30 s. El ingreso compartido de la suite reconoce el rechazo, espera a la ventana siguiente y reintenta **una sola vez**, nunca en bucle; el informe lo anota. Un segundo rechazo falla diciendo que el código fue rechazado y la causa probable. Cualquier otro rechazo en ese paso falla de inmediato con su nombre. Del rechazo solo se lee el nombre de la excepción: ni el código ni la contraseña llegan a un mensaje.

**(8) Lo visto en una instalación (2026-10-08, en una instalación de laboratorio).**

- **La corrida de solo lectura:** 14 recorridos pasaron, ninguno falló y 6 se saltaron, en 53 s. `06-agents` pasó en 1,0 s y el informe dijo «Agentes de la versión: «FinOps» publicado y servido (visto como «admin»)». El árbol de agentes y el historial de publicaciones respondieron al administrador con la forma esperada.
- **Un código rechazado, provocado a propósito** (un ingreso del administrador de prueba en el mismo segundo en que empezó la corrida): Cognito rechazó el primer código con `ExpiredCodeException`, que es la excepción de un código ya usado en su ventana. El recorrido reintentó una vez y pasó; la corrida entera, 14 pasaron y ninguno falló, en 65 s. El informe anotó el reintento. La vigilancia no contó ningún error de consola ni ningún 4xx no declarado.
- **Nota con fecha (2026-10-08, más tarde): la corrida en otras tres situaciones.**
  - **Después de actualizar** la instalación de laboratorio a `v0.1.0-g6f9b8e4`, desde la etiqueta instalada: 14 pasaron, 0 fallaron y 6 se saltaron.
  - **En una instalación desde cero sin segundo administrador** (cuenta nueva, sin packs): 10 pasaron, 0 fallaron y 10 se saltaron; `06-agents` dijo «FinOps publicado y servido».
  - **Con el stack `Core` en `DELETE_FAILED`** tras un fallo del `UninstallGuard` antes de borrar nada ([D58](D058-distribucion-para-clientes.md) (18)), ya con el segundo administrador: 12 pasaron y 0 fallaron. La instalación seguía entera y la corrida lo confirmó.

**(9) Lo que sigue sin verse en una instalación.** Un veredicto de fallo de `06-agents` (el laboratorio tiene su agente publicado) y un segundo rechazo seguido del código. Los dos están con tests unitarios.

- **Nota con fecha (2026-10-08, más tarde): el límite del punto (6) se vio en una instalación.** Tras un fallo del `UninstallGuard` a medio barrido ([D58](D058-distribucion-para-clientes.md) (18)), el harness del agente de la versión ya no existía y el stack quedó en `DELETE_FAILED` con la aplicación en pie. La corrida de solo lectura **pasó:** `06-agents` dijo «FinOps publicado y servido». Lee lo que responde la API, y la API comprueba su puntero, el hash y la forma del ARN del harness; no pregunta a AgentCore. La aplicación seguía mostrando un agente que ya no podía responder: solo lo habría visto un turno de chat. El mensaje del guard sí lo avisa («Some agents or packs may already be gone»). Se anota como hecho; si la API o la comprobación deben preguntar a AgentCore no se decide aquí.
- **Sigue sin verse en una instalación** un veredicto de fallo de `06-agents`: en la situación de la nota anterior, la que más se le parecía, pasó. Y un segundo rechazo seguido del código.

**(10) Un agente cuyo harness ya no existe (2026-10-08).**

Origen: en un ensayo de ese día, el `UninstallGuard` falló a medio barrido ([D58](D058-distribucion-para-clientes.md) (18)) después de borrar el harness del agente de la versión. La aplicación siguió en pie y la corrida de solo lectura dijo «publicado y servido» y pasó. El mismo hueco existe con un harness borrado a mano o por un fallo de AgentCore.

- **Lo que pasaba, leído en el código (no se hizo un turno en ese estado):**
  - `mango-api` sirve un agente desde sus registros (el puntero del provisioner, el hash y la forma del ARN) y no pregunta a AgentCore. Su rol no tiene ningún permiso de lectura sobre AgentCore.
  - La persona que le escribe ve el aviso de cualquier turno fallido («El agente no está disponible en este momento. Inténtalo más tarde.»).
  - **Cada intento le costaba la reserva entera.** El turno era un final desconocido ([D73](D073-turno-cortado-nunca-cuesta-cero.md), fila 6), no dejaba traza, y al llegar el plazo (17 minutos con el límite por defecto) el conciliador cobraba la reserva con el motivo `no_trace`. El modelo no había gastado nada.
  - La reconciliación diaria ([D41](D041-alertas-y-reconciliacion.md)) sí lo detecta: hallazgo `harness_missing` y alarma `Mango-<ns>-Reconciler-findings`. Corre una vez al día (07:00 UTC) y solo avisa.
- **Lo que eligió el dueño el 2026-10-08, por menú,** entre cuatro opciones con su costo (que la API pregunte a AgentCore, que pregunte solo la comprobación, que el reconciliador lo deje escrito, o dejarlo como está):
  - **«(b) Comprobación + turno»:** la comprobación de la instalación pregunta a AgentCore, y el turno reconoce el caso y lo deja dicho. Sin permisos nuevos para `mango-api`, sin latencia añadida y sin que un fallo de AgentCore pueda vaciar el Marketplace.
  - **«Liberar al instante»:** un turno cuyo harness no existe no cobra nada.
- **El turno** (detalle propuesto por un agente y aceptado por el dueño el 2026-10-08):
  - Si AgentCore responde `ResourceNotFoundException` **a la llamada `InvokeHarness`, antes de abrir el stream,** el agente no llegó a correr: el turno es uno que no empezó (fila 3 de D73). La reserva se libera en el momento y no queda fila pendiente.
  - Solo ese código y solo ahí. Cualquier otro error de la llamada (`AccessDeniedException`, `ThrottlingException`, `InternalServerException`, un corte de red) y el mismo código una vez abierto el stream siguen como antes: retenidos y conciliados.
  - **No se puede provocar:** el ARN del harness y su endpoint salen del puntero del provisioner, nunca de la petición.
  - La persona ve el mismo aviso de hoy: el texto es del diseño (D24) y no cambia. `agent.completed` lleva `failure: harness_missing`, con costo cero y `settlement: final`. El log de `mango-api` dice «agent <id> is published but its harness does not exist».
- **La comprobación** (detalle propuesto por un agente y aceptado por el dueño el 2026-10-08):
  - Con `aws.namespace` en su configuración (el `<ns>` de `Mango-<ns>-Core`), `06-agents` pregunta a AgentCore por cada agente de la versión que la aplicación sirve. Son dos lecturas con la AWS CLI y las credenciales de quien corre la suite (`aws.profile`, o las del entorno): `list-harnesses`, una vez, y `get-harness-endpoint` del endpoint `live`. Permisos de quien la corre: `bedrock-agentcore:ListHarnesses` y `bedrock-agentcore:GetHarnessEndpoint`. La región se lee de la instalación.
  - **Falla** si no hay un harness con el nombre exacto del agente (`Mango_<ns>_a_<id>`), si no tiene endpoint `live`, o si alguno de los dos no está `READY`. El fallo dice qué mirar: un stack en `DELETE_FAILED`, el hallazgo `harness_missing` y quién lo borró (CloudTrail).
  - **Si se configuró y no se puede preguntar, falla** (punto 3): credenciales vencidas, sin permiso, o una CLI que no trae el comando. Del error solo se lee su nombre.
  - **Sin `aws.namespace` no se pregunta,** y el informe lo dice («no se preguntó a AgentCore por su harness»). La corrida sigue sin necesitar credenciales de AWS.
  - Sigue siendo de solo lectura: no invoca, no cambia nada y nada de lo que responde la CLI se imprime.
- **Regla 3 de la arquitectura** (toda tool pasa por el Gateway): no aplica. Aquí no hay un agente llamando a un sistema externo; es quien opera la instalación leyendo sus propios recursos.
- **Lo que no cubre.**
  - Con el harness borrado, el Marketplace y `GET /api/agents/<id>` siguen mostrando el agente como publicado: la API no pregunta. Lo notan la comprobación (si se corre con `aws.namespace`), el primer turno (Auditoría y el log) y la reconciliación diaria (en menos de 24 horas).
  - Ninguna alarma nueva: un turno contra un agente sin harness no dispara ninguna hasta la reconciliación diaria.
- **Visto en una instalación de laboratorio (2026-10-08),** con `aws.namespace` en la configuración y el harness en su sitio: la corrida de solo lectura pasó (14 recorridos pasaron, ninguno falló y 6 se saltaron, en 54 s). `06-agents` tardó 2,6 s y el informe dijo «FinOps publicado y servido (visto como «admin»); su harness existe en AgentCore». Los dos comandos de la CLI existen y respondieron.
- **Sigue sin verse en una instalación** (está con tests): el veredicto de fallo por un harness que falta, y el turno que libera la reserva. Que AgentCore responde `ResourceNotFoundException` a `InvokeHarness` sale del modelo del SDK (botocore 1.43), no de una instalación.

**(11) Lo que una instalación mostró del punto (10) (2026-10-08, propuesto por un agente y aceptado por el dueño el 2026-10-08).** El punto (10) dejó sin ver el veredicto de fallo por un harness que falta y el turno que libera la reserva, y decía que la respuesta de AgentCore salía del modelo del SDK. Ese mismo día se vieron los tres en una cuenta de ensayo, con `v0.1.0-gd578994` instalada desde cero, sin packs y con `aws.namespace` en la configuración de la comprobación. Este punto no decide nada.

- **Con el harness en su sitio,** recién instalada: 12 recorridos pasaron, ninguno falló y 8 se saltaron; «FinOps publicado y servido; su harness existe en AgentCore».
- **Cómo se llegó al caso.** Se borraron a mano en AgentCore el endpoint `live` del harness del agente de la versión y después el harness.
- **La comprobación de solo lectura falló.** 11 pasaron, 1 falló (`06-agents`) y 8 se saltaron. Su mensaje: `«FinOps» is published and the application serves it, but AgentCore has no harness for it: nobody can get an answer from it.`, seguido de qué mirar. En el informe: «AgentCore no tiene listo el harness de alguno». Los demás recorridos pasaron: la aplicación sigue sirviendo al agente, como dice «Lo que no cubre».
- **Un turno de chat a ese agente** (una llamada a la API como administrador de prueba): el stream trajo `conversation`, `status` y un `error` con código `upstream_error`, en 1,2 s.
  - Auditoría: `agent.invoke` y `agent.completed` con `failure: harness_missing`, costo 0, `held_usd` 0, 0 tokens y `settlement: final`.
  - Presupuesto: las filas de la persona y del agente, con gastado, comprometido, retenido y reservado en 0. Ninguna fila de turno pendiente.
  - Log de `mango-api`: «agent finops is published but its harness does not exist».
- **AgentCore respondió `ResourceNotFoundException` a `InvokeHarness`.** Lo que el código suponía por el modelo del SDK quedó visto.
- **La desinstalación posterior funcionó** con ese harness ya borrado a mano: el `UninstallGuard` no tropezó con él ([D58](D058-distribucion-para-clientes.md) (20)).
- **Precisa la nota del punto (9),** que decía que seguía sin verse un veredicto de fallo de `06-agents`: este es el primero visto, y es el del harness que falta. El de un agente sin publicar o sin servir sigue solo con tests.
- **Lo que sigue sin verse en una instalación.**
  - El aviso en la pantalla del chat: el turno se hizo contra la API, no se miró en un navegador.
  - El hallazgo `harness_missing` de la reconciliación diaria: no llegó a correr.
  - La comprobación cuando no puede preguntar a AgentCore, o cuando el harness existe y no está `READY`.
  - Un segundo rechazo seguido del código (punto 9).

Sin permisos, recursos, parámetros, dependencias ni supresiones nuevas. Los puntos 1 a 9 son código de pruebas (`tests/install`); el punto 10 toca además el turno de chat de `mango-api`.
