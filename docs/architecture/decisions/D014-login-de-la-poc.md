# D14 · Login de la PoC

- **Estado:** reemplazada por D20. El login lo reemplaza [D20](D020-login-y-registro.md); los usuarios creados por IaC y el MFA desactivado del laboratorio los retiran [D58](D058-distribucion-para-clientes.md) y [D60](D060-gestion-de-personas.md). Sigue en pie el mapeo de grupos de Cognito a claims en el pre-token.
- **Fecha:** 2026-09-28 · nota de laboratorio del 2026-09-29
- **Precisa / reemplaza a:** —
- **Precisada por:** [D20](D020-login-y-registro.md) (reemplaza el login); [D58](D058-distribucion-para-clientes.md) (retira su excepción de laboratorio); [D60](D060-gestion-de-personas.md) (precisa)
- **Tema en el registro original:** Login de la PoC (el login lo reemplaza [D20](D020-login-y-registro.md), 2026-09-30)

## Decisión

**Usuarios nativos de Cognito** creados por IaC desde la configuración local (sin SSO), grupos de Cognito mapeados a claims `mango_role`/`mango_business_unit` por un pre-token V2. El SSO con IAM Identity Center (app SAML creada en consola como prerrequisito del IdP) queda para después.

**Laboratorio (2026-09-29):** MFA desactivado a pedido del usuario (`mfa: off` en la config; las instalaciones de clientes usan `required`)
