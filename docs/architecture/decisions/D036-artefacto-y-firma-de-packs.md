# D36 · Artefacto y firma de los MCP packs

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** ajusta [D19](D019-catalogo-de-mcp.md)
- **Precisada por:** [D58](D058-distribucion-para-clientes.md) (precisa: la firma se muda a la cuenta del proveedor)
- **Tema en el registro original:** Artefacto y firma de los MCP packs (ajusta [D19](D019-catalogo-de-mcp.md))

## Decisión

Un pack es un **zip** con el paquete upstream fijado por hash y un punto de entrada propio que arranca el servidor por streamable HTTP; no hace falta fork ni puente stdio→HTTP. Se despliega en AgentCore Runtime con despliegue directo de código, sin ECR. CloudFormation copia el zip a un bucket de la instalación al instalar o actualizar: no hay descargas en runtime. La imagen por digest queda como alternativa si la prueba en el laboratorio descarta el zip. El Gateway llega al Runtime con un target `mcpServer` y SigV4.

**Firma:** llave asimétrica de KMS en la cuenta del proveedor; la llave pública va en la plantilla y el provisioner verifica firma y hash sin salir a internet. Por ahora la cuenta del proveedor es la de management del laboratorio
