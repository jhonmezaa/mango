# Contexto para Claude Design: el Playground en el producto (2026-10-25)

El Playground (`playground.jsx`, menú Construir) está en «Próximamente»: no está en `AVAILABLE` de `store.js`. El producto ya puede construir su servidor (D91, `propuesta`) y la pantalla espera a que dibujes su modo «Disponible hoy». Esto es contexto, no una especificación: decide tú cómo se ve y actualiza `HANDOFF.md` con lo que corresponda. Lo que no tiene backend no se muestra con datos de ejemplo (D24).

## 1. Cómo funciona en el producto

- **Quién la ve:** quien puede editar agentes: su creador con el rol de creador (`mango-agent-creator`) o un administrador. Es lo de `OWNER_VIEWS`. Cada persona prueba solo los agentes que puede editar.
- **Qué se prueba:** un borrador propio (nuevo o un cambio de un agente publicado; también uno rechazado) o un agente publicado que esa persona edita.
- **Qué se puede cambiar aquí sin guardar:** el system prompt, el modelo y la temperatura (0 a 1, solo para la sesión). Tools, knowledge bases, límites y acceso se cambian en el Agent Builder, como dice el diseño.
- **Cada prueba es una pregunta sola,** sin historial, igual que en el diseño. La respuesta llega en vivo, como en el chat, y solo la ve quien la pidió. No se guarda: al salir de la pantalla se pierde.
- **Las tools de lectura se ejecutan de verdad,** con la identidad de quien prueba. Lo que esa persona no puede consultar en el chat tampoco lo consulta aquí.
- **Las de escritura nunca se ejecutan.** Cuando el agente pide una, la prueba se detiene ahí y el producto devuelve qué tool pidió. Es lo que el diseño llama «pediría aprobación» y «1 simulada»; no se crea ninguna solicitud en Aprobaciones.
- **Cuesta dinero y cuenta en los presupuestos:** cada prueba se cobra al presupuesto mensual de quien prueba y al del agente, como un turno de chat. Sin presupuesto, la prueba no corre (402, el mismo caso del chat).
- **Límite por persona:** 2 pruebas a la vez y 60 por hora. «Ejecutar todas» manda hasta 4 preguntas (8 con una comparación) y el producto las encola de dos en dos. Pasado el límite, 429 con el tiempo de espera.
- **Guardar y enviar** usan lo que ya existe en el Agent Builder: «Guardar como borrador» desde un publicado crea la versión nueva; «Enviar a aprobación» valida en el servidor y devuelve los mismos errores que el Builder.

## 2. Lo que el producto da para cada parte de la pantalla

| Parte del diseño | Qué da el producto |
|---|---|
| «Qué probar» | Tus borradores (abiertos y rechazados, con el motivo) y los publicados que editas |
| Modelo | Los habilitados en Brains. Con tools, solo los que admiten tools |
| System prompt y «≈ N tokens» | Sí. El diff contra lo publicado lo calcula el servidor (el mismo de Revisión) |
| Tools | La lista de la versión, con «Escritura» y «No disponible» (pack no instalado: el agente responde sin ella) |
| Límites | Tokens, iteraciones y tiempo de la versión, de solo lectura |
| Comparar «Con publicado» y «Otro modelo» | Sí: dos pruebas, una por columna |
| Tarjeta de respuesta | El texto, las tools que usó con sus milisegundos y si salieron bien, la escritura que pidió, el tiempo, los tokens de entrada y salida y el costo en USD |
| Insignias | «Guardrail» (el guardrail base bloqueó la entrada o la salida), «Supera tokens» (la respuesta se cortó en su tope), «Tope de iteraciones» y «Supera tiempo» (el agente llegó a su límite) |
| «Antes de enviar» | Los errores de validación del servidor (`violations`) |
| 👍 / 👎 y su recuento | Solo en la pantalla mientras está abierta: el producto no los guarda |

## 3. Lo que el diseño muestra y el producto no puede dar, o da distinto

- **Un posible secreto en el prompt bloquea la prueba, no solo el envío.** Mandar ese prompt al modelo pondría un secreto en el contexto del LLM, y eso está prohibido. El producto responde 422 sin ejecutar nada. Hoy el diseño dice «Posible secreto en el prompt. No se podrá enviar a aprobación.» y deja ejecutar. Hace falta que el aviso diga que tampoco se puede probar y que «Ejecutar», «Ejecutar todas» y las preguntas sugeridas queden deshabilitados mientras siga.
- **Preguntas sugeridas:** las de `PG_SAMPLES` son ejemplos con nombres inventados («cluster ECS checkout», «deploy 341 de prod-web»). El producto no tiene preguntas por agente. Puede dar textos fijos sin datos, iguales para cualquier agente o por categoría, como «Explica qué puedes hacer y con qué herramientas», más la «Prueba de seguridad». Hacen falta esos textos para «Disponible hoy».
- **«Guardar como caso»:** no hay evals. Es «Próximamente».
- **Costos › fuente «Playground»** y **Evals › «Desde Playground»**: esas pantallas siguen en «Próximamente».
- **El texto «Nada de lo que pruebes aquí llega a los usuarios.»** es cierto, y el producto añade que las pruebas cuestan: van a los presupuestos de quien prueba y del agente. Quizá convenga decirlo cerca de «Ejecutar».
- **Las respuestas simuladas del prototipo** (`pgRespond`) no existen: el producto da la respuesta real del modelo.

## 4. Estados que el producto tiene y el diseño no dibuja

- **Sin presupuesto** (402): la prueba no corre. ¿Se dice en la tarjeta o en un aviso arriba? ¿Cuál se agotó, el tuyo o el del agente?
- **Límite de pruebas** (429, con segundos de espera).
- **El Playground no está disponible** (503: la instalación no tiene su harness de pruebas, o falló). Es un estado de la pantalla entera.
- **Una prueba que falla** a mitad (el agente falló): la tarjeta con error, como el chat.
- **El borrador cambió** mientras probabas (otra pestaña lo guardó): «Guardar» responde 409 y hay que recargar, como en el Builder.
- **Un modelo que ya no está habilitado** en un borrador: el selector no lo ofrece y la validación lo dice.
- **Carga** de la lista de agentes y de la versión elegida, y **error** al cargarlas.
- **Sin nada que probar:** ni borradores ni agentes publicados que puedas editar.

## 5. Qué decide el producto, por si sirve

D91 en `docs/architecture/decisions/D091-playground.md`. Es una propuesta: si el dibujo pide otra cosa, se habla antes de construir.
