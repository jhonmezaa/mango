# D20 · Login y registro

- **Estado:** vigente
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** reemplaza el login de [D14](D014-login-de-la-poc.md)
- **Precisada por:** [D28](D028-implementacion-del-login-propio.md) (implementa); [D29](D029-plan-de-cognito-en-clientes.md) (revisa); [D58](D058-distribucion-para-clientes.md) (retira sus excepciones de laboratorio); [D60](D060-gestion-de-personas.md) (precisa); [D63](D063-sesion-web-con-cookie.md) (revisa: cookie de sesión)
- **Tema en el registro original:** Login y registro (reemplaza el login de [D14](D014-login-de-la-poc.md))

## Decisión

**Login propio en la SPA, al estilo de bedrock-chat pero sin Amplify**, siguiendo el diseño de Claude Design: flujo **SRP** de Cognito (`USER_SRP_AUTH`; nunca `USER_PASSWORD_AUTH`).

**Auto-registro solo con correos de los dominios de la empresa** (parámetro de stack), validado en el servidor por una Lambda *pre sign-up*; verificación del correo con código antes del primer ingreso; `PreventUserExistenceErrors` activo. MFA (TOTP) y recuperación de contraseña con las APIs de Cognito. Un usuario recién registrado **no tiene rol**: no ve nada hasta que un admin lo asigna a un grupo (deny por defecto). El SSO con el IdP del cliente sigue siendo un redirect. Tokens solo en memoria y CSP estricta.

Modelo de amenazas: `docs/security/threat-models/login-threat-model.md`.

**Acordado tras el modelo:** Cognito **Plus** en clientes (parámetro de stack) y Essentials en el laboratorio; nunca vincular automáticamente SSO con cuentas locales por correo; suprimir el scope `aws.cognito.signin.user.admin` en el pre-token (sin autoservicio de cuenta); MFA solo "Obligatorio" en clientes.

**Restablecer el MFA de un usuario:** desde la app, lo propone un admin y lo aprueba otro distinto (acción Cedar propia); nadie restablece el suyo; al aplicarse, `AdminDeleteSoftwareToken` borra el TOTP registrado (corregido el 2026-09-30: `AdminSetUserMFAPreference` solo cambiaba la preferencia y Cognito seguía pidiendo el código viejo) y `AdminUserGlobalSignOut` cierra sus sesiones, y el siguiente ingreso cae en el alta de MFA; auditoría fail-closed; se notifica al usuario afectado, se verifica su identidad fuera de banda antes de proponerlo y se limita la frecuencia. Se entrega junto con el login propio. Un cambio de MFA no permitido se rechaza y se audita
