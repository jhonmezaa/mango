# D91 · El Playground: quien edita un agente prueba su borrador en un harness de pruebas compartido, como sí mismo, sin escrituras y con presupuesto

- **Estado:** propuesta
- **Fecha:** 2026-10-25
- **Precisa / reemplaza a:** precisa [D18](D018-creacion-y-publicacion-de-agentes.md) (nadie **usa** una versión antes de aprobarse; quien la edita la **prueba**), [D32](D032-harness-por-agente.md) (un harness más, que no es de un agente), [D33](D033-autorizacion-de-agentes-y-tools.md) (la firma de una prueba lleva una marca propia y el interceptor no deja pasar ninguna escritura con ella), [D40](D040-provisioner-de-agentes.md) (1) (el Playground no sirve desde el puntero `PUBLISHED#`), [D41](D041-alertas-y-reconciliacion.md) (el conciliador diario espera el harness de pruebas) y [D70](D070-dos-tareas-y-limites-compartidos.md) (un límite de tasa nuevo, contado entre las tareas)
- **Precisada por:** —

## Decisión

Origen: la vista «Playground» del menú Construir (D24, `playground.jsx`) estaba en «Próximamente». Compara la versión publicada de un agente con un borrador que se edita (prompt, modelo y temperatura), con preguntas sugeridas y una prueba de inyección, avisa de posibles secretos y guarda en borrador o envía a aprobación. Probar un borrador exige ejecutar una versión sin aprobar, y hasta ahora nadie lo hacía: `not_usable_before_approval` (403). La propuesta de la fase 1 comparó cuatro caminos (un harness efímero por borrador, uno de pruebas compartido, el modelo directo sin tools y no construir) y lo que hace Bedrock Agents (el alias de pruebas `TSTALIASID`, que apunta al borrador).

**(1) Un harness de pruebas compartido (respondido el 2026-10-25, por menú: «Harness compartido (Recomendada)»).** La instalación tiene un harness más, `Mango_<ns>_a_playground`, con su endpoint `live` y su rol `Mango-<ns>-agent-playground`, bajo el boundary de agentes. `mango-api` lo invoca con el prompt, el modelo, la temperatura, las tools, las knowledge bases y los límites de la versión probada, que `InvokeHarness` acepta en cada llamada sin cambiar el harness. Lo único que el harness fija es su rol, y el de un agente solo puede invocar modelos, aplicar el guardrail base, escribir sus logs y pedir su token de workload: todo acceso a sistemas sigue por el Gateway con el token de la persona (regla 3). Un harness por borrador no sirve para una pantalla: publicar tarda uno o dos minutos y retirar de 5 a 15. El modelo directo no prueba tools ni iteraciones.
- **Lo que precisa de D18.** Nadie **usa** una versión antes de aprobarse: no aparece en Marketplace ni en el chat, no la sirven las tareas (D78), y el 403 `not_usable_before_approval` sigue en esos caminos. Quien puede editarla la **prueba** en el Playground. La aprobación sigue mandando para todo lo demás.
- **Lo que precisa de D32.** Sigue habiendo un harness por agente. El de pruebas es otro, de la instalación, y no sirve a nadie más que a quien prueba.

**(2) Tools: lectura real, escritura simulada (respondido el 2026-10-25, por menú: «Lectura real, escritura simulada (Recomendada)»).** Las tools de lectura van por el Gateway con el token de quien prueba (regla 5): lo que esa persona no puede hacer en el chat tampoco lo hace aquí (Cedar L2, grupos centrales para datos de cuentas, knowledge bases de sus grupos). Las de escritura nunca se ejecutan: el turno se detiene en la llamada, que la pantalla muestra como «pediría aprobación», y `mango-api` no crea ninguna solicitud. Segunda barrera: la firma de la invocación lleva la marca `pg`, y el interceptor rechaza toda tool de escritura con esa marca, antes de mirar la aprobación.

**(3) Presupuesto de la persona y del agente (respondido el 2026-10-25, por menú: «Persona y agente (Recomendada)»).** Cada prueba reserva antes de invocar (regla 4), se liquida y se concilia como un turno de chat (D73), en los ámbitos de quien prueba y del agente. Un agente nuevo, nunca publicado, tiene el presupuesto por defecto (D22). Sin presupuesto, 402 sin invocar nada.

**(4) Prueba quien edita el agente (respondido el 2026-10-25, por menú: «Quien edita el agente (Recomendada)»).** Su creador con el rol de creador, o un administrador: `EditAgent` sobre el agente, en Verified Permissions, igual que guardar un borrador. Un revisor no prueba desde la Revisión.

**(5) El rol tiene los modelos habilitados, al día (respondido el 2026-10-25, por menú: «Los habilitados, al día (Recomendada)»).** La política del rol nombra los modelos habilitados del catálogo (ARNs concretos, como el de un agente). Cuando un administrador habilita o deshabilita un modelo en Brains, `mango-api` arranca el provisioner, que reescribe la política.

**(6) Lo crea el provisioner (respondido el 2026-10-25, por menú: «Provisioner (Recomendada)»).** La plantilla lo arranca al instalar y en cada actualización, como a los agentes de la release (D34, D80), por SDK (D25). Usa el mismo código de rol, boundary y harness. La desinstalación ya lo barre: borra todo lo que empieza por `Mango_<ns>_a_` (D58). El slug `playground` queda reservado y ningún agente lo tiene.

**(7) Un prompt con un posible secreto no se ejecuta (respondido el 2026-10-25, por menú: «No ejecutar y avisar (Recomendada)»).** La prueba responde 422 sin invocar nada: mandarlo al modelo pondría un secreto en el contexto del LLM, que `AGENTS.md` prohíbe. Es una diferencia con el diseño, que deja seguir probando con el aviso. Va en el brief para Claude Design (D24: la seguridad gana y la diferencia se reporta).

**(8) Preguntas sugeridas genéricas y la prueba de seguridad (respondido el 2026-10-25, por menú: «Genéricas + seguridad (Recomendada)»).** Las del diseño son ejemplos con nombres inventados. El producto da textos fijos sin datos (como «Explica qué puedes hacer y con qué herramientas») y la «Prueba de seguridad». Los textos de «Disponible hoy» los dibuja Claude Design.

**(9) Límites de la versión y de tasa (respondido el 2026-10-25, por menú: «Los del agente + tasa (Recomendada)»).** Cada prueba lleva los tokens, las iteraciones, el tiempo y el tope por llamada de la versión (D74), sin cambiarlos. Por persona, como mucho 2 pruebas a la vez y 60 por hora, contadas una vez entre las tareas de `mango-api` en `RateLimits` (D70). «Ejecutar todas» se encola de dos en dos en la pantalla.

**(10) Solo auditoría; votos locales; casos «Próximamente» (respondidos el 2026-10-25, por menú: «No; solo auditoría (Recomendada)» y «Votos locales; caso Próximamente (Recomendada)»).**
- Un evento `playground.run` por prueba: agente, versión, `content_hash` de lo probado, modelo, tools usadas, tokens, costo y resultado. Nunca el prompt, la pregunta ni la respuesta. Las llamadas a tools de una prueba no van a la Actividad (D90), que sigue siendo de agentes publicados.
- Los votos 👍/👎 viven en la pantalla mientras está abierta, sin servidor.
- «Guardar como caso» queda «Próximamente» hasta que existan evals (D26, D38).

**(11) Cómo (propuesto por un agente).**
- **Lo que se prueba lo arma el servidor.** El cliente nombra el agente, la versión (el borrador con su `revision`, o la publicada para «Con publicado»), la pregunta (hasta 4.000 caracteres) y solo tres cambios sin guardar: prompt, modelo y temperatura (0 a 1). Tools, knowledge bases y límites salen de la versión guardada. El modelo tiene que estar habilitado en el catálogo, y admitir tools si la versión las tiene; las tools cuyo pack no está instalado no se ofrecen al modelo.
- **Una ruta nueva:** `POST /api/playground/runs`, por SSE, como el chat. Guardar, enviar, el diff del prompt, los borradores propios y los modelos ya tenían ruta.
- **Una sesión de runtime nueva por prueba,** sin historial, con un id que calcula `mango-api` y nunca viene del cliente (D39). La prueba no se guarda como conversación: la respuesta solo va a quien la pidió.
- **La firma de una prueba** nombra a la persona, el agente, la versión probada, sus tools y knowledge bases, y la marca `pg`.
- **El conciliador diario** (D41) espera el harness y el rol de pruebas y no los marca huérfanos; sí avisa si faltan.
- **Si el harness de pruebas no existe** o falla, la prueba responde 503 y no cobra nada (D75 (10)); la alarma del provisioner avisa de una creación fallida.
