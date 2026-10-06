# D18 · Creación y publicación de agentes

- **Estado:** vigente
- **Fecha:** 2026-09-29 · ajuste del 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** [D33](D033-autorizacion-de-agentes-y-tools.md) (ajusta); [D34](D034-guardrail-y-agentes-de-la-release.md) (ajusta: guardrail base compartido)

## Decisión

Crean agentes los admins (`mango-admin`) y quienes tengan la acción Cedar `CreateAgent`, asignada por grupo (p. ej. `mango-agent-creator`).

**Todo agente nuevo y toda versión nueva de un agente publicado requiere aprobación** de un admin con `ApproveAgent` **distinto del creador de esa versión**; sin aprobación no aparece en el marketplace. Al aprobar, el provisioner (Step Functions, por SDK) crea el rol de ejecución y el harness. El harness del agente FinOps creado por CDK en la PoC es un atajo que se reemplaza por el provisioner (P3). Spec: `docs/specs/marketplace-v1.md`.

**Ajuste (2026-10-01):** el texto original decía que el provisioner también creaba un guardrail y políticas Cedar L2 por agente; [D33](D033-autorizacion-de-agentes-y-tools.md) (tools por agente con firma e interceptor, porque el Gateway no ve al agente) y [D34](D034-guardrail-y-agentes-de-la-release.md) (guardrail base compartido) lo cambian
