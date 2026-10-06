# D70 · `mango-api` corre con dos tareas y sus límites de tasa se cuentan una sola vez

- **Estado:** propuesta
- **Fecha:** 2026-10-06
- **Precisa / reemplaza a:** precisa [D33](D033-autorizacion-de-agentes-y-tools.md), [D60](D060-gestion-de-personas.md) y [D66](D066-cambios-de-personas-fuera-del-directorio.md) (los límites de sus excepciones se cuentan entre todas las tareas) y [D63](D063-sesion-web-con-cookie.md) (los límites de la sesión siguen siendo por tarea, a propósito)
- **Precisada por:** —

## Decisión

Hasta hoy `mango-api` corría con una tarea. Si caía, o caía su zona, el servicio se cortaba. Y sus límites de tasa vivían en la memoria de esa tarea: con N tareas el límite real era N veces el documentado, y un reinicio lo ponía a cero. Varias excepciones de `AGENTS.md` a «sin revelar si un usuario existe» se apoyan en esos límites.

**(1) Dos tareas, una por zona, número fijo.** El servicio de ECS pide dos tareas en las dos subnets públicas (una por zona de disponibilidad) y ECS las reequilibra entre zonas. No hay autoescalado ni parámetro de stack nuevo:

- Dos tareas en dos zonas es lo que hace falta para no depender de una tarea ni de una zona. No hay ninguna medida de carga que pida más.
- Reducir tareas corta los turnos de chat que estén en curso en la tarea que se apaga.
- Los límites que se quedan por tarea (punto 4) se multiplican por el número de tareas: con un número fijo ese factor se conoce.
- El costo de la instalación no cambia solo.

Un test de infraestructura fija el número; cambiarlo es revisar esta decisión.

**(2) Despliegue sin corte.** Con `minHealthyPercent` 100 y `maxHealthyPercent` 200, un despliegue arranca las tareas nuevas y solo apaga las anteriores cuando las nuevas responden; si no llegan a responder, ECS vuelve a la versión anterior. Durante un despliegue conviven hasta cuatro tareas.

**(3) Límites compartidos en DynamoDB.** Los límites que sostienen una excepción de seguridad, o que acotan abuso o costo, se cuentan en la tabla `Mango-<ns>-RateLimits` (`apps/api/src/mango_api/rate_limits.py`). La lista, con el motivo de cada uno, está en `apps/api/src/mango_api/limits.py`.

- **Misma ventana que antes:** deslizante, no fija. Se guardan los momentos de las llamadas de la ventana, así que no hay ráfaga doble en el borde de un minuto o de una hora. El límite documentado es el máximo en cualquier ventana, sume lo que sume cada tarea.
- **Atómico:** una lectura consistente y una escritura condicionada a la versión leída. Si otra llamada escribió antes, se vuelve a leer.
- **Nunca más flojo que lo documentado:** una llamada cuenta un segundo más que su ventana, por si los relojes de dos tareas difieren. «30 por minuto» es, en la práctica, 30 cada 61 segundos.
- **Si la tabla no responde, se rechaza** (429, como un límite alcanzado) y queda en el log con el nombre del límite, nunca con el usuario. Vale para todos los límites compartidos: todas esas rutas ya necesitan DynamoDB para funcionar.
- **Una fila por límite y por persona** (`LIMIT#<límite>#<sub>`): nadie gasta el límite de otro. Las filas caducan solas (TTL). La tarea solo puede leer y escribir por clave en esa tabla (`GetItem` y `PutItem`); no hay `Scan` ni `Query`.
- `mango-api` no arranca sin la tabla.

**(4) Tres límites se quedan por tarea,** con dos tareas valen el doble (cuatro veces durante un despliegue):

| Límite | Por qué por tarea |
|---|---|
| Inicios de sesión web (10 cada 5 min por persona) y renovaciones (30 cada 5 min por sesión) | Protegen el límite del WAF del user pool, que es por IP y por lo tanto por tarea. La renovación está en el camino de cada recarga, y entrar no debe depender de una tabla más. No sostienen ninguna excepción |
| Actualizar el catálogo de modelos (5 por minuto por administrador) | Solo frena un bucle de la pantalla: son dos listados gratuitos de Bedrock |

Lo de «por IP y por lo tanto por tarea» vale mientras cada tarea salga a internet con su propia IP pública, que es la red de la PoC ([D15](D015-red-de-la-poc.md)). Con una salida compartida (un NAT), todas las tareas gastarían el mismo límite del WAF del user pool (300 operaciones cada 5 minutos por IP): quien cambie la red revisa este punto.

El cupo diario de correos del directorio (200 por día) y las cuotas de envíos de agentes ya se contaban en DynamoDB.

**(5) Cachés.** Cada tarea guarda copias de pocos segundos (agente publicado y packs 15 s; presupuestos, modelos y directorio 30 s; organización 60 s). Con dos tareas, un cambio hecho en una tarda como mucho ese tiempo en verse en la otra; las comprobaciones que deciden (quién es administrador, el mínimo de dos administradores, la reserva de presupuesto) ya leían el dato directo. Solo se corrige una: la copia del directorio de personas lleva un número de generación guardado en `Settings`, que avanza con cada cambio aplicado, para que la lista que la pantalla vuelve a leer tras un cambio no muestre el estado anterior si cae en la otra tarea. El inventario completo está en `docs/specs/api-state-inventory.md`.

**(6) Turno de chat en un despliegue.** Una tarea que se va a apagar deja de recibir peticiones y conserva las que tiene abiertas durante 120 segundos (antes 30): el límite por defecto de un turno. Un turno más largo (un agente puede configurarse hasta 600 s) se corta al cumplirse ese tiempo: la persona ve el error de red del chat y la respuesta parcial. No se sube más porque cada despliegue espera ese tiempo.

**(7) Costo.** La segunda tarea (0,5 vCPU, 1 GB, arm64, IP pública) suma unos USD 18 al mes a precios de lista de `us-east-1`. La tabla se paga por uso: céntimos.
