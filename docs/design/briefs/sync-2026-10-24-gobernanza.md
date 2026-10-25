# Contexto para Claude Design: la vista Gobernanza en el producto (2026-10-24)

> **Respondido** por la ronda de diseño 19 (2026-10-24): `HANDOFF.md`, «Gobernanza y Actividad · disponibilidad actual». El evento que el diseño llama `budget.block` es, en el producto, `budget.exceeded` (el turno bloqueado por presupuesto).

La vista «Gobernanza» (`other-views.jsx`, `function Governance`) sigue en «Próximamente» en el producto. Este cambio construye en el servidor lo que la vista necesita (D89, `propuesta`): un resumen de aprobaciones, presupuestos, cambios de áreas y auditoría. La pantalla se construye cuando el diseño resuelva lo de abajo. Es contexto, no una especificación de pantalla: actualiza el diseño y HANDOFF.md con lo que corresponda. Lo que no tenga backend se muestra como «Próximamente», sin datos de ejemplo (D24).

`governance` no está en `AVAILABLE` (`store.js`): el diseño no tiene modo «disponibilidad actual» para esta vista, ni estados de carga o de error.

## 1. Lo que el producto puede dar tal como lo dibuja el diseño

- **«necesita atención»:**
  - aprobaciones que esperan tu firma, con «N vencen en menos de 1 h»;
  - presupuestos que pasaron su umbral de alerta, con nombre y porcentaje;
  - cambios de áreas pendientes.
- **Indicadores:** «Aprobaciones pendientes» y «Decisiones · 7 días» (aprobadas y rechazadas).
- **«Eventos auditados · 24 h»:** el número, sin las lecturas (como Auditoría por defecto). Si hay más de 5.000, el producto da un mínimo y lo dice: hace falta un texto para «más de 5.000».
- **«políticas que piden aprobación»:** una fila por tool con solicitudes, sus pendientes («N pendientes» o «Al día»), su total y las firmas que pide.
- **«actividad reciente»:** los 7 últimos eventos de gobernanza de los últimos 7 días, con «Ver todo».

## 2. Lo que no cuadra: hace falta corregir el diseño

- **Agentes que no están en línea.** El producto no tiene salud de los agentes (el Marketplace tampoco muestra el estado en el modo disponible). La fila no tiene dato.
- **«Gasto de equipos».** No hay presupuestos de equipo. Los que existen son por agente (todos con el límite por defecto) y por usuario, y el umbral de alerta es fijo, 80 %. El indicador no tiene dato.
- **Riesgo de una aprobación.** El producto no tiene riesgo (como en Aprobaciones disponible). No tienen dato:
  - «N de riesgo alto» en la fila de aprobaciones;
  - el texto del indicador «Aprobaciones pendientes» («N de riesgo alto», «Ninguna de riesgo alto»);
  - «· N de riesgo alto» en las políticas.
- **«Registro encadenado y verificable».** No es cierto hoy: cada evento lleva su hash y el bucket tiene Object Lock, pero no hay cadena entre eventos ni digest firmado. Ese texto no se puede mostrar.
- **El nombre de una política.** El producto no tiene nombre de política: cada tool de escritura tiene la suya, con una condición (siempre, por monto, por cantidad de recursos o por entorno), de 1 a 3 aprobadores y un vencimiento. La fila sería la tool, con su regla como subtítulo (por ejemplo, «Siempre» o «Monto mayor a USD 1.000»).
- **Lo que ve `finops-central` sin ser administrador.** Abre la vista y firma aprobaciones, pero no ve presupuestos, cambios de áreas ni auditoría (son de administradores). No le llegan:
  - la fila de presupuestos y la de áreas;
  - los indicadores «Gasto de equipos» y «Eventos auditados · 24 h»;
  - la actividad reciente y el botón «Audit log» de la barra superior.

  Hace falta que el diseño dibuje esa variante.
- **Los eventos de la actividad.** Los nombres del diseño (`approval.approve`, `budget.update`, `mapping.propose`, `role.assign`…) no son los del producto. La actividad usa los eventos reales con los textos que ya tiene Auditoría:
  - aprobaciones: pedidas, aprobadas, rechazadas y vencidas, y los cambios de sus políticas;
  - presupuestos: cambios y turnos frenados por presupuesto;
  - cambios de áreas;
  - agentes: retirados y versiones aprobadas o rechazadas;
  - grupos: cambios de grupos y de miembros;
  - packs de MCP: solicitudes.

  Solo entra lo que pasó, no el intento. Los turnos frenados por presupuesto pueden ser muchos.
- **Carga y error.** La vista no los dibuja.

## 3. Pendiente del producto

- La salud de los agentes, con su propia decisión (AgentCore publica métricas de errores por recurso, sin comprobar para el harness gestionado).
- Presupuestos de equipo y límite editable por agente (D17).
- Riesgo de las aprobaciones.
- Auditoría encadenada y digest firmado (§4.5).
