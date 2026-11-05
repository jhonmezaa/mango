# D110 · Evals con AgentCore Evaluations: el contenido se captura solo en un harness propio de las evals

- **Estado:** vigente
- **Fecha:** 2026-11-05 (AgentCore Evaluations y la captura de contenido solo en el harness que corre las evals, elegidas por el dueño ese día, por menú, en dos menús; un harness propio para las evals, distinto del Playground, elegido ese día por menú por el agente que lanzó el trabajo; el modo unificado con canario y el juez solo con evaluadores propios, elegidos ese día por el agente que lanzó el trabajo, punto 8)
- **Precisa / reemplaza a:** reemplaza [D16](D016-observabilidad-de-agentes.md) solo para el harness de evals (captura el contenido); precisa [D26](D026-reglas-del-ciclo-de-vida.md) y [D38](D038-alcance-de-marketplace-v1.md) (las evals entran en alcance y se ejecutan con AgentCore Evaluations), [D91](D091-playground.md) (1) (las evals no corren en el harness del Playground, que sigue sin contenido) y [D32](D032-harness-por-agente.md) (otro harness más que no es de un agente)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `evals.jsx`, `eval-create.jsx`) tiene una vista «Operación › Evals» con suites de casos, criterios, umbral, ejecuciones y el bloqueo de la publicación cuando falla una eval obligatoria (D26). El producto la muestra como «Próximamente» y D38 dejaba las evals fuera de las fases A a C. La investigación del 2026-11-05 comparó cuatro maneras de ejecutarlas. El dueño eligió AgentCore Evaluations, y en un segundo menú, dónde se captura el contenido que necesita.

**(1) Las evals se ejecutan con AgentCore Evaluations** (GA el 2026-03-31; elegido por el dueño el 2026-11-05, por menú). Sus evaluadores propios, con un modelo del catálogo como juez (punto 8), puntúan los turnos de un caso a partir de sus trazas. Cada caso es un turno de un harness con la versión del agente que se prueba, con la identidad de quien la lanza (regla 5) y su presupuesto reservado antes (regla 4; quién paga, D111). Qué modo del servicio se usa (a pedido, sobre las trazas de cada caso, o el de datasets) y cómo se traducen los criterios del diseño («contiene», «usa la tool», «no revela», «juez») a evaluadores lo precisa el PR que lo construye.

**(2) El servicio necesita el contenido, y D16 lo apaga.** Según la documentación de AgentCore Evaluations, para puntuar una sesión necesita los prompts, las respuestas del modelo y las entradas y salidas de las tools; con la captura apagada los spans traen `[REDACTED]`. D16 la apaga en todos los harness, y `AGENTS.md` prohíbe el contenido de conversaciones en logs operativos.

**(3) La captura de contenido, solo en un harness propio de las evals** (elegido por el dueño el 2026-11-05, en un segundo menú: la captura solo en el harness que corre las evals, nunca en los del chat; que sea un harness propio y no el del Playground, elegido ese día por menú por el agente que lanzó el trabajo):

- **Un harness más, solo para evals:** `Mango_<ns>_a_evals`, con su rol bajo el boundary de agentes, como el del Playground (D91 (1)). Invoca la versión probada con su prompt, modelo, tools, knowledge bases, skills y límites, sin cambiar el harness, igual que el Playground.
- **Con captura de contenido**, hacia un **log group propio**, cifrado con una llave KMS, con **retención de 30 días** y que **solo lee el rol del evaluador** (el que usa AgentCore Evaluations para leer las trazas). Ningún otro rol de Mango lo lee, `mango-api` tampoco.
- **Ningún otro harness cambia:** los de los agentes (el chat y las tareas) y el del Playground siguen con la captura apagada, como manda D16. Una prueba manual del Playground no deja contenido en ningún log.
- **Es una excepción de seguridad**, registrada en la tabla de `AGENTS.md` (regla de logging «el contenido de conversaciones no va a logs operativos»), acordada el 2026-11-05 por menú.

**(4) Escrituras y tools.** Las tools de lectura van por el Gateway con el token de quien lanza la eval (regla 3, regla 5): una eval no hace con una tool nada que esa persona no pueda hacer en el chat. Las de escritura nunca se ejecutan, como en el Playground: la firma lleva una marca que el interceptor rechaza para toda tool de escritura (D91 (2)). Cómo se nombra esa marca lo precisa el PR que lo construye.

**(5) Lo que sigue de D26.** Una eval obligatoria que falla bloquea la aprobación, en el servidor; quitar la obligatoriedad lo pide una persona y lo aprueba otro administrador distinto. Los casos con un posible secreto se rechazan al guardarlos, como los prompts (D91 (7)). Los casos desde conversaciones reales siguen bloqueados mientras D23 no esté construido.

**(6) Opciones descartadas.**

- (a) Un runner propio: cada caso, un turno del harness de pruebas en el worker de tareas (D78), con los criterios en código y un juez `Converse` sin tools; se guardaba solo el veredicto y el motivo. Era la recomendada por la investigación, porque cumple D16 sin excepción.
- (b) El mismo runner, guardando además la respuesta del agente 30 días para ver por qué falló.
- (d) Bedrock Model Evaluation (`CreateEvaluationJob`), con las preguntas y respuestas en un bucket: más infraestructura y métricas genéricas, no los criterios del diseño.

**(7) Lo que implica la elegida.** Reemplaza D16 para un harness y abre una excepción de seguridad: el contenido de los casos y de las respuestas vive 30 días en un log group. Suma recursos (el harness, su rol, el log group y su llave, y la configuración de AgentCore Evaluations) que hay que contar contra el límite de `Core` (D99). Los precios de AgentCore Evaluations no estaban confirmados en la página oficial de AWS el 2026-11-05: se confirman antes de estimar el costo de una ejecución. El costo del juez lo cobra el servicio de AgentCore Evaluations, no el rol de un agente, así que en la factura sale aparte del agente (D104).

**(8) Lo que el modelo de amenazas tiene que cerrar antes de construir** (señalado al registrar, en la revisión de seguridad del 2026-11-05):

- **Quién lee el contenido lo impone la llave, no solo IAM.** Un rol de la cuenta con permisos amplios de CloudWatch Logs podría leer el log group. La política de la llave KMS deja descifrar solo al rol del evaluador (y al servicio de logs para escribir), y un test lo fija.
- **El contenido no puede llegar a `aws/spans`.** Ese log group lo leen el conciliador (D73 (9)) y la función de D108. El harness gestionado está hoy en modo dividido (comprobado en la instalación el 2026-11-05, D108 (4)), así que **el harness de evals se configura en modo unificado explícito**, con los spans en su propio log group. La instalación lo comprueba con un **canario**: un caso con un marcador aleatorio que no debe aparecer en `aws/spans`. Falla cerrado: si aparece, las evals quedan desactivadas y salta una alarma (decidido el 2026-11-05 por el agente que lanzó el trabajo).
- **El juez, solo con evaluadores propios** (`CreateEvaluator`, con un modelo del catálogo, regla 7), sin los evaluadores incorporados (`Builtin.*`) que usan un modelo que Mango no elige (decidido el 2026-11-05 por el agente que lanzó el trabajo).
- **Las salidas de las tools de lectura quedan capturadas.** Un caso que llama a una tool de lectura con el token de quien lanza la eval deja sus datos reales en el log group 30 días, no solo el texto del caso.

**(9) Lo que precisó la construcción** (2026-11-05; elegido ese día por menú por el agente que lanzó el trabajo, dentro de lo que eligió el dueño):

- **El canario paga desde un ámbito propio.** Cada versión del harness de evals se comprueba con un turno de 64 tokens con un marcador aleatorio, sin tools, que lanza el evaluador cuando el provisioner publica esa versión. La regla 4 obliga a reservar antes y no hay persona ni agente que pague: reserva en `AGENT#evals`, con un tope de **1 USD al mes** (fijo de la release), y se cierra como un turno con origen `eval` (D106). Con el tope agotado, el canario falla cerrado sin invocar nada. Su `Evaluate` de prueba se reserva en el mismo ámbito.
- **Los jueces salen de la configuración de la instalación.** `models.judges` (de uno a cinco modelos; por defecto, el modelo auxiliar) fija qué modelos pueden juzgar. Hay un evaluador propio de AgentCore Evaluations por cada uno, declarado en la release (`AWS::BedrockAgentCore::Evaluator`, con instrucciones fijas que tratan el turno como datos y una escala PASS o FAIL). El rol del evaluador (`Mango-<ns>-EvalJudge`) solo invoca esos modelos, por ARN concreto. Una suite solo puede nombrar como juez uno de ellos que además esté habilitado en el catálogo. Cambiar la lista es actualizar el stack.
- **Quién invoca un harness** (precisa TM-M11 del modelo de amenazas de Marketplace v1, «solo `mango-api` invoca un harness»). `mango-api` sigue siendo el único rol que invoca los harness de los agentes y del Playground, y también el de evals, para cada caso. El rol del evaluador invoca **solo el harness de evals, y solo para el turno del canario**. Lo fija `infra/test/provisioner.test.ts`.

Modelo de amenazas: `docs/security/threat-models/evals-threat-model.md` (lo escribe el PR que construye las evals).
