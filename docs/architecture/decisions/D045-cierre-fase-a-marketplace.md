# D45 · Cierre de la fase A de Marketplace v1

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

**(1) Rechazos en el historial de revisión.** Un rechazo devuelve la versión a `draft` (spec §3), pero el borrador sigue en el índice `ByStatus` de la tabla `Agents` con la marca `VERSION#rejected` hasta que su autor lo reenvía o lo descarta; así el historial de Revisión lo muestra con su motivo.

**(2) Correos de quien decide.** El correo de quien aprueba, rechaza o retira se guarda en la tabla `Agents` al decidir (`approved_by_email`, `rejected_by_email`, `retired_by_email`), igual que el del creador. Solo se muestran a administradores (Revisión) y al autor de la versión (Builder); nunca en el Marketplace.

**(3) Reintento de una aprobación vencida.** `retry` acepta una versión `approved` con más de 45 minutos: la ejecución del provisioner vence a los 25 y su bloqueo a los 30, así que ya nada la publica. Primero pasa a `failed` (`publication_expired`), con condición en DynamoDB sobre antigüedad y hash, y luego se publica de nuevo con el mismo hash y el mismo aprobador; antes de ese plazo responde 409. El reconciliador ([D41](D041-alertas-y-reconciliacion.md)) usa el mismo umbral.

**(4) Capacidades de los modelos como dato de la release (regla 7).** Bedrock no informa si un modelo admite tools ni su tamaño de contexto: salen de `models/capabilities.json`, por id de modelo base y con coincidencia exacta, dentro de la imagen de `mango-api`. Se aplican al actualizar el catálogo en Brains. Un modelo que no está en el archivo entra sin uso de tools (fail-closed) y sin tamaño de contexto.

**(5) Restricciones L2 de los conectores también como `forbid`.** Cada restricción de Cedar del Gateway sobre un conector se escribe dos veces: el `permit` por rol (deny por defecto) y un `forbid … unless` con la misma condición. Cedar evalúa `forbid` sobre cualquier `permit`, así que una política añadida después al motor (el provisioner de packs crea políticas, [D43](D043-provisioner-de-packs.md)) no puede abrir esas tools a nadie más. Las tools de toda la organización se leen del manifiesto del conector (`audience: central`).

**(6) Dependencia de desarrollo `@playwright/test`.** Versión fijada, solo en `apps/web`, para la prueba de navegador del flujo crear → revisar → usar contra el mock local (`mise run e2e`); CI descarga Chromium y no usa AWS ni secretos. No entra en el bundle ni en la imagen
