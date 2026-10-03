# Capacidades de los modelos

`capabilities.json` es un dato de la release (regla 7 de `AGENTS.md`: el catálogo de modelos es configuración). Dice, por id de modelo base de Bedrock, lo que Bedrock no informa en `ListFoundationModels` ni en `ListInferenceProfiles`:

| Campo | Significado |
|---|---|
| `supports_tools` | El modelo admite uso de tools (Converse). Obligatorio |
| `context_tokens` | Tamaño de contexto estándar en tokens. Opcional: sin él, Brains muestra «Sin datos» |

Reglas:

- La clave es el id del modelo base (`anthropic.claude-sonnet-4-6`), no el del perfil de inferencia (`us.…`, `global.…`). Vale para todos los perfiles que enrutan a ese modelo.
- La coincidencia es exacta. Un modelo que no está en el archivo entra en Brains **sin uso de tools** (fail-closed) y sin tamaño de contexto: solo sirve para agentes sin tools hasta que una release lo añada aquí.
- Solo se anota lo que está confirmado en la documentación del proveedor. Ante la duda, se omite `context_tokens` o el modelo entero.
- El archivo va dentro de la imagen de `mango-api`. Se aplica al pulsar «Actualizar catálogo» en Brains: los modelos listados aquí toman estas capacidades; los demás conservan las que tenían.
