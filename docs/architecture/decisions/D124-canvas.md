# D124 · Canvas: documentos y código editables junto al chat, con vista previa en el segundo origen

- **Estado:** vigente
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat, que el dueño pidió completo ese día, por menú: «Todo detallado»; ninguna pregunta de ese día la eligió por sí sola) · aceptada por el dueño el 2026-11-07, por menú: «Aceptar las cuatro (Recomendada)»
- **Precisa / reemplaza a:** precisa la regla 1 de `AGENTS.md` (transpilar en el navegador de la persona, dentro del segundo origen, no es compilar ni descargar código en la cuenta del cliente)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)).

**(1) Qué.** Un documento o un archivo de código que el agente y la persona editan junto al chat, con versiones y «mostrar cambios».

**(2) Las tools.** `textdoc.create`, `textdoc.update` y `textdoc.comment`, que solo escriben en Mango. Las versiones van en DynamoDB y el contenido en S3, con la retención de la conversación. Dónde vive la tool (conector del Gateway o tool interna) lo decide su PR, sin tocar ningún sistema externo (regla 3).

**(3) Exportar.** `.md`, `.docx` y PDF, los dos últimos con `render_document` ([D117](D117-render-de-office-con-libreoffice.md)), como archivos del chat ([D116](D116-archivos-del-chat.md)).

**(4) Vista previa.** React, HTML y Python (Pyodide) se ejecutan solo en el segundo origen ([D123](D123-segundo-origen-para-codigo-no-confiable.md)), con las dependencias del espejo de la release. Nada del documento se ejecuta en el origen de la SPA.

**(5) Diseño.** Sale de la ronda de Claude Design de su fase ([D24](D024-diseno-de-la-ui.md)).
