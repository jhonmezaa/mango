# Registro de decisiones

Un archivo por decisión de arquitectura o de producto de Mango. El índice, con una línea por decisión, está en [§8 de la arquitectura de referencia](../reference-architecture.md#8-registro-de-decisiones).

Hasta el 2026-10-05 las decisiones eran filas de una tabla en §8. Se partieron en archivos sin cambiar su texto: cada archivo conserva la fila completa, separada en párrafos por sus puntos numerados.

## Qué trae cada archivo

```markdown
# D69 · Tema, en una frase

- **Estado:** propuesta
- **Fecha:** 2026-10-06
- **Precisa / reemplaza a:** precisa [D58](D058-distribucion-para-clientes.md) (4)
- **Precisada por:** —

## Decisión

Qué se decidió y por qué, en español. Si tiene varios puntos, numerados: **(1) …**, **(2) …**
```

- **Nombre del archivo:** `D<número con tres cifras>-<slug corto en minúsculas>.md`. El título y el resto del repositorio usan el número sin ceros («D47»).
- **Precisa / reemplaza a:** qué dice esta decisión sobre otras, con enlace. `—` si no dice nada.
- **Precisada por:** qué decisiones posteriores la tocan, con enlace. `—` si ninguna.
- **Tema en el registro original:** solo en las decisiones migradas de la tabla, cuando el título de su fila decía además a qué otras decisiones precisaba.

## Estados

| Estado | Qué significa |
|---|---|
| `propuesta` | La registró un agente y el dueño del repositorio todavía no la aceptó. No obliga a nadie más. |
| `vigente` | Rige. |
| `parcial` | Rige solo en parte: falta construir algo, o uno de sus puntos ya no rige. La línea de estado dice qué. |
| `pendiente` | Decidida y sin construir. |
| `reemplazada por Dnn` | Ya no rige: manda la decisión que se nombra. El archivo se conserva como historial. |

El estado dice si la decisión rige, no si el código está terminado al detalle. Qué está construido se lee en «Estado de lo construido», al inicio de la arquitectura de referencia.

## Cómo se registra una decisión nueva

1. **Número:** el siguiente al último del índice. Los números no se reutilizan ni se renumeran, aunque una decisión se reemplace.
2. **Archivo:** se crea con la cabecera de arriba y la fecha del día.
3. **Índice:** se añade su línea a la tabla de §8 (número, tema, estado, fecha y enlace). Tema, estado y fecha son los mismos del archivo.
4. **Decisiones que toca:** si precisa, ajusta, reemplaza o retira algo de otra, se dice en su línea «Precisa / reemplaza a» y se actualiza la otra: su línea «Precisada por» y, si deja de regir en todo o en parte, su estado. No se añaden párrafos «precisa Dn» al texto de la decisión anterior.
5. **Comprobación:** `uv run pytest deployment/tests/test_decision_records.py` (también corre con `mise run test` y en CI). Falla si un archivo no está en el índice o al revés, si se repite un número, si tema, estado o fecha no coinciden, o si un enlace no existe.

Corregir una decisión que ya rige:

- **Un dato o una precisión menor:** se añade a su texto un punto nuevo con su fecha, y la fecha se suma a la línea «Fecha».
- **Un cambio de sentido:** es una decisión nueva que la precisa o la reemplaza. El texto de la anterior no se reescribe.

## Decisiones que registra un agente

> Regla propuesta el 2026-10-05 tras la revisión del proyecto. Rige desde que el dueño la confirme; si la ajusta, se cambia solo esta sección y la frase de `AGENTS.md` que apunta aquí.

- Una decisión que añade un agente nace con estado **`propuesta`**.
- El agente la lista en su informe y en la descripción de su PR.
- Pasa a `vigente` cuando el dueño del repositorio la acepta. Quien la acepte en su nombre cambia el estado en el archivo y en el índice, y añade la fecha de aceptación a la línea «Fecha».
- Una decisión que el dueño tomó en la conversación y el agente solo transcribe nace `vigente`, y el texto dice que la tomó el usuario y cuándo.
- Antes de proponer algo que contradiga una decisión `vigente` o `parcial`, el agente lo señala y pide confirmación (`AGENTS.md`).

D64, D67 y D68 las registraron agentes antes de esta regla, sin una aceptación explícita. Quedaron `vigente` porque ya estaban integradas y desplegadas.
