# D23 · Acceso de admins a conversaciones

- **Estado:** pendiente. Sin construir: la acción `ViewConversations` no existe en `policies/cedar` ni en `apps/api` (comprobado el 2026-10-05).
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Parámetro de instalación, **desactivado por defecto**. Si se activa, solo quien tenga la acción Cedar `ViewConversations` puede leer conversaciones de otros usuarios, y **cada lectura queda en auditoría** (fail-closed: si no se registra, no se muestra). Las trazas siguen redactadas ([D16](D016-observabilidad-de-agentes.md)): el contenido sale de la tabla de conversaciones
