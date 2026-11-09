# D34 · Guardrail y agentes de la release

- **Estado:** vigente
- **Fecha:** 2026-10-01 · `PASSWORD` enmascarada y no bloqueada, 2026-11-09 (decisión del dueño, por menú)
- **Precisa / reemplaza a:** en el texto de [D18](D018-creacion-y-publicacion-de-agentes.md) (ajuste del 2026-10-01): ajusta [D18](D018-creacion-y-publicacion-de-agentes.md) (guardrail base compartido en vez de uno por agente)
- **Precisada por:** [D42](D042-chat-con-varios-agentes.md) (precisa la siembra, punto 3); [D58](D058-distribucion-para-clientes.md) (precisa); [D80](D080-actualizacion-del-agente-de-la-release.md) (precisa: una versión posterior actualiza el agente si la instalación no lo cambió)

## Decisión

**Guardrail base compartido** por todos los agentes en Marketplace v1; el guardrail por agente queda para cuando el Builder tenga esa sección.

**Los agentes que vienen en la release (FinOps) están preaprobados:** se siembran como aprobados con `approved_by: release@<versión>` y un evento de auditoría, y el provisioner los publica. Cualquier cambio posterior hecho en la instalación sigue [D18](D018-creacion-y-publicacion-de-agentes.md)

**Precisión (2026-11-09; decisión 38 del dueño, por menú; excepción de seguridad registrada en `AGENTS.md`).** En el guardrail base, la entidad sensible `PASSWORD` pasa de `BLOCK` a `ANONYMIZE`, en la entrada y en la salida; `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, `CREDIT_DEBIT_CARD_NUMBER` y `CREDIT_DEBIT_CARD_CVV` siguen en `BLOCK`. Motivo: en la instalación del cliente, el modelo escribió una contraseña de ejemplo en una guía de seguridad del Canvas, y como el harness reenvía ese documento en cada turno, el filtro de entrada cortaba todas las preguntas siguientes de la conversación («No puedo procesar esta solicitud…»). Enmascarada, la contraseña se sustituye por una marca y no llega ni al modelo ni a la persona. Además, toda versión recibe una línea de la plataforma (`harness.PASSWORDS_LINE`) que le pide no escribir contraseñas, ni siquiera de ejemplo. Como los turnos usan la versión fijada del guardrail, la descripción de esa versión lleva un resumen de la política: cualquier cambio de la política crea una versión nueva con la misma identidad lógica, y la anterior se conserva (`UpdateReplacePolicy: Retain`) porque los harnesses ya publicados la guardan en su configuración por defecto; `mango-api` manda la nueva en cada turno.

