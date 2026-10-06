# D51 · Acceso a cuentas miembro

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** precisa §4.10
- **Precisada por:** [D55](D055-pack-de-cloudwatch.md) (precisa los puntos 3 y 7)
- **Tema en el registro original:** Acceso a cuentas miembro (C4, precisa §4.10)

## Decisión

**(1) Plantilla del spoke embebida:** `Mango-<ns>-OrgAccess` es solo un StackSet `SERVICE_MANAGED` con auto-deployment (`RetainStacksOnAccountRemoval: false`) cuya plantilla `Mango-<ns>-Member` va en `TemplateBody`, con su `sha256` como output; sin bucket, sin bootstrap en la cuenta de administración. Instalar es `CreateStack`/`UpdateStack` (`deployment/deploy-org-access.sh`), sin CodeBuild.

**(2) Objetivos por configuración** (`orgAccess.targets`: la raíz o hasta 50 OUs, y `excludedAccountIds`). **La cuenta Mango se excluye** aunque esté en una OU objetivo, para que ningún agente lea datos operativos de la propia Mango (usuario, 2026-10-01).

**(3) `Mango-<ns>-ReadOnly` sin acciones de datos** hasta el primer pack que las use (CloudWatch); su trust: raíz de la cuenta Mango con `aws:PrincipalArn` = `Mango-<ns>-ReadBroker`, `aws:PrincipalOrgID`, `SourceIdentity` obligatorio y tags `mango_user`/`mango_agent`/`mango_bu`.

**(4) `Mango-<ns>-ReadBroker` en Core:** sin permisos de datos; `sts:AssumeRole` sobre `arn:aws:iam::*:role/Mango-<ns>-ReadOnly` con `aws:ResourceOrgID` = la organización. La cuenta es comodín porque las cuentas entran y salen de las OUs sin redesplegar Core: **reconocimiento de cdk-nag `AwsSolutions-IAM5` acordado con el usuario el 2026-10-01**, granular y con motivo junto al código. Hoy solo el AdminProbe puede asumir el broker.

**(5) `Operator`/`OperateBroker` fuera** hasta que exista el approval executor.

**(6) Laboratorio:** acceso de confianza de StackSets activado en Organizations (2026-10-01); el rol llega a Audit y Log Archive (OUs Security y Sandbox, sin la cuenta Mango); `tests/e2e/member_access.py` pasa 12/12, incluido `aws:ResourceOrgID` en el `AssumeRole` entre cuentas y `SourceIdentity` en CloudTrail de cada cuenta miembro.

**(7) Campo de manifiesto para packs sobre cuentas miembro** ([D49](D049-identidad-en-packs-de-datos.md) (5)): `identity.chain: payer | member`, descrito en el modelo de amenazas y sin construir.

Modelo de amenazas: `docs/security/threat-models/member-access-threat-model.md`
