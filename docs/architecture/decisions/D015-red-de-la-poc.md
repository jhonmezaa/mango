# D15 · Red de la PoC

- **Estado:** vigente
- **Fecha:** 2026-09-28
- **Precisa / reemplaza a:** —
- **Precisada por:** [D63](D063-sesion-web-con-cookie.md) (amplía la excepción del tramo HTTP, punto 6)

## Decisión

CloudFront con VPC origin hacia un ALB **interno**; el tramo CloudFront → ALB en **HTTP solo en la PoC** (en producción, HTTPS con certificado del dominio del cliente). `mango-api` en Fargate con **IP pública** y security group que solo acepta tráfico del ALB (sin NAT ni VPC endpoints en la PoC)
