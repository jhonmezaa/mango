# D9 · Versionado y upgrades

- **Estado:** parcial. Rigen la versión fijada, los dos canales y `UpdateStack` sin CodeBuild. Ya no rige «ejecutado por el equipo Mango vía IdC»: desde [D58](D058-distribucion-para-clientes.md) (2) actualiza el cliente.
- **Fecha:** 2026-09-28
- **Precisa / reemplaza a:** —
- **Precisada por:** [D25](D025-recursos-creados-en-runtime.md) (la mantiene); [D58](D058-distribucion-para-clientes.md) (reemplaza quién ejecuta la actualización, punto 2)

## Decisión

**Versión fijada por cliente**; canal de **parches** incluido en soporte y **versiones** con features cobradas; soporte a las 2 últimas menores; upgrades = `UpdateStack` con plantillas pre-construidas, ejecutado por el equipo Mango vía IdC.

**Sin CodeBuild en la cuenta del cliente** (§4.12)
