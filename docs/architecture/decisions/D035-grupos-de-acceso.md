# D35 · Grupos de acceso y regla de datos de cuentas

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Los grupos de acceso son grupos de Cognito (`cognito:groups`) más un registro en `Settings` con su tipo (central, de área o general, [D26](D026-reglas-del-ciclo-de-vida.md)), sembrado por IaC. Un usuario puede tener grupos sin rol FinOps; sin grupo sigue sin acceso. El grupo de creadores es `mango-agent-creator`. La pantalla Ajustes › Grupos llega en la fase C.

**La regla «Datos de cuentas solo para grupos centrales» se decide por modo de identidad y por tool:** un conector que filtra por usuario (`per_user`, como Cost Explorer) se permite a grupos de área; las tools de toda la organización, solo a centrales. El diseño se corrige primero en Claude Design ([D24](D024-diseno-de-la-ui.md))
