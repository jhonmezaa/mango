# D11 · Requisitos de seguridad

- **Estado:** parcial. Construidos R3 ([D56](D056-tools-de-escritura-con-aprobacion.md)), la firma de R5 ([D36](D036-artefacto-y-firma-de-packs.md), [D58](D058-distribucion-para-clientes.md) (4)) y R6 para los Runtimes de packs ([D54](D054-egress-de-packs.md)). Faltan R2 (taint), R7 (guardrails de recurso), R8 (plantilla de SCP) y R6 para conectores; R4 espera a que haya memoria (hoy desactivada, [D13](D013-identidad-hasta-las-tools.md)).
- **Fecha:** 2026-09-28
- **Precisa / reemplaza a:** —
- **Precisada por:** [D54](D054-egress-de-packs.md) (construye R6 para packs); [D56](D056-tools-de-escritura-con-aprobacion.md) (construye R3)

## Decisión

Requisitos R2–R8 del modelo de amenazas v0.1 como obligatorios de diseño: taint/egress con HITL, UI de aprobación canónica, Memory por usuario, firma de releases, egress en allowlist, guardrails de recurso, plantilla de SCPs (§4.13)
