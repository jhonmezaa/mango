# D34 · Guardrail y agentes de la release

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** en el texto de [D18](D018-creacion-y-publicacion-de-agentes.md) (ajuste del 2026-10-01): ajusta [D18](D018-creacion-y-publicacion-de-agentes.md) (guardrail base compartido en vez de uno por agente)
- **Precisada por:** [D42](D042-chat-con-varios-agentes.md) (precisa la siembra, punto 3); [D58](D058-distribucion-para-clientes.md) (precisa)

## Decisión

**Guardrail base compartido** por todos los agentes en Marketplace v1; el guardrail por agente queda para cuando el Builder tenga esa sección.

**Los agentes que vienen en la release (FinOps) están preaprobados:** se siembran como aprobados con `approved_by: release@<versión>` y un evento de auditoría, y el provisioner los publica. Cualquier cambio posterior hecho en la instalación sigue [D18](D018-creacion-y-publicacion-de-agentes.md)
