# D24 · Diseño de la UI

- **Estado:** vigente
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** —
- **Precisada por:** [D102](D102-inicio-gasto-por-dia-segun-el-rol.md) (10): en Inicio, lo que no tiene fuente no se muestra; [D103](D103-buscar-conversaciones-propias-en-mango-api.md) (7): en Buscar conversaciones, búsquedas recientes en memoria, la línea del tope, «Prueba con» oculto y los errores comunes (en estado propuesta)

## Decisión

**Claude Design es la fuente de verdad del UI**: se implementa tal cual, y cualquier cambio de diseño se hace primero allí. Presupuestos y Ajustes siguen `Mango.html`. Las vistas y acciones del diseño **sin backend se muestran deshabilitadas con "Próximamente"**, sin datos de ejemplo. Nada de datos realistas en el diseño ni en la app (placeholders neutros)
