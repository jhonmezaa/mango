# D105 · Costos: administradores y `finops-central` ven lo mismo, presupuestos por agente incluidos

- **Estado:** vigente
- **Fecha:** 2026-11-05 (elegida por el dueño ese día, por menú)
- **Precisa / reemplaza a:** precisa [D17](D017-admin-v0.md) y [D89](D089-vista-gobernanza.md) (1) (en la vista Costos, `finops-central` sin administrador ve también el presupuesto de cada agente)
- **Precisada por:** —

## Decisión

Origen: el diseño (D24, `costs2.jsx`) tiene una vista «Operación › Costos» que el producto muestra como «Próximamente». La investigación del 2026-11-05 comprobó que casi todos sus datos ya existen en `Budgets`: los contadores por día de la organización, de cada área y de cada persona (D102) y de cada agente (D104 (7)), y los acumulados mensuales por agente y por persona (D11). Faltaba decidir quién la ve y qué ve cada uno. El dueño lo eligió el 2026-11-05, por menú.

**(1) Quién la ve: administradores y `finops-central`, los dos con lo mismo.** La vista la abren quienes el diseño pone en `OWNER_VIEWS`, que en la app son los administradores y `finops-central` (`apps/web/src/layouts/navigation.ts`). Los dos reciben la misma respuesta: el gasto del mes y del anterior, por día y por agente, las consultas y el costo medio, y **el presupuesto de cada agente** (su límite y cuánto lleva usado).

**(2) Lo que esto amplía, dicho una vez.** D17 y D89 (1) dejaban los presupuestos de agentes y de personas solo a los administradores: Gobernanza manda esa sección `null` a `finops-central` sin administrador. Con esta decisión, **en la vista Costos** `finops-central` sin administrador ve el presupuesto de cada agente. El menú lo decía al elegir. Fuera de Costos nada cambia: Presupuestos y Gobernanza siguen siendo de administradores, Inicio sigue como D102 (5), y el presupuesto de **cada persona** no entra en Costos para nadie. Editar un presupuesto sigue siendo solo de administradores (D17), y el botón «Presupuestos» de la vista lleva a esa pantalla, que `finops-central` sin administrador no abre.

**(3) Lo decide el servidor.** Una acción Cedar propia (`ViewCosts`) para administradores y `finops-central`, en Verified Permissions; la web solo muestra lo que llega. La lectura se audita como lectura, con límite por persona y caché corta, como Inicio y Gobernanza (D89 (6), D102 (7)). Cómo se lee cada agente sin `Scan` y qué devuelve exactamente la ruta lo precisa el PR que la construye.

**(4) Opciones descartadas.** (a) Administradores todo y `finops-central` sin presupuestos (sección `null`, como D89 (1)): era la recomendada por la investigación, porque no amplía ningún permiso. (b) Solo administradores: dejaba fuera al rol de finanzas, al que el diseño le da la vista.

**(5) Precisión del 2026-11-05 al punto 3: el límite de lectura se cuenta en cada tarea.** La aceptó el dueño ese día, por menú, al construir la ruta. `GET /api/costs` admite 30 lecturas por minuto y persona, contadas en cada tarea de `mango-api` (`costs.reads`), como Inicio (`home.reads`) y Gobernanza (`governance.reads`): no guarda ninguna excepción de seguridad, cada lectura son consultas acotadas y una caché de 30 s por persona y mes absorbe las recargas. Contarlo en la tabla de límites sumaría dos llamadas a DynamoDB a cada lectura. Es la regla de D70: un límite por tarea nuevo se registra.

**(6) Lo que precisa el PR que construye la ruta (2026-11-05), dentro de lo decidido.** La entrada es solo el mes (`month=yyyy-mm`, el actual y los once anteriores: los contadores caducan a los 400 días). Cada agente se lee sin `Scan`: una `Query` de su `DAY#AGENT#<id>` por los días del mes y del anterior, con los agentes publicados y retirados del catálogo, el del release y el Playground (hasta 500); los modelos, del catálogo de modelos, de los agentes y del modelo auxiliar (hasta 100). El presupuesto de cada agente (límite por defecto, D17, y lo que cuenta `AGENT#<id>` del mes, con lo retenido) solo va en el mes en curso: los límites de meses pasados no se guardan. Lo que la organización gastó y ninguna fila de un desglose recoge (títulos, turnos de antes de un contador) va aparte (`unattributed_usd`), como pide D106 (3).

Modelo de amenazas: `docs/security/threat-models/costs-threat-model.md`.
