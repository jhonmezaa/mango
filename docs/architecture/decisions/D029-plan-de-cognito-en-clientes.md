# D29 · Plan de Cognito en clientes

- **Estado:** vigente
- **Fecha:** 2026-09-30 · actualizada el 2026-10-01
- **Precisa / reemplaza a:** revisa [D20](D020-login-y-registro.md) y [D28](D028-implementacion-del-login-propio.md)
- **Precisada por:** [D31](D031-logs-de-cognito-y-block.md) (cierra sus pendientes)
- **Tema en el registro original:** Plan de Cognito en clientes (revisa [D20](D020-login-y-registro.md) y [D28](D028-implementacion-del-login-propio.md))

## Decisión

**Se mantiene Cognito Plus forzado en clientes** (Essentials en el laboratorio), pero configurado solo con lo que funciona con SRP y MFA obligatorio.

**Credenciales comprometidas:** `BLOCK` en `SIGN_UP` y `PASSWORD_CHANGE` (`ConfirmForgotPassword` y el reto `NEW_PASSWORD_REQUIRED`); se quita `SIGN_IN`, porque Cognito no ve la contraseña en `USER_SRP_AUTH` y no actúa sobre ese flujo.

**Autenticación adaptativa:** `NO_ACTION` en los tres niveles, sin notificación: con MFA obligatorio en cada ingreso, `MFA_IF_CONFIGURED`/`MFA_REQUIRED` no agregan nada (AWS exige MFA opcional para esas respuestas), y un `BLOCK` sin aviso al usuario (no hay SES) ni huella de dispositivo (la SPA no envía `UserContextData`) arriesga bloquear usuarios legítimos. El riesgo se sigue calculando y queda en el historial de eventos del usuario (2 años, `AdminListUserAuthEvents`) y en métricas de CloudWatch. Las listas de IP permitidas/bloqueadas de Plus no se usan: el WAF regional ([D28](D028-implementacion-del-login-propio.md)) ya lo cubre en todas las operaciones.

**Motivo:** Plus es la única forma de rechazar contraseñas filtradas o comunes al registrarse y al restablecerlas (defensa en profundidad frente al reset de MFA, TM-L14), da el historial de riesgo para investigar incidentes y cumple cdk-nag COG8 sin excepciones; cuesta USD 0,020/MAU sin capa gratuita frente a USD 0,015/MAU con 10 000 MAU gratis en Essentials (p. ej. 1 000 MAU: ~USD 20/mes frente a USD 0).

**Actualizado el 2026-10-01:** los dos pendientes (exportar `userAuthEvents` con retención propia y evaluar `BLOCK` en riesgo alto) se resuelven en [D31](D031-logs-de-cognito-y-block.md)
