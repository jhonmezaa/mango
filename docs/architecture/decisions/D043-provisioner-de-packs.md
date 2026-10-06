# D43 · Provisioner de packs: qué se instala, quién lo registra y qué packs entran

- **Estado:** parcial. Rigen (1) y (2). El punto (3) ya no rige como está: los packs de datos de cuentas se instalan desde [D49](D049-identidad-en-packs-de-datos.md), [D52](D052-pack-de-billing-ampliado.md), [D54](D054-egress-de-packs.md) y [D55](D055-pack-de-cloudwatch.md); los packs con tools de escritura siguen rechazados ([D56](D056-tools-de-escritura-con-aprobacion.md) (5)).
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D46](D046-api-del-catalogo-de-mcp.md) (amplía, punto 3); [D49](D049-identidad-en-packs-de-datos.md) (precisa, punto 2); [D52](D052-pack-de-billing-ampliado.md) (precisa); [D56](D056-tools-de-escritura-con-aprobacion.md) (precisa el punto 3)

## Decisión

**(1) Catálogo de la release por digest.** Qué pack se puede instalar lo fija la plantilla: la llave pública de firma y, por pack, la versión y el sha256 de **una** declaración firmada. El provisioner de packs exige que la entrada, la habilitación, el manifiesto firmado y ese catálogo coincidan, así que un pack antiguo con firma válida no se instala (sin rollback). Sin llave pública el catálogo queda vacío y no se instala nada. El zip se verifica en una versión concreta del objeto de S3 y el Runtime se crea con ese mismo `versionId`.

**(2) Puntero de instalación y segundo escritor de `Settings`.** Qué está instalado lo dice el ítem `MCP_INSTALLED#<pack>` de la tabla `Settings`, que solo escribe el provisioner de packs (`mango-api` tiene un `Deny` explícito); la compensación y las actualizaciones deciden a partir de él. El provisioner de packs escribe además el estado de la habilitación (`MCP#<pack>` / `ENABLEMENT`: estado, fallo y su bloqueo), como prevé el spec §8. **Esto ajusta la mitigación de TM-A6 (Admin v0), que decía que solo el rol de `mango-api` escribe en `Settings`:** el usuario aceptó el 2026-10-01 que el provisioner de packs escriba en la tabla, acotado por IAM a las particiones `MCP#*` (`UpdateItem` sobre una lista cerrada de atributos, nunca `config` ni `approved_by`) y `MCP_INSTALLED#*` (`PutItem` y `DeleteItem`). No alcanza el mapeo área↔OU, los grupos, los modelos ni los presupuestos (comprobado en el laboratorio con la política sintetizada). El provisioner de packs tiene rol y Lambda propios, separados del provisioner de agentes.

**(3) Solo packs `public` con tools de lectura por ahora.** El provisioner rechaza (`data_tier_unsupported`) los packs de datos de cuentas, que necesitan la identidad por llamada ([D37](D037-packs-de-datos-de-cuentas.md), fase C) y la allowlist de egress (R6), y los que tienen tools de escritura, que necesitan la aprobación por llamada ([D27](D027-confirmacion-de-escritura-por-tramos.md)). Las acciones IAM de un pack deben estar en la lista cerrada del permissions boundary de packs (`Mango-<ns>-mcp-boundary`); un manifiesto firmado que pida otra se rechaza.

Modelo de amenazas: `docs/security/threat-models/mcp-pack-provisioner-threat-model.md`
