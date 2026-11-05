# D111 · Evals: quién ve, quién crea y ejecuta, y quién paga

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** — (sigue [D91](D091-playground.md) (3) y (4) para las evals)
- **Precisada por:** —

## Decisión

Origen: el diseño (`evals.jsx`) pone la vista Evals en `OWNER_VIEWS` (en la app, administradores y `finops-central`), y crear, ejecutar y ajustar exige editar el agente. Pero en el Agent Builder hay «Crear eval» también para un creador sin rol central, que no ve la vista: una incoherencia del diseño. Con las evals de D110 hacía falta decidir quién ve, quién crea y ejecuta, y quién paga.

**(1) Ven:** los administradores, `finops-central` y quien edita el agente (`EditAgent` sobre él, en Verified Permissions). Un creador ve las suites y las ejecuciones de los agentes que edita, aunque no tenga rol central (elegido por el dueño el 2026-11-05, por menú).

**(2) Crean, editan y ejecutan:** quien tiene `EditAgent` sobre el agente, como quien prueba en el Playground (D91 (4)). `finops-central` sin administrador ve los resultados, pero no crea ni ejecuta si no edita el agente.

**(3) Pagan quien la lanza y el agente**, como una prueba del Playground (D91 (3)): cada caso reserva antes de invocar (regla 4) en los dos ámbitos, y sin presupuesto la ejecución no empieza o se detiene en el caso en que se agota. **El juez** se cobra al agente. Una eval programada o «al enviar a aprobación» corre con la identidad de quien la creó, como una tarea (D78), y se pausa si esa persona pierde el acceso al agente.

**(4) Lo decide el servidor.** Acciones Cedar propias para ver, editar y aprobar que se quite «obligatoria» (que no puede aprobar quien lo pidió). Sus nombres los precisa el PR que las construye.

**(5) Opciones descartadas.** (b) Solo administradores: los creadores no podrían probar sus propios agentes antes de enviarlos. (c) Cualquiera que use el agente ve los resultados: los casos y sus motivos dicen cómo se comporta el agente ante preguntas que su usuario no hizo.
