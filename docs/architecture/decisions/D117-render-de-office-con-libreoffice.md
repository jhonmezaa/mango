# D117 · Render de Word, Excel y PowerPoint en una Lambda-contenedor con LibreOffice, de la release

- **Estado:** vigente
- **Fecha:** 2026-11-07 (el punto 1, elegido por el dueño ese día, por menú: «Lambda-contenedor con LibreOffice (Recomendada)»; el cómo, puntos 2 a 5, propuesto por un agente y aceptado cuando el dueño apruebe integrar el cambio que registra esta decisión)
- **Precisa / reemplaza a:** precisa [D87](D087-como-se-construyen-los-reportes.md) (2) (que evitó imágenes de contenedor para los reportes: esta es otra función, con su imagen) y [D58](D058-distribucion-para-clientes.md) (una imagen más en el ECR del proveedor); respeta [D25](D025-recursos-creados-en-runtime.md)
- **Precisada por:** —

## Decisión

Origen: para que un documento de Office quede bien, el modelo tiene que verlo y corregirlo (crear → renderizar → mirar → corregir). La prueba del 2026-11-07 ([D114](D114-code-interpreter-detras-del-gateway.md) (8)) mostró que el Code Interpreter no trae LibreOffice y no admite una imagen propia: allí se puede pasar un PDF a PNG, pero no un Word, un Excel o un PowerPoint. Plan: [`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md).

**(1) Dónde (elegido por el dueño, por menú: «Lambda-contenedor con LibreOffice (Recomendada)»).** Una tool `render_document` detrás del Gateway, servida por una Lambda de imagen de contenedor con LibreOffice headless. Precisa [D87](D087-como-se-construyen-los-reportes.md) (2): los reportes siguen con ReportLab en el zip; esta función es aparte y sí lleva imagen.

**(2) La imagen (propuesto por un agente).** Se construye en el CI de la release, se publica en el ECR del proveedor con tags inmutables y se lee desde la organización del cliente como la de `mango-api` ([D58](D058-distribucion-para-clientes.md)). Va en el manifiesto firmado y la verifica `verify-release.py`. Nada se descarga ni se compila en ejecución ([D25](D025-recursos-creados-en-runtime.md)).

**(3) Cómo renderiza (propuesto por un agente).** LibreOffice headless con un perfil por proceso, fuentes fijadas en la imagen, arm64, macros desactivadas y sin red. Recibe un archivo por id de los archivos del chat ([D116](D116-archivos-del-chat.md)), ya escaneado, y devuelve un PDF y un PNG por página a S3 y a la sesión del sandbox.

**(4) Lo que el modelo ve (propuesto por un agente).** Falta probar si una imagen en el resultado MCP del Gateway llega al modelo (prueba G del plan). Si no llega, la alternativa se documenta en el PR que lo construye (D3 del plan) antes de seguir.

**(5) Operación (propuesto por un agente).** La invoca el Gateway de forma síncrona, así que no lleva DLQ (excepción de `CKV_AWS_116` ya acordada para las síncronas). Otra imagen en el ECR del proveedor y en la verificación de la release es un riesgo de mantenimiento que el plan registra.
