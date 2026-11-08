# D122 · Memoria de AgentCore por persona

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «AgentCore Memory por usuario», sabiendo que contradice D13; el punto 8, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07, en el modelo de amenazas; el cómo, puntos 2 a 7, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** **contradice [D13](D013-identidad-hasta-las-tools.md)** y reemplaza su «Harness con `Memory: Disabled`» (el resto de D13 sigue rigiendo); aplica R4 de [D11](D011-requisitos-de-seguridad.md) (TM-007: namespaces por persona y tests de aislamiento); precisa [D23](D023-acceso-de-admins-a-conversaciones.md) (los administradores tampoco leen memorias) y [D16](D016-observabilidad-de-agentes.md) (una memoria es contenido)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). Hasta hoy la memoria de AgentCore estaba desactivada a propósito ([D13](D013-identidad-hasta-las-tools.md)), y el equivalente más cercano era la búsqueda en las conversaciones propias ([D103](D103-buscar-conversaciones-propias-en-mango-api.md)).

**(1) Qué (elegido por el dueño, por menú: «AgentCore Memory por usuario»).** Los agentes recuerdan entre conversaciones con AgentCore Memory, separada por persona. **Esto contradice [D13](D013-identidad-hasta-las-tools.md)**, que dejaba el harness con `Memory: Disabled`: esa parte de D13 deja de regir y D13 pasa a `parcial`. Hasta que se construya esta decisión, la memoria sigue desactivada en el código.

**(2) Aislamiento antes de nada (propuesto por un agente).** Antes de construir: el modelo de amenazas `memory-threat-model.md` y una prueba en AWS del aislamiento entre namespaces (M0 del plan, con autorización del dueño). R4 pide además tests de aislamiento persona↔persona y área↔área en CI.

**(3) El recurso (propuesto por un agente).** Una AgentCore Memory de la instalación con estrategias de preferencias, hechos y resumen. El namespace sale del `sub` verificado de la persona (y del agente, como pide R4), lo pone el servidor y nunca el modelo. El harness la usa solo con el namespace de quien pregunta. Una memoria compartida por área solo con una decisión propia.

**(4) Lo que controla la persona (propuesto por un agente).** Ver, editar y borrar sus memorias en Ajustes, y un indicador en el chat cuando un turno usó memoria. Al dar de baja a una persona se borra toda su memoria.

**(5) Quién más la lee (propuesto por un agente).** Nadie: los administradores no leen memorias, como no leen conversaciones ([D23](D023-acceso-de-admins-a-conversaciones.md)).

**(6) Contenido (propuesto por un agente).** Una memoria es contenido de la persona: nunca en logs operativos ni en la auditoría, que registra solo ids y conteos ([D16](D016-observabilidad-de-agentes.md)).

**(7) Diseño (propuesto por un agente).** La pantalla «Memoria» y el indicador salen de la ronda de Claude Design de su fase ([D24](D024-diseno-de-la-ui.md)).

**(8) Lo que fijó el modelo de amenazas (2026-11-07, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07).** El modelo [`memory-threat-model.md`](../../security/threat-models/memory-threat-model.md) (TM-ME1 a TM-ME10) fija:
- **El recurso:** una memoria de la instalación con llave propia, `RETAIN` y en un stack anidado ([D99](D099-stacks-anidados-en-core.md)), referenciada por ARN desde cada harness. Nunca la memoria gestionada por harness, que se crea por defecto si no se dice nada; un test lo impide (TM-ME8).
- **El actor:** la memoria es por persona **y agente**. El `actorId` de cada `InvokeHarness` lo arma una sola función del servidor desde el `sub` verificado y el id del agente; el harness lleva un actor centinela sin registros y el trabajador falla cerrado si no puede armarlo (TM-ME1). El creador de un agente compartido no lee la memoria de nadie (TM-ME6).
- **Fuera del chat:** las tareas ([D78](D078-tareas-sin-chat.md)), las evals ([D110](D110-evals-con-agentcore-evaluations.md)) y el Playground ([D91](D091-playground.md)) no usan memoria en v1 (TM-ME9).
- **Borrado:** borrar una conversación borra sus eventos, no los registros ya extraídos, que se ven y se borran en «Memoria». Dar de baja a una persona borra registros y eventos, con un barrido al día siguiente; los eventos caducan a los 7 días (TM-ME5).
- **Extracción:** solo de lo que dice la persona, si la prueba M0 confirma que se puede; si no, el dueño decide antes de M1 si se activa la estrategia de hechos en agentes con tools (TM-ME2).
- **Antes de M1, la prueba M0** responde qué guarda el harness en los eventos, si IAM acota por actor, si el harness da al modelo tools de memoria, qué llega a `aws/spans` (si llega texto, el lector de trazas lo redacta, TM-ME4) y el formato del `actorId`.

Sus riesgos residuales quedan pendientes de aceptación del dueño.
