# Contexto para Claude Design: Inicio en el producto (2026-10-29)

Inicio (`dashboard.jsx`, `function Dashboard`, y `charts.jsx`) deja de ser «Próximamente» en el producto para administradores y `finops-central` (D102). Este brief cuenta lo que el producto puede dar, lo que el diseño no dibuja y lo que se construyó a la espera del diseño. Es contexto, no una especificación de pantalla: actualiza el diseño y `HANDOFF.md` con lo que corresponda. Lo que no tenga backend se muestra como «Próximamente», sin datos de ejemplo (D24).

`dashboard` no está en `AVAILABLE` (`store.js`): el diseño no tiene modo «disponibilidad actual» para Inicio, ni estados de carga o de error, ni variantes por rol.

## 1. Lo que el producto da tal como lo dibuja el diseño

- **Saludo** con el nombre de la persona (o su correo si no tiene nombre) y el subtítulo.
- **«Responder N aprobaciones»:** lo que espera la firma de quien mira (ni lo que pidió ni lo que ya firmó), más las propuestas de bucket de knowledge bases que puede decidir.
- **Filtros:** periodo (7 días, 30 días, 3 meses, 6 meses; se recuerda), diario o semanal, y comparar con el periodo anterior.
- **«Gasto en Bedrock»** e **«Invocaciones»:** un valor por día del periodo y del anterior, con el total, el cambio y el gráfico con su tooltip. Invocaciones son turnos que llegaron al agente: chat, tareas y Playground. El gasto incluye además el título de las conversaciones nuevas.
- **«Presupuestos cerca del límite»** para administradores: los cuatro agentes más cerca de su límite, con «USD x de USD y» y el porcentaje.
- **«Exportar»** descarga el CSV de la tarjeta (día, valor, día del periodo anterior y su valor) y muestra «Exportado a CSV».

## 2. Lo que no tiene fuente: «Próximamente»

- **«Estado de agentes»** (heartbeat): el producto no tiene salud de los agentes (D89 (7)).
- **«Tickets resueltos»:** no hay tickets.
- **«Latencia p95»:** no se mide el tiempo hasta el primer token.
- Se dibujan con su marco, «—» en lugar de números y sin línea en el gráfico, dentro del «Próximamente» de bloque. Si el diseño prefiere otra forma (por ejemplo, ocultarlas), hace falta dibujarla.
- **«Ver detalles»** de Gasto e Invocaciones lleva a Costos y Observabilidad, que son «Próximamente»: el enlace se muestra así.

## 3. Lo que no dibuja el diseño: hace falta dibujarlo

- **Variante de un `bu-lead`:** el servidor ya le da **su área** (el gasto y los turnos de las personas de su área, contados en el área que tenían al hacer cada turno). Hace falta el subtítulo («Así va tu área…»), el texto de información de Invocaciones (no son «todos los agentes») y la tarjeta de presupuestos: no hay presupuestos de área ni de equipo, solo el suyo personal. Hasta entonces, para un `bu-lead` Inicio sigue «Próximamente».
- **Variante de una persona sin esos roles:** el servidor ya le da **lo suyo** (su gasto y sus turnos) y su presupuesto. Hace falta su subtítulo, el texto de Invocaciones («tus mensajes»), la tarjeta de presupuestos con una sola fila y qué hacer con «Ver presupuestos» (no tiene esa pantalla). Hasta entonces, Inicio sigue «Próximamente» para ella.
- **`finops-central` sin administrador:** ve la organización, pero no los presupuestos de agentes (son de administradores, D17 y D89 (1)). Hoy la tarjeta muestra solo su presupuesto personal y no lleva «Ver presupuestos». Hace falta dibujarlo.
- **Desde cuándo hay datos:** el contador por día empieza el día que se instala; antes, el producto da cero. La respuesta trae el primer día con datos (`counted_since`). Hace falta un estado «Cuenta desde el {fecha}» (en la tarjeta o en el tooltip) para que un cero antes de esa fecha no se lea como «no hubo gasto». Hoy no se muestra texto nuevo.
- **Carga y error:** el producto muestra tarjetas esqueleto mientras carga y, si falla, «No se pudo cargar Inicio» · «Inténtalo de nuevo en unos segundos.» con «Reintentar» (la tarjeta de error de Gobernanza). Hace falta dibujarlos.
- **«Actualizado …»:** el diseño pone textos fijos («Actualizado hace 4 s», «Actualizado 12:00»). El producto dice cuándo se leyó la respuesta («Actualizado hace 0 segundos», «hace 2 minutos»). Si el diseño quiere otro formato, hace falta decirlo.
- **Quitar «Comparar»:** en el diseño, la X para quitar la comparación es un `span role="button"` dentro del botón de la píldora (un control dentro de otro). En el producto es un botón propio, «Quitar Comparar», sobre la píldora. Se ve igual.

## 4. Lo que el diseño puede dejar fuera

- **«Primeros pasos»** (`SetupGuide` sobre Inicio fuera del modo disponible): no se construye; el producto no tiene esa guía.
