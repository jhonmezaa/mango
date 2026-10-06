# D16 · Observabilidad de agentes

- **Estado:** vigente
- **Fecha:** 2026-09-29
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Los harness se despliegan con **captura de contenido GenAI apagada** (`OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_unredacted_attributes=`, `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` y la instrumentación MCP de ADOT desactivada con `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=urllib3,aws_mcp`, porque siempre registra argumentos y resultados de tools): prompts, respuestas y resultados de tools quedan como `[REDACTED]` en logs y spans; el contenido solo vive en auditoría y en la tabla de conversaciones. El log group del runtime se crea o adopta por IaC con KMS propio y retención de 30 días.

**CloudWatch Transaction Search** (necesario para las trazas de AgentCore) se habilita desde el stack (`observability.transactionSearch: stack`) o se declara `external` si la cuenta ya lo gestiona
