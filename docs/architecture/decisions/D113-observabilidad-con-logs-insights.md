# D113 · Observabilidad: el lector de trazas consulta con Logs Insights y usa `FilterLogEvents` solo de respaldo

- **Estado:** vigente
- **Fecha:** 2026-11-06 (elegida por el dueño ese día, por menú, tras medirlo en la instalación del cliente)
- **Precisa / reemplaza a:** precisa [D108](D108-traza-de-observabilidad-desde-aws-spans.md) (1) y (2) (la función lee `aws/spans` y los log groups del runtime con Logs Insights, no solo con `FilterLogEvents`) y [D73](D073-turno-cortado-nunca-cuesta-cero.md) (9) (su «no se usa Logs Insights» sigue valiendo para el conciliador, no para el lector de trazas)
- **Precisada por:** —

## Decisión

Origen: la pestaña Observabilidad tardaba ~22 s en su primera carga de 24 h (2026-11-06, medido en el navegador del dueño y en los logs del ALB y de CloudFront de la instalación del cliente). Toda la espera era el lector de trazas, que llegaba siempre a su tope de 20 s y respondía `capped`: la vista de 24 h no veía el día entero.

**(1) La causa, medida en la instalación el 2026-11-06.** `FilterLogEvents` se paga por llamada, no por volumen. `aws/spans` tenía unos 5 MB al día (150 a 800 eventos por hora), pero cada llamada tardaba 0,7–1 s aunque no encontrara nada, y una ventana se responde por tramos con `nextToken`. Leer 24 h por horas costaba 27 llamadas y 22 s; en una sola ventana, 12 llamadas y 13,3 s; en trozos de 6 h, 14 llamadas y 8,7 s. Los ~16 log groups del runtime, vacíos desde hace 7 días, suman una llamada cada uno. Con Logs Insights, la misma consulta de 24 h tardó 1,1 s sobre `aws/spans` y 1,7 s sobre `aws/spans` más 12 log groups del runtime (9,9 MB escaneados); 1 h tardó 0,7 s.

**(2) La función consulta primero con Logs Insights** (elegido por el dueño el 2026-11-06, por menú). Lanza un `StartQuery` por cada 50 log groups (`aws/spans` y los del runtime de los harness de la instalación) con una consulta fija: los spans `invoke_agent`, `chat <modelo>` y `execute_tool` cuyo `harness.id` empieza por `Mango_<ns>_a_` (o por el del agente pedido), del más reciente hacia atrás, con un máximo de 10.000 filas, que se marcan `capped`. Después pide `GetQueryResults` hasta que la consulta termina, durante 10 s como mucho. La consulta se arma solo con el prefijo de la instalación y con un id de agente que ya cumplió su patrón. La lista cerrada de atributos de D108 (3) no cambia.

**(3) `FilterLogEvents` queda de respaldo.** Si la consulta no puede empezar (cuota de consultas a la vez, error de la API), falla o no termina en esos 10 s, la función la para y lee con `FilterLogEvents` el resto del plazo: `aws/spans` en trozos de 6 h desde el más reciente y luego los log groups del runtime, con dos llamadas a la vez como mucho (la cuota de la cuenta la comparte el conciliador de D73). El log de cada lectura dice qué camino se usó (`engine`).

**(4) Permisos, con una excepción acordada.** `logs:StartQuery` va sobre los mismos ARNs que `FilterLogEvents` (`aws/spans` y `harness_Mango_<ns>_a_*`), y el `Deny` de `logs:*` sobre los log groups del harness de evals (D110 (3), (8)) sigue en el rol: ninguna consulta puede nombrarlos, y la función tampoco los nombra. `logs:GetQueryResults` y `logs:StopQuery` no admiten recurso, así que van con `Resource: "*"`. Riesgo: con el `queryId` de una consulta ajena, el rol podría leer sus resultados. Mitigación: la función solo pide resultados de los ids que su propio `StartQuery` le dio en esa lectura, y no tiene `logs:DescribeQueries`, así que no puede conocer los de otros. Un test de infra fija las acciones, los recursos y la ausencia de `DescribeQueries` (excepción registrada en `AGENTS.md` el 2026-11-06; TM-OB8).

**(5) Costo.** Logs Insights cobra 0,005 USD por GB escaneado. Con el volumen medido, una lectura de 24 h cuesta unos 0,00005 USD, y la caché de un minuto por rango y agente de `mango-api` limita cuántas se hacen.

**(6) Lo que no cambia.** El conciliador de presupuesto (D73 (9)) sigue con `FilterLogEvents` y sin Logs Insights. En `mango-api` siguen la caché de un minuto por tarea y el límite de 30 lecturas por minuto. Desde este cambio, además, hay una sola lectura en curso por rango y agente en cada tarea, las lecturas van en hilos propios, la invocación de la función no se reintenta y una petición espera como mucho 50 s, por debajo de los 60 s que CloudFront espera al origen.
