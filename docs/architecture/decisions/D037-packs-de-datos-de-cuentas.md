# D37 · Packs de datos de cuentas: identidad y primer pack

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D49](D049-identidad-en-packs-de-datos.md) (precisa); [D52](D052-pack-de-billing-ampliado.md) (precisa)

## Decisión

En modo `central_only`, el punto de entrada del pack asume el broker con **`SourceIdentity` = usuario en cada llamada**, aunque el servidor no filtre por área, para que CloudTrail muestre a la persona (regla 5).

**El primer pack de datos de cuentas es Billing**, con el broker de la payer que ya existe. CloudWatch espera a que existan los roles en las cuentas miembro (`OrgAccess`, `Member`, `ReadBroker`, §4.10)
