# D107 · Costos: «Por equipo», «Asignado a equipos» y «Oportunidades de ahorro» quedan «Próximamente»

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** — (aplica [D24](D024-diseno-de-la-ui.md): lo que no tiene backend se muestra como «Próximamente», sin datos de ejemplo)
- **Precisada por:** —

## Decisión

Origen: tres partes de la vista Costos del diseño (`costs2.jsx`, D105) no tienen fuente en el producto:

- **«Por equipo»** (pestaña del desglose) y **«Asignado a equipos»** (la línea del gráfico y «supera lo asignado a equipos» en la proyección): no hay equipos ni presupuestos de equipo (D17, D89 (7), D102 (5)).
- **«Oportunidades de ahorro»**: una heurística con un modelo fijo y un umbral de 500 que sugiere cambiar de modelo. Es una recomendación de producto que nadie ha decidido.

**(1) Los tres, «Próximamente», sin datos de ejemplo** (elegido por el dueño el 2026-11-05, por menú). La pestaña «Por equipo» y el panel de ahorro se ven como «Próximamente»; la línea «Asignado a equipos» y la frase de la proyección que la usa no se dibujan.

**(2) Opciones descartadas.** (b) Cambiar «Por equipo» por «Por área», con los contadores `DAY#AREA#` de D102: el dato existe, pero no hay presupuestos de área (D102 (5)) y es otra pantalla que tendría que dibujar Claude Design. (c) Calcular el ahorro con los precios del catálogo frente al modelo más barato habilitado que soporte tools: sin modelos en el código (regla 7), pero es una recomendación nueva que pide su propia decisión.

Retomar cualquiera de las tres es una decisión nueva.
