# D25 · Recursos creados en runtime

- **Estado:** vigente
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** flexibiliza P3 y la regla 1 de `AGENTS.md`; mantiene [D9](D009-versionado-y-upgrades.md) y §4.12
- **Precisada por:** [D58](D058-distribucion-para-clientes.md) (precisa)
- **Tema en el registro original:** Recursos creados en runtime (flexibiliza P3 y la regla 1)

## Decisión

**Sin CodeBuild ni `cdk deploy` en la cuenta del cliente** (se mantiene [D9](D009-versionado-y-upgrades.md) y §4.12). Por defecto, el provisioner crea recursos por API/SDK. Para recursos compuestos que conviene gestionar como unidad (p. ej. knowledge bases, APIs publicadas), **puede crear stacks de CloudFormation solo desde plantillas pre-sintetizadas que vienen en la release**, con un rol de ejecución de CloudFormation acotado por permissions boundary y parámetros validados (nunca plantillas ni IAM armados con datos del usuario). Se revisa cuando se implemente el primer caso (KB o API publicada), frente a la alternativa de replicar bedrock-chat (CodeBuild + `cdk deploy`)
