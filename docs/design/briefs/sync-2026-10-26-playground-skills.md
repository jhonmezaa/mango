# Contexto para Claude Design: lo que dejó la ronda 21 en el Playground y el chat (2026-10-26)

La ronda 21 trajo el Playground y Skills en «Disponible hoy», la sección de skills del Agent Builder y la barra colapsada. El producto ya construyó las tres pantallas y están instaladas. Este brief cuenta los textos que el producto tuvo que poner por su cuenta y el botón del chat que sigue sin comportamiento. Es contexto, no una especificación de pantalla: actualiza el diseño y HANDOFF.md con lo que corresponda. Lo que no tenga backend se sigue mostrando como «Próximamente», sin datos de ejemplo (D24).

Las decisiones están en D91 (Playground) y D92 (Skills) de la arquitectura de referencia.

## 1. Playground: textos que el diseño no tiene

El servidor responde estos casos y el producto lleva hoy un texto provisional para cada uno. Hace falta el texto definitivo y dónde va.

| Caso | Cuándo pasa | Texto provisional del producto |
|---|---|---|
| `model_without_tools` | El modelo elegido no admite tools y la versión tiene tools o knowledge bases | «Elige un modelo para probar» · «{modelo} no admite tools y este agente las usa.» |
| `version_not_testable` | La versión elegida no es un borrador ni la publicada (por ejemplo, una versión vieja) | «Esta versión no se puede probar» · «Solo se prueban los borradores y la versión publicada. Elige otra.» |
| `skill_unavailable` | Una skill fijada en la versión dejó de estar aprobada en esa versión. La prueba no corre | «Una skill de esta versión ya no está aprobada» · «Cámbiala en el Agent Builder para probar.» |
| `skills_unavailable` | No se pudieron leer las skills de la versión. La prueba corre igual, sin ellas | «No se pudieron cargar las skills de esta versión» · «Inténtalo de nuevo en unos segundos.» |
| `agent_retired` | El agente se retiró mientras estaba abierto en el Playground | «Este agente se retiró» · «Ya no se puede probar. Elige otro.» |
| Tool que falló | Una tool de la traza devolvió error | «{n,n} s · falló». El diseño solo tiene «bien», «pediría aprobación» y «pack no instalado». Mientras corre, el producto muestra «…» |

- **«pack no instalado» en la traza.** El producto no sabe, al fallar una tool, si fue porque su pack no está instalado. Por eso no usa ese texto ni la insignia «no disponible» en la traza; solo en el panel izquierdo, donde lo sabe por el catálogo.
- **El banner «Este borrador cambió en otra pestaña».** El diseño pone «Recargar» como acción del banner. El banner del producto no tiene ese hueco y lleva el botón dentro del cuerpo.
- **Móvil (900 px o menos).** Con la regla del diseño, el panel izquierdo queda en una caja de unos 174 px con su propio scroll. El producto desplaza toda la pantalla en su lugar.
- **La sesión que vence** se trata como en el chat: termina la sesión.

## 2. Chat: el botón «Skill»

El botón «Skill» del compositor y el popover «Skills y tools» del topbar siguen en «Próximamente». HANDOFF.md lo deja abierto («Falta decidir qué hace el botón "Skill"»). Lo que el producto puede y no puede hacer:

- **Qué skills tiene un agente** lo fija cada versión aprobada (hasta 10, cada una en su versión). El producto puede listar las de la versión que responde en el chat, con su nombre, descripción y versión.
- **Quién decide usarla** es el agente. Las carga por sí mismo cuando le sirven. Una persona no puede forzar que se cargue, ni añadir o quitar una skill desde el chat: eso es una versión nueva del agente que pasa por aprobación.
- **Lo que sí se puede mandar** es texto de la persona, como cualquier mensaje (por ejemplo, el nombre de una skill para sugerirla). El agente puede seguirlo o no.
- **Qué skill se usó en un turno** no se muestra en el chat ni en Actividad. El producto solo cuenta cuántas veces se cargó cada skill en 30 días, para «Ejecuciones · 30 d» de la vista Skills.
- Una skill son solo instrucciones: no ejecuta scripts ni tiene acceso a terminal ni a archivos.

Hace falta que el diseño decida qué hace el botón con esto, o que lo quite, y que dibuje el popover «Skills y tools» si se queda.
