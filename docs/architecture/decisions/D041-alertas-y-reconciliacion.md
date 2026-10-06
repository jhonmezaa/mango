# D41 · Alertas operativas y reconciliación diaria

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D48](D048-desaprovisionamiento.md) (ajusta: los restos de un agente retirado alarman); [D58](D058-distribucion-para-clientes.md) (resuelve la suscripción pendiente con `AlertsEmail`)

## Decisión

**Topic de alertas.** Toda alarma de CloudWatch de la instalación notifica al topic SNS `Mango-<ns>-Alerts`, cifrado con una llave KMS propia (`alias/Mango-<ns>-alerts`) y solo por TLS. Es obligatorio: cfn-guard (`CLOUDWATCH_ALARM_ACTION_CHECK`) exige que cada alarma tenga una acción y no se suprime. Solo publican las alarmas de CloudWatch de la cuenta.

**Suscripciones:** por parámetro de la instalación (regla 8), **pendiente**; hasta entonces el stack no crea ninguna y el cliente suscribe su canal al topic (salida `AlertsTopicArn`).

**Reconciliación diaria (TM-M6, TM-M9):** una Lambda de solo lectura compara la tabla `Agents` con los harness y roles de agente, a las **07:00 UTC**; detecta y avisa, no repara, y nunca lee la definición de un agente. Es asíncrona, así que lleva DLQ.

**Umbrales fijos en el código** (no son configuración por ahora): más de **30 publicaciones por hora** dispara la alarma de volumen del provisioner, y una versión `approved` con más de **45 minutos** se considera atascada (la máquina de estados corta a los 25 y el bloqueo vence a los 30).

Amenazas TM-M18 a TM-M20 en el modelo de Marketplace v1
