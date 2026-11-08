# D15 · Red de la PoC

- **Estado:** vigente
- **Fecha:** 2026-09-28 · precisada el 2026-11-07 por D114 (11) (la VPC del sandbox de código, sin salida ni DNS, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07)
- **Precisa / reemplaza a:** —
- **Precisada por:** [D63](D063-sesion-web-con-cookie.md) (amplía la excepción del tramo HTTP, punto 6); [D123](D123-segundo-origen-para-codigo-no-confiable.md) (una segunda distribución de CloudFront para el código no confiable); [D114](D114-code-interpreter-detras-del-gateway.md) (11) (una VPC propia del sandbox de código, sin salida ni DNS)

## Decisión

CloudFront con VPC origin hacia un ALB **interno**; el tramo CloudFront → ALB en **HTTP solo en la PoC** (en producción, HTTPS con certificado del dominio del cliente). `mango-api` en Fargate con **IP pública** y security group que solo acepta tráfico del ALB (sin NAT ni VPC endpoints en la PoC)

**Precisión de [D114](D114-code-interpreter-detras-del-gateway.md) (11) (2026-11-07, elegida la opción recomendada por el agente principal, por delegación expresa del dueño del 2026-11-07).** Además de la VPC de `mango-api`, la instalación tiene la VPC del sandbox de código, `Mango-<ns>-SandboxVpc`: sin internet gateway, NAT, VPC endpoints ni peering, con el DNS apagado, dos subredes aisladas y un security group sin reglas. Solo la usa el Code Interpreter de la instalación, en modo `VPC`.
