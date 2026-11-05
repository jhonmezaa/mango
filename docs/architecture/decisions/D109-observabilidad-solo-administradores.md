# D109 · Observabilidad: solo administradores, con la persona visible

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

Origen: el diseño (`observability2.jsx`) pone la vista Observabilidad en `OWNER_VIEWS`, que en la app son los administradores y `finops-central`, y muestra en cada traza a la persona que preguntó («Conversación de {usuario}», con su correo). Un administrador ya ve en Auditoría quién hizo cada turno (`agent.completed` lleva el actor, `ViewAudit`). `finops-central` sin administrador no tiene `ViewAudit` (D89 (1)): verle el correo a cada persona que usó un agente le ampliaba permisos.

**(1) Solo administradores** (elegido por el dueño el 2026-11-05, por menú). La vista la abren los administradores, con una acción Cedar propia (`ViewObservability`) solo para administradores, decidida en el servidor. Ven a la persona de cada traza, que ya ven en Auditoría: no se amplía nada.

**(2) Lo que implica.** `finops-central` sin administrador no ve la vista, aunque el diseño la ponga en `OWNER_VIEWS`: su entrada del menú no se le muestra y la ruta le responde 403. «Ver trazas», desde el cajón de un agente en Costos (D105), solo se ofrece a quien puede abrir Observabilidad.

**(3) Sin texto de la pregunta.** El título de una traza y «Abrir conversación» dependen del acceso de administradores a conversaciones (D23), que sigue sin construir. Mientras tanto la vista va siempre en «Solo metadatos», el estado que ya dibuja el diseño, y la búsqueda no busca en las preguntas.

**(4) Opciones descartadas.** (a) Administradores con la persona y `finops-central` sin administrador sin ella («De otra persona», como D90 (1)): era la recomendada por la investigación. (c) Los dos con la persona: ampliaba D90 (1) y D89 (1).
