# D119 · Skills de documentos: instrucciones del harness y helpers firmados en la release, copiados a la sesión del sandbox

- **Estado:** propuesta
- **Fecha:** 2026-11-07 (propuesta por un agente en el plan de capacidades del chat; el render que usa su bucle lo eligió el dueño ese día en [D117](D117-render-de-office-con-libreoffice.md))
- **Precisa / reemplaza a:** precisa [D26](D026-reglas-del-ciclo-de-vida.md) («las skills con scripts solo vienen en la release»: el código viaja firmado en la release y corre en el sandbox, no en el harness) y [D92](D092-skills-de-solo-instrucciones.md) (2) («sin scripts»: las skills siguen siendo de instrucciones; los scripts son helpers del sandbox)
- **Precisada por:** —

## Decisión

Origen: el plan de capacidades del chat ([`docs/specs/chat-capacidades-plan.md`](../../specs/chat-capacidades-plan.md)). Un buen PDF, Word, Excel o PowerPoint sale de unas instrucciones claras más un código auxiliar probado, y del bucle crear → renderizar → mirar → corregir.

**(1) Las instrucciones.** Cuatro skills de documentos, `pdf`, `docx`, `xlsx` y `pptx`, en el formato de [D92](D092-skills-de-solo-instrucciones.md), que describen el bucle con `render_document` ([D117](D117-render-de-office-con-libreoffice.md)). Vienen con la release, así que «Incluida con Mango» aparece por primera vez.

**(2) Los helpers.** El código auxiliar (Python) viaja en la release, en su manifiesto firmado. La Lambda del sandbox ([D114](D114-code-interpreter-detras-del-gateway.md)) lo copia a la sesión con `writeFiles` al abrirla. El harness sigue sin `shell` ni `file_operations`: el código solo corre en el sandbox.

**(3) Salidas.** Solo las extensiones de la lista cerrada de [D116](D116-archivos-del-chat.md) (6): sin HTML, SVG, macros ni ejecutables.

**(4) Antes de construir.** El modelo de amenazas del sandbox (`code-interpreter-threat-model.md`, PR P1 del plan) cubre los helpers.
