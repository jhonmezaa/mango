# D17 · Administración en la app (Admin v0)

- **Estado:** parcial. Falta el límite de presupuesto **por agente** editable: la API solo tiene los valores por defecto y el límite por usuario (`apps/api/src/mango_api/admin.py`, comprobado el 2026-10-05). El resto está construido.
- **Fecha:** 2026-09-29
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Los límites de presupuesto (por usuario y por agente) y el mapeo área↔OU pasan de la configuración del IaC a una tabla `Settings` editable desde la app por admins (`mango-admin`). El IaC solo siembra los valores iniciales.

**El mapeo área↔OU exige doble aprobación** (propone un admin, aprueba otro distinto), porque define el aislamiento entre áreas.

**Nadie edita lo que le afecta** (su propio presupuesto, el mapeo de su área). Los presupuestos no tienen techo en IaC (riesgo residual aceptado). El conector lee el mapeo con caché corta y fail-closed. Un Lambda de solo lectura (`AdminProbe`) valida OUs y hace el chequeo de conectividad con la identidad del admin.

Modelo de amenazas: `docs/security/threat-models/admin-v0-threat-model.md`
