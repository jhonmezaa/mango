# D108 · Observabilidad: la traza de cada respuesta sale de `aws/spans`, leída por una función propia

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** precisa [D73](D073-turno-cortado-nunca-cuesta-cero.md) (7) y (8) (las trazas de `aws/spans` se leen también para una vista, no solo para cobrar, y no desde `mango-api`) y [D16](D016-observabilidad-de-agentes.md) (las trazas sin contenido pasan a ser, además, la fuente de la vista Observabilidad)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `observability2.jsx`) tiene una vista «Operación › Observabilidad» que muestra cada respuesta de un agente como una traza: las llamadas al modelo y a las tools, con su duración, tokens y costo, en cascada. El producto la muestra como «Próximamente». `mango-api` ya ve en el stream del harness cada llamada a una tool con su latencia (D90) y los tokens y el costo del turno (`agent.completed`), pero no guarda la duración del turno ni el desglose por llamada al modelo. Las trazas OTel del harness sí lo tienen, sin contenido (D16), en el log group `aws/spans` de Transaction Search.

**(1) La fuente: las trazas del harness, leídas por una función propia** (elegido por el dueño el 2026-11-05, por menú). Una Lambda de Mango lee `aws/spans` con `logs:FilterLogEvents`, como el conciliador de D73 (9), y entrega a la vista los spans de cada respuesta. Va en un **stack anidado** de `Core` (D99), no en `Core` mismo, que roza el límite de recursos.

**(2) Lo que esto precisa de D73, dicho una vez.** D73 (7) no dio a `mango-api` lectura de las trazas de toda la cuenta, y D73 (8) aceptó leerlas para cobrar bien un turno cortado. Con esta decisión el dueño acepta leerlas también **para mostrar una vista**. `mango-api` sigue sin permiso sobre `aws/spans`: la única que lo lee es la función nueva, con `FilterLogEvents` sobre ese log group y nada más de CloudWatch Logs.

**(3) Solo metadatos.** Las trazas ya no traen contenido (D16: prompts, respuestas y resultados de tools van `[REDACTED]`). Aun así, la función solo entrega una lista cerrada de atributos de cada span: su tipo, el modelo o la tool, inicio, duración, tokens y estado. Nunca un atributo de contenido, aunque llegara sin redactar, y un test lo fija, como el de la Actividad (D90 (3)). El id de sesión del runtime no sale de la función ni llega al navegador: se deriva de la persona, el agente y la conversación (D73 (5)). La vista usa un id propio y aleatorio para cada traza.

**(4) Antes de construir: comprobar dónde escribe el harness.** Según la documentación de AgentCore (consultada el 2026-11-05), los agentes creados desde el 2026-07-20 usan por defecto la telemetría unificada, que escribe los spans en el log group del runtime y no en `aws/spans`. D73 se validó leyendo `aws/spans` en octubre, así que el harness gestionado parece seguir en el modo dividido. Se comprueba primero en la documentación y, si hace falta, con una lectura en AWS que el dueño apruebe antes. Si escribe en otro log group, la decisión vale igual sobre ese log group, con el mismo permiso acotado, y se precisa aquí.

**(5) Lo que trae la fuente y lo que no.** Ve las invocaciones que `mango-api` no vio (un turno cortado, una ejecución de una tarea) y la cascada exacta del harness. Depende de los nombres de los atributos que escribe el harness, que AWS puede cambiar: los tests fijan los que se leen, y un atributo que falta deja el span sin ese dato, nunca la vista caída. Cómo invoca `mango-api` a la función, el tope de lectura por carga y la paginación los precisa el PR que la construye.

**(6) Opciones descartadas.** (a) Un registro propio del turno, escrito por `mango-api` al cerrarlo (`TRACE#<día>` en `AuditIndex`, 30 días, como la Actividad): era la recomendada por la investigación, sin infraestructura nueva y sin leer las trazas de toda la cuenta. (c) Enlazar CloudWatch GenAI Observability en la consola de AWS: solo sirve a quien opera AWS, no a la app.

**(7) Lo que implica la elegida.** Unos cuatro recursos nuevos en un stack anidado (la función, su rol, su log group y, si fuera asíncrona, su DLQ), una lectura de un log group de toda la cuenta para una vista y la dependencia de los atributos del harness.

Modelo de amenazas: `docs/security/threat-models/observability-threat-model.md` (lo escribe el PR que construye la función).
