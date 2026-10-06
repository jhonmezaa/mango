# D31 · Logs de actividad de Cognito y `BLOCK` en riesgo alto

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** cierra los pendientes de [D29](D029-plan-de-cognito-en-clientes.md)
- **Precisada por:** —
- **Tema en el registro original:** Logs de actividad de Cognito y `BLOCK` en riesgo alto (cierra los pendientes de [D29](D029-plan-de-cognito-en-clientes.md))

## Decisión

**Exportación:** con Plus, el stack exporta `userAuthEvents` (nivel `INFO`, el único que admite) a un log group propio, `/aws/vendedlogs/Mango-<ns>-cognito-auth-events`: cifrado con la CMK de logs, con una política de recurso que solo deja escribir a `delivery.logs.amazonaws.com` desde la misma cuenta, y `RETAIN` donde se retienen datos. Retención por parámetro `auth.authEventsRetentionDays` (**365 días** por defecto; de 90 a 3653): un año cubre la investigación de una toma de cuenta detectada tarde y la línea base habitual de logs de seguridad (p. ej. PCI DSS 10.5.1), sin guardar PII (correo, IP, dispositivo, ciudad) más de lo necesario. Los eventos no traen tokens ni contraseñas y no se reenvían a logs operativos. Con Essentials (laboratorio) no se crea nada: sin threat protection no hay eventos. `userNotification` (errores de entrega de correo y SMS) **no** se exporta todavía: se agrega junto con SES.

**Riesgo alto:** se mantiene `NO_ACTION` por defecto, por los motivos de [D29](D029-plan-de-cognito-en-clientes.md): sin SES no hay aviso al usuario bloqueado, la SPA no envía `UserContextData` (sin huella de dispositivo) y el MFA ya se exige en cada ingreso. Nuevo parámetro `auth.highRiskAction` (`NO_ACTION` | `BLOCK`; `BLOCK` solo con Plus); riesgo bajo y medio siguen en `NO_ACTION`.

**Criterios para pasar a `BLOCK`:**

(1) SES configurado y notificación de riesgo activa;

(2) al menos **4 semanas** de observación con `userAuthEvents` y tráfico real;

(3) falsos positivos (ingresos de riesgo alto que completaron el MFA y no corresponden a un incidente) por debajo del **0,1 % de los ingresos**, sin oficinas ni VPN afectadas de forma recurrente;

(4) un proceso de soporte para atender a un usuario bloqueado.

El cambio se aplica con `UpdateStack`
