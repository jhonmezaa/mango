# D110 · Evals con AgentCore Evaluations: el contenido se captura solo en un harness propio de las evals

- **Estado:** vigente
- **Fecha:** 2026-11-05 (AgentCore Evaluations y la captura de contenido solo en el harness que corre las evals, elegidas por el dueño ese día, por menú, en dos menús; un harness propio para las evals, distinto del Playground, elegido ese día por menú por el agente que lanzó el trabajo)
- **Precisa / reemplaza a:** reemplaza [D16](D016-observabilidad-de-agentes.md) solo para el harness de evals (captura el contenido); precisa [D26](D026-reglas-del-ciclo-de-vida.md) y [D38](D038-alcance-de-marketplace-v1.md) (las evals entran en alcance y se ejecutan con AgentCore Evaluations), [D91](D091-playground.md) (1) (las evals no corren en el harness del Playground, que sigue sin contenido) y [D32](D032-harness-por-agente.md) (otro harness más que no es de un agente)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `evals.jsx`, `eval-create.jsx`) tiene una vista «Operación › Evals» con suites de casos, criterios, umbral, ejecuciones y el bloqueo de la publicación cuando falla una eval obligatoria (D26). El producto la muestra como «Próximamente» y D38 dejaba las evals fuera de las fases A a C. La investigación del 2026-11-05 comparó cuatro maneras de ejecutarlas. El dueño eligió AgentCore Evaluations, y en un segundo menú, dónde se captura el contenido que necesita.

**(1) Las evals se ejecutan con AgentCore Evaluations** (GA el 2026-03-31; elegido por el dueño el 2026-11-05, por menú). Sus evaluadores (los incorporados y los propios, con un modelo como juez) puntúan los turnos de un caso a partir de sus trazas. Cada caso es un turno de un harness con la versión del agente que se prueba, con la identidad de quien la lanza (regla 5) y su presupuesto reservado antes (regla 4; quién paga, D111). Qué modo del servicio se usa (a pedido, sobre las trazas de cada caso, o el de datasets) y cómo se traducen los criterios del diseño («contiene», «usa la tool», «no revela», «juez») a evaluadores lo precisa el PR que lo construye.

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

Modelo de amenazas: `docs/security/threat-models/evals-threat-model.md` (lo escribe el PR que construye las evals).
