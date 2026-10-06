# D30 · «Reporta a» y delegación entre agentes

- **Estado:** parcial. Construido el punto (1). Falta el (2): delegación A2A, fase 2.
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

**Organización ahora, delegación después.**

(1) En Marketplace v1, «Reporta a» (supervisor o raíz) y «Rol» (máx. 40) son datos de la **versión** del agente: obligatorios al enviar a aprobación, sin ciclos (no el propio agente ni un subordinado), incluidos en la revisión y el diff, y cambian solo con una versión aprobada. Se muestran en el Marketplace y en un **Org Chart de solo lectura**. No tienen efecto en la ejecución: no dan permisos ni comparten presupuesto.

(2) **Fase 2: delegación A2A.** Usa ese árbol como lista de quién puede delegar en quién: solo de supervisor a subordinado directo. El subordinado trabaja con la **identidad del usuario que pidió** (regla 5), nunca con la del supervisor. Antes de cada salto se autoriza con Cedar (`DelegateTo` y `UseAgent` del usuario sobre el subordinado) y se reserva presupuesto (del usuario y de cada agente). Las tools de escritura siguen pidiendo aprobación. La auditoría se encadena con un id de delegación, con profundidad y costo máximos por cadena. Hasta entonces el diseño muestra la delegación como «Próximamente»
