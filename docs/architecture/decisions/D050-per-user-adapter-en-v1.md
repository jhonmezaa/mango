# D50 · `per_user_adapter` en v1 (C5)

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D55](D055-pack-de-cloudwatch.md) (lo mantiene apagado)

## Decisión

**No se habilita en ningún pack de v1.** El modo sigue en el esquema del manifiesto, pero el provisioner y el catálogo lo rechazan como hasta ahora. Motivos:

(1) los usuarios centrales ya leen datos de cuentas con `central_only` ([D49](D049-identidad-en-packs-de-datos.md)) y `SourceIdentity` = usuario en cada llamada;

(2) el pack que lo necesitaría para líderes de área, CloudWatch, depende de los roles de las cuentas miembro (C4, §4.10);

(3) exige reemplazar funciones internas de los servidores awslabs (`get_aws_client`, `create_pricing_client`), que no son API pública y pueden cambiar en cada versión.

El aislamiento de credenciales por llamada que pedía S-M1 ya está probado (C2), así que reabrirlo es una decisión de producto, no técnica.

**Se reevalúa** al construir el pack de CloudWatch sobre C4
