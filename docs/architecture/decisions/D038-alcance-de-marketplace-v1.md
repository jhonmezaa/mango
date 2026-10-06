# D38 · Alcance de Marketplace v1 por fase

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** en el texto: sigue [D22](D022-marketplace-compartir-retirar.md) para «Compartir» y deja fuera de las fases A a C las evals obligatorias y las skills de [D26](D026-reglas-del-ciclo-de-vida.md)
- **Precisada por:** [D65](D065-org-chart-quien-usa-un-agente.md) (precisa)

## Decisión

**Compartir** sigue [D22](D022-marketplace-compartir-retirar.md): crea una versión con solo el acceso cambiado; en la fase A el modal «Compartir» queda Próximamente y los grupos se editan en el Builder.

**Brains:** catálogo de modelos de solo lectura en la fase A y pantalla completa en la fase B.

**Evals obligatorias y skills ([D26](D026-reglas-del-ciclo-de-vida.md))** quedan fuera de las fases A a C; la revisión no muestra el bloque de evals hasta que exista.

**Org Chart:** admins y creadores ven el árbol completo; el resto, solo los agentes que puede usar.

**Cliente TypeScript:** se genera desde el OpenAPI de `mango-api` a partir de la fase A. Plan: `docs/specs/marketplace-v1-plan.md`
