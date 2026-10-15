# Contexto para Claude Design: «Schedules» ya está implementado; faltan el resultado de una ejecución y el disparador por anomalía de costo (oct 2026)

El producto ya implementa la pantalla «Schedules» (`schedules.jsx`): lista con sus cuatro indicadores, filtros, detalle con «Tarea», «Programación», «Entrega y control» y «Ejecuciones recientes», editor y retiro con motivo. Cada tarea corre con la identidad de quien la creó y se pausa sola si esa persona pierde el acceso (D26, D78). Esto es contexto: actualiza el diseño y HANDOFF.md con lo que corresponda. Lo que el producto ya muestra distinto del diseño está construido con lo mínimo y los componentes existentes, a la espera de este diseño.

## 1. Lo que quedó igual que el diseño

- Textos de la cabecera, de los indicadores, de los filtros y de las columnas.
- «Ejecutar ahora», «Pausar», «Reanudar», «Editar» y «Retirar» con motivo, con las mismas reglas: solo quien la creó la edita, la ejecuta ahora o la reanuda; un administrador la pausa o la retira.
- La pausa automática: «Pausada automáticamente hace…», «Solo se reanuda si recupera el acceso; si no, retírala.», con «Reanudar» desactivado.
- El aviso de frecuencias altas («Cada 15 minutos son ~2.880 ejecuciones…»).
- «Canal de Slack», «Próximamente».

## 2. Lo que el producto muestra distinto (hace falta diseño)

### 2.1 Ver el resultado de una ejecución

El diseño no muestra en ninguna parte qué respondió el agente. «Entregar resultado en: Bandeja del creador», pero la Bandeja no tiene un tipo «ejecución» y no está construida. El producto añade, en cada línea de «Ejecuciones recientes» que dejó resultado, un enlace «Ver resultado» que abre un diálogo «Resultado · {fecha}» con el nombre de la tarea y la respuesta en Markdown (sin HTML). Hace falta decidir dónde se lee el resultado: en el detalle, en la Bandeja o en los dos.

### 2.2 «Crear ticket» no está disponible

Los tickets no existen y en esta etapa los resultados no salen de Mango. El producto muestra «Crear ticket» como «Próximamente», igual que Slack.

### 2.3 El selector de agente

Solo lista los agentes publicados que la persona puede usar (el diseño lista todos).

### 2.4 Quién ve qué tareas

Cada persona ve sus tareas; un administrador ve todas. El diseño muestra todas a quien ve la pantalla, pero la «Tarea» es la instrucción de otra persona.

### 2.5 Próximas ejecuciones en el editor

El editor no muestra «· próximas: …». El producto calcula las próximas en el servidor con la zona horaria elegida (el diseño las calcula en la hora del navegador, sin la zona). En la lista y el detalle sí aparecen, en la hora de quien mira.

### 2.6 «Necesitan atención» por presupuesto

«Presupuesto del agente agotado: las próximas ejecuciones se omitirán» aún no se calcula. Sí: el agente ya no existe, perdió el acceso, alguna tool no disponible, y 2 de las últimas 3 fallaron.

### 2.7 Estados de una ejecución que el diseño no tiene

Además de «Completada», «Fallida», «Omitida» y «Espera aprobación», una ejecución está «En cola» o «Ejecutando…» mientras corre. Una omitida o fallida dice por qué, con un texto fijo debajo: «Presupuesto agotado», «El creador perdió el acceso al agente», «Otra ejecución seguía en curso», «Se alcanzó el tope de investigaciones del día», «El agente falló»…

### 2.8 Al terminar «Ejecutar ahora»

El aviso «{nombre} completada · entregada en bandeja del creador» sale cuando la ejecución termina de verdad (la pantalla consulta cada 3 s mientras hay una en curso); antes sale «{nombre} en cola». Si no se completa, «{nombre} no se completó».

### 2.9 La pausa de un administrador frena (D78 (19))

Mientras un administrador tenga pausada una tarea, su dueño no puede «Ejecutar ahora» ni «Reanudar»: solo un administrador la reanuda. El producto desactiva esos botones para el dueño (con «Un administrador la pausó: solo un administrador la reanuda» como ayuda) y en el detalle dice «Pausada por un administrador: no se ejecutará, ni a pedido, hasta que un administrador la reanude.». La pausa del dueño sigue siendo suya: un administrador no la levanta.

### 2.10 El resultado solo lo ve su dueño (D78 (18))

Un administrador ve el estado, la duración, el costo y el motivo de cada ejecución, pero no «Ver resultado»: la respuesta se obtuvo con el acceso del dueño, como en el chat, donde un administrador no lee conversaciones ajenas.

## 3. El disparador por anomalía de costo (hace falta diseño)

Una tarea puede arrancar sola cuando AWS detecta una anomalía de costo, para investigarla (D79). El producto añade lo mínimo:

1. En el editor de una tarea nueva, «Disparador»: «Por horario» (lo de hoy) o «Cuando haya una anomalía de costo». Con el segundo no hay frecuencia ni zona horaria. El disparador no cambia al editar.
2. Solo para personas centrales: para las demás, la opción está desactivada y debajo dice «Solo las personas centrales pueden suscribirse a las anomalías de costo.».
3. En la lista y el detalle, «Al detectar una anomalía de costo» en lugar de la frecuencia, y «Próxima: —».
4. El tope: «Hasta 5 investigaciones por día» bajo el disparador; cuando se alcanza, la ejecución queda «Omitida» con «Se alcanzó el tope de investigaciones del día».
5. En cada ejecución, qué anomalía la arrancó (fechas, enlace a la anomalía si llega a existir en la aplicación) y el motivo de una omisión (tope, presupuesto, acceso perdido, ya investigada). Hoy solo se muestra el motivo.
6. «Costo estimado · mes» no se puede calcular por frecuencia para estas tareas: hoy se dejan fuera de la suma. Hay que decidir qué mostrar.
7. «Se ejecuta como…» vale igual.

Si el dueño deja de ser central, la tarea se pausa sola, como cuando pierde el acceso al agente.
