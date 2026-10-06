# D20 · Login y registro

- **Estado:** vigente
- **Fecha:** 2026-09-30 · punto del 2026-10-06
- **Precisa / reemplaza a:** reemplaza el login de [D14](D014-login-de-la-poc.md)
- **Precisada por:** [D28](D028-implementacion-del-login-propio.md) (implementa); [D29](D029-plan-de-cognito-en-clientes.md) (revisa); [D58](D058-distribucion-para-clientes.md) (retira sus excepciones de laboratorio); [D60](D060-gestion-de-personas.md) (precisa); [D63](D063-sesion-web-con-cookie.md) (revisa: cookie de sesión)
- **Tema en el registro original:** Login y registro (reemplaza el login de [D14](D014-login-de-la-poc.md))

## Decisión

**Login propio en la SPA, al estilo de bedrock-chat pero sin Amplify**, siguiendo el diseño de Claude Design: flujo **SRP** de Cognito (`USER_SRP_AUTH`; nunca `USER_PASSWORD_AUTH`).

**Auto-registro solo con correos de los dominios de la empresa** (parámetro de stack), validado en el servidor por una Lambda *pre sign-up*; verificación del correo con código antes del primer ingreso; `PreventUserExistenceErrors` activo. MFA (TOTP) y recuperación de contraseña con las APIs de Cognito. Un usuario recién registrado **no tiene rol**: no ve nada hasta que un admin lo asigna a un grupo (deny por defecto). El SSO con el IdP del cliente sigue siendo un redirect. Tokens solo en memoria y CSP estricta.

Modelo de amenazas: `docs/security/threat-models/login-threat-model.md`.

**Acordado tras el modelo:** Cognito **Plus** en clientes (parámetro de stack) y Essentials en el laboratorio; nunca vincular automáticamente SSO con cuentas locales por correo; suprimir el scope `aws.cognito.signin.user.admin` en el pre-token (sin autoservicio de cuenta); MFA solo "Obligatorio" en clientes.

**Restablecer el MFA de un usuario:** desde la app, lo propone un admin y lo aprueba otro distinto (acción Cedar propia); nadie restablece el suyo; al aplicarse, `AdminDeleteSoftwareToken` borra el TOTP registrado (corregido el 2026-09-30: `AdminSetUserMFAPreference` solo cambiaba la preferencia y Cognito seguía pidiendo el código viejo) y `AdminUserGlobalSignOut` cierra sus sesiones, y el siguiente ingreso cae en el alta de MFA; auditoría fail-closed; se notifica al usuario afectado, se verifica su identidad fuera de banda antes de proponerlo y se limita la frecuencia. Se entrega junto con el login propio. Un cambio de MFA no permitido se rechaza y se audita

**Punto del 2026-10-06 (lo decidió el dueño ese día, tras verlo en una instalación de laboratorio): la pantalla no dice que envió un código que no envió.** Con la regla de correos del WAF del user pool bloqueando, «¿Olvidaste tu contraseña?» avanzaba a «te enviamos un código» y «Crear cuenta» mostraba un error de «inicio de sesión». Desde hoy:

- **«Enviar código» y «Reenviar código»** (recuperación y verificación del correo): si Cognito rechaza el envío por una causa que **no depende de la cuenta**, la pantalla se queda donde está y muestra el error genérico. Son solo estas: bloqueo del WAF (`ForbiddenException` o un 403 sin nombre de excepción), límite de tasa de la API (`TooManyRequestsException` o un 429), fallo de red y error del servicio (`InternalErrorException` o un 5xx). Se deciden antes de mirar la cuenta, así que una cuenta que existe y una que no ven lo mismo.
- **Todo lo demás sigue avanzando como antes,** con el mensaje neutro: el envío correcto (que es también lo que recibe una cuenta que no existe, por `PreventUserExistenceErrors`) y cualquier respuesta que dependa de la cuenta o que no se pueda clasificar con seguridad.
- **`LimitExceededException` no se muestra.** Cubre el límite de intentos por usuario, que Cognito también aplica a un correo que no existe, y la cuota diaria de correos de la cuenta, a la que solo se llega cuando de verdad se envía un correo. Mostrarlo podría distinguir cuentas. La persona que lo alcanza sigue viendo «te enviamos un código» sin recibirlo: es el residuo que se acepta para no revelar si la cuenta existe.
- **«Crear cuenta»:** un rechazo que no es de sus campos muestra el error genérico, no el de inicio de sesión.
- **Texto:** el genérico que ya usan otros módulos, «No se pudo completar la acción. Inténtalo de nuevo.», en el sitio donde cada formulario ya muestra sus errores. El diseño no dibuja estos estados (D24): quedan para la siguiente ronda de diseño.

La lista vive en `apps/web/src/pages/login/errors.ts` y un test por respuesta comprueba que las dos cuentas ven la misma pantalla (`apps/web/src/pages/LoginPage.test.tsx`).
