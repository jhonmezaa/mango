# Contexto para Claude Design: la vista Skills en el producto (2026-10-25)

«Skills» (`skills.jsx`, menú Construir) está en «Próximamente»: no está en `AVAILABLE` de `store.js`. El producto ya tiene su backend (D92, `propuesta`): skills de solo instrucciones, cada versión aprobada por otro administrador y fijada por la versión de cada agente. Esto es contexto para dibujar su modo «Disponible hoy», no una especificación: actualiza el diseño y `HANDOFF.md` con lo que corresponda. Lo que no tiene backend no se muestra con datos de ejemplo (D24).

## 1. Lo que el producto puede dar hoy

- **Catálogo:** por skill, nombre, categoría, descripción, versión aprobada, MCP requeridos (con su nombre del catálogo, si están habilitados, su nivel de datos y si tienen tools de escritura), nivel de datos resultante, «+ escritura», disponibilidad, agentes publicados que la usan, cuántos van en una versión anterior, ejecuciones de los últimos 30 días, dueño (quien propuso la v1), y quién y cuándo aprobó la última versión. Filtros y buscador como en el diseño: todo eso viene en la respuesta.
- **Ejecuciones · 30 d:** son las veces que un agente cargó la skill (la tool interna `skills` del harness), contadas por día. «Sin datos» cuando es 0, como en el diseño.
- **Detalle:** instrucciones con sus `{{variables}}`, entrega, MCP requeridos, agentes que la usan con la versión que tiene cada uno, y el historial de versiones (quién propuso y quién aprobó cada una).
- **Nueva skill, Nueva versión y Duplicar como instrucciones:** como en el diseño. El id sale del nombre con la regla del diseño (`idOf`). Validaciones en el servidor: nombre hasta 48, descripción hasta 140, instrucciones hasta 20.000 caracteres, hasta 10 entregas y 10 MCP; categorías las 6 del editor; al menos un MCP y todos habilitados; posibles secretos; motivo obligatorio; una versión en aprobación por skill.
- **Aprobación:** la aprueba o rechaza (con motivo) un administrador distinto de quien la propuso; quien la propuso solo la retira; vence a las 72 h. Mientras tanto, los agentes siguen con la versión anterior. Es el patrón de cambios con doble aprobación del diseño (`ChangeList`).
- **Quién:** ven la vista y proponen los administradores y los **creadores de agentes** (`mango-agent-creator`). Aprueba solo un administrador.

## 2. Lo que el diseño muestra y el producto no puede dar

- **«Incluida con Mango» y la sección «Scripts»:** el producto no tiene skills con scripts (D92 (2): sin `shell` en los agentes). La release no trae skills, así que no aparecen. El texto de la cabecera («las que incluyen scripts vienen instaladas con Mango y no se editan») habla de algo que hoy no existe.
- **Quién ve la vista:** el diseño la pone en `OWNER_VIEWS` (admin y «owner», creador y central a la vez); un creador sin `finops-central` no la ve. El producto la da a todo creador de agentes, como Knowledge Bases (D92 (3)). Hace falta que el diseño lo refleje.
- **El chat:** el popover «Skills y tools» del topbar y el botón «Skill» del compositor siguen «Próximamente». El botón «Skill» no tiene comportamiento definido en el diseño: ¿qué debe hacer?

## 3. Lo que falta dibujar

- **El Agent Builder no tiene dónde elegir skills.** El producto ya acepta en cada versión hasta 10 skills, cada una en una versión aprobada concreta (`skill@vN`); una versión nueva de la skill llega al agente con su siguiente aprobación. Hace falta una sección (o un bloque en Tools) para elegirlas, ver su versión y pasar a la última, y su línea en el diff de versiones y en la revisión.
- **Los errores al enviar un agente con skills** (para `AB_SERVER_ERR` y la revisión): una skill que ya no está aprobada en esa versión; una skill cuyo MCP no está habilitado; una skill que requiere un MCP del que el agente no tiene ninguna tool. El producto lleva hoy textos provisionales para los tres.
- **La tarjeta de aprobación de una versión:** quien aprueba tiene que leer el texto completo; el producto lo manda. Un diff contra la versión anterior ayudaría (lo que cambió en las instrucciones).
- **Estados de la vista:** carga, error y sin acceso (403), como Gobernanza y Actividad.
- **Límites:** 200 skills por instalación y 20 propuestas abiertas a la vez (el servidor responde un error con código; hace falta su texto).
