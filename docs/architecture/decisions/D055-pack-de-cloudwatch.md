# D55 · Pack de CloudWatch sobre cuentas miembro

- **Estado:** vigente
- **Fecha:** 2026-10-02
- **Precisa / reemplaza a:** precisa [D49](D049-identidad-en-packs-de-datos.md) (5) y [D51](D051-acceso-a-cuentas-miembro.md) (3, 7); en el texto: mantiene [D50](D050-per-user-adapter-en-v1.md) (punto 6)
- **Precisada por:** —
- **Tema en el registro original:** Pack de CloudWatch sobre cuentas miembro (precisa [D49](D049-identidad-en-packs-de-datos.md) (5) y [D51](D051-acceso-a-cuentas-miembro.md) (3, 7))

## Decisión

**(1) `identity.chain: payer | member`** en el manifiesto firmado; con `member`, cada llamada asume `Mango-<ns>-ReadBroker` con `SourceIdentity` = usuario y luego `Mango-<ns>-ReadOnly` en la cuenta pedida.

**(2) Cuenta:** el argumento `account_id` (de Mango, no de upstream) se valida por formato (12 dígitos, nunca la cuenta Mango) y el resto lo decide IAM en la misma llamada; cualquier fallo da el mismo mensaje fijo (usuario, 2026-10-02).

**(3) Qué lee:** métricas, alarmas y metadatos de log groups (`cloudwatch:GetMetricData`, `DescribeAlarms`, `DescribeAlarmHistory`, `logs:DescribeLogGroups`, `logs:DescribeQueryDefinitions`); sin Logs Insights ni eventos de log (usuario, 2026-10-02).

**(4) cdk-nag:** reconocimientos granulares de `AwsSolutions-IAM5` en `Mango-<ns>-ReadOnly` para las APIs sin recurso y para las alarmas acotadas por ARN de cuenta (usuario, 2026-10-02).

**(5) Zip comprimido solo para este pack** (304 MB sin comprimir, límite del Runtime 250 MB); reproducible con las zlib de macOS y CI, y el job de firma compara byte a byte (usuario, 2026-10-02). Dependencias fijadas a wheels `manylinux2014` arm64.

**(6) `central_only`** como Billing; `per_user_adapter` sigue apagado ([D50](D050-per-user-adapter-en-v1.md)).

Verificado en el laboratorio: el central lee Audit y Log Archive, la cuenta Mango y la de gestión se rechazan, el líder de área queda negado, y CloudTrail de cada cuenta miembro registra al usuario
