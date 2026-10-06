# D72 · Los límites por IP alcanzan para una oficina detrás de una sola dirección, y `mango-api` renueva la sesión con la operación firmada

- **Estado:** vigente
- **Fecha:** 2026-10-06 (propuesta por un agente y aceptada por el dueño el mismo día; precisada ese día tras validarla en una instalación: puntos 11 a 14)
- **Precisa / reemplaza a:** precisa [D70](D070-dos-tareas-y-limites-compartidos.md) (4: los límites de la sesión ya no protegen un límite por IP, y la nota «con una salida compartida, revisar» queda resuelta), [D63](D063-sesion-web-con-cookie.md) (la sesión se crea y se renueva con la operación firmada; el margen del WAF del user pool queda medido), [D28](D028-implementacion-del-login-propio.md) (los números del WAF regional del user pool) y [D71](D071-alarmas-operativas-y-tablero.md) (1 y 5: `Edge-rate-limited` suma dos reglas y hay una alarma nueva para el WAF del user pool)
- **Precisada por:** —

## Decisión

Origen: hito 1, «instalable por una empresa real». El 2026-10-06 se midió cuántas peticiones hace una persona (navegador contra una instalación de laboratorio) y se cruzó con los límites por IP de los dos WAF. El dueño vio la propuesta ese día, eligió el diseño de abajo y aceptó este texto.

**(1) Qué se rompía y con cuánta gente.** Tres límites por IP, pensados para frenar a un atacante, los alcanzaba una empresa usando Mango con normalidad:

| Qué | Límite | Se rompía con |
|---|---|---|
| Renovar la sesión, **toda la instalación a la vez**: `mango-api` llamaba a la operación pública de Cognito desde las IP de sus tareas, y esas llamadas contaban como «operaciones con secreto» de esas IP | 300 por IP cada 5 min: 600 con dos tareas | Unas **500 personas** que entran en los mismos 5 minutos, vengan de donde vengan (250 con una salida compartida). Trabajando: unas 1.800 personas activas a la vez |
| Ingresar desde una oficina (WAF del user pool, IP del navegador) | 300 operaciones con secreto por IP cada 5 min | **100 ingresos** en 5 minutos desde una dirección (un ingreso con TOTP son 3 operaciones); 50 si es el primer ingreso |
| Usar la aplicación desde una oficina (WAF del borde) | 1.000 peticiones por IP cada 5 min, archivos de la web incluidos | **Entre 30 y 65 personas** que abren la aplicación a la vez justo después de una actualización (caché del navegador vacía: de 15 a 32 peticiones cada una); unas 65 trabajando a la vez |

Cuando saltaba el borde, CloudFront respondía un 403 que la web mostraba como falta de permiso. Cuando saltaba el del user pool, nadie se enteraba: no había alarma.

**(2) `mango-api` crea y renueva la sesión con la operación firmada con IAM.** `AdminInitiateAuth` con `REFRESH_TOKEN_AUTH`, en lugar de la pública `InitiateAuth`. Las operaciones firmadas con credenciales de AWS no pasan por el WAF del user pool: el techo de toda la instalación deja de ser un límite por IP y pasa a ser la cuota de Cognito (120 por segundo por cuenta, por defecto). Ya no importa cuántas tareas hay, si sus IP cambian ni si la red usa una salida compartida.

- **Comprobado antes de construir** (2026-10-06, en una instalación de laboratorio, con una persona de prueba): la operación devuelve tokens en un cliente que solo tiene los flujos SRP y refresh, sin activar ninguno más; los tokens traen los mismos *claims* que los del ingreso (mismo `sub`, mismo `auth_time`, sin el scope de autoservicio: el *pre-token* corre igual); un refresh token inválido, uno alterado y uno revocado responden `NotAuthorizedException`, como la operación pública; y de las llamadas hechas a la vez, las públicas aparecieron en las peticiones de muestra del WAF y las firmadas no.
- **Permiso nuevo:** el rol de la tarea gana `cognito-idp:AdminInitiateAuth`, solo sobre el user pool de la instalación.
- **Riesgo aceptado:** esa misma acción permite ingresar con usuario y contraseña desde el servidor en un cliente que tenga el flujo `ALLOW_ADMIN_USER_PASSWORD_AUTH`. El cliente web no lo tiene. Dos tests lo sostienen: en la infraestructura, que el cliente solo admite SRP y refresh, con un mensaje que dice por qué; en `mango-api`, que el único flujo que el código puede nombrar es la renovación. Activar otro flujo es revisar esta decisión.
- **Los límites `session.starts` y `session.renewals`** (10 por persona y 30 por sesión cada 5 minutos, por tarea) se quedan como están. Ya no protegen un límite por IP: frenan el bucle de una persona o de una pestaña antes de que gaste la cuota de Cognito, que es de toda la cuenta.
- `RevokeToken` (cerrar sesión) sigue siendo la operación pública: cuenta solo en el límite total, una vez por cierre.

**(3) Los números nuevos.** Por dirección IP, cada 5 minutos:

| Dónde | Antes | Ahora | A cuánta gente alcanza |
|---|---|---|---|
| Borde, regla nueva `ApiRateLimitPerIp`: solo lo que llega a `mango-api` (`/api/*`) | — | **6.000** | Unas 1.000 personas de una misma dirección entrando a la vez, o unas 400 trabajando a la vez (una oficina de unas 1.300 con el 30 % activo) |
| Borde, `RateLimitPerIp`: todo, archivos incluidos | 1.000 | **20.000** | Techo de lo demás: unas 1.300 personas de una dirección abriendo la aplicación con la caché vacía |
| User pool, operaciones con secreto | 300 | **1.500** | 500 ingresos por dirección (250 primeros ingresos) |
| User pool, total | 1.000 | **5.000** | Más del triple de «secretos»: los `OPTIONS` previos del navegador pueden contar aquí, y deja sitio al ingreso con SSO |
| User pool, operaciones que envían correo | 50 | **50** | Sin cambio: el remitente por defecto de Cognito envía 50 correos **al día** por cuenta; subir el límite solo ayudaría a agotarlos |

Lo que se abre a cambio: una dirección puede probar 750 contraseñas cada 5 minutos en vez de 150. Contra una cuenta no cambia nada (manda el bloqueo de Cognito, que tras 5 fallos hace esperar cada vez más); contra muchas cuentas va cinco veces más rápido, y sigue necesitando el TOTP, que es obligatorio. Hacia `mango-api` pasan hasta 20 peticiones por segundo desde una dirección: sin token son un 401 barato, y con token son de una persona identificada, con sus límites y su presupuesto.

Una oficina de más de unas 1.000 personas detrás de **una** dirección seguiría alcanzando el límite: es el caso del punto 6.

**(4) Constantes de la release, no parámetros.** La instalación tiene seis parámetros obligatorios y la regla es no pedir al cliente lo que no sabe contestar: nadie sabe cuántas peticiones por IP necesita su oficina antes de usar Mango. Los números se ajustan en una versión con lo que se vea en instalaciones reales, como los umbrales de las alarmas ([D71](D071-alarmas-operativas-y-tablero.md), 2).

**(5) Un bloqueo responde 429, no 403.** La regla de `/api/*` responde el mismo JSON que `mango-api` da para `rate_limited`, con `Retry-After`, y la web lo trata como cualquier otro límite. La regla general responde una página mínima, sin scripts ni estilos. `Retry-After` vale 60 segundos: el WAF no sabe cuándo bajará el recuento de esa dirección, así que un minuto después la petición pasa o recibe la misma respuesta. Los textos de las dos respuestas son provisionales: el diseño no cubre ese estado (D24) y van al próximo brief.

**(6) Por qué no otras salidas.**

- **Claves distintas de la IP** (IP más la cabecera `Authorization`, o más la cookie de sesión): quien inventa valores abre un contador nuevo en cada petición, así que la regla no frena a un atacante, solo a clientes honestos; y una petición sin esa cabecera no la evalúa. Haría falta igualmente una regla solo por IP detrás. Lo que sí harían bien, acotar a un cliente honesto con un bucle, ya lo hace `mango-api` por persona. En el user pool no hay cabecera que identifique a la persona.
- **Redes de confianza** (un límite alto, o ninguno, para los rangos de la empresa; o que solo esas redes puedan entrar): **ahora no.** Piden un parámetro nuevo y que alguien mantenga los rangos. Se decide cuando un cliente lo pida, como decisión aparte. La variante «solo estas redes» necesitaba antes el punto 2: con la operación pública habría bloqueado a las propias tareas.

**(7) Alarmas.** `Edge-rate-limited` suma los bloqueos de las dos reglas por IP del borde. La alarma nueva `Cognito-rate-limited` suma los de las tres reglas por IP del user pool, con el mismo umbral (50 bloqueos en 5 minutos) y los criterios de [D71](D071-alarmas-operativas-y-tablero.md): datos ausentes no cuentan, la descripción dice qué mirar primero y los bloqueos de las reglas gestionadas siguen sin alarmar. Las métricas de un web ACL regional llevan la dimensión `Region`; las del de CloudFront, no.

**(8) Costo y tamaño.** Una regla más en el borde (USD 1 al mes) y cuatro métricas más de alarma (USD 0,40). El web ACL del borde usa 931 unidades de capacidad y el del user pool 269; el precio base cubre 1.500 y el máximo es 5.000. Un recurso más en `Core` (la alarma). Sin parámetros nuevos, sin supresiones nuevas de cdk-nag, cfn-guard ni Checkov y sin excepciones nuevas a las reglas de seguridad.

**(9) Lo que queda fuera.** La web deja de sacar a la persona al ingreso cuando la renovación no responde (es un defecto aparte, en otra rama). La cuota de 50 correos al día del remitente por defecto frena un alta de más de 50 personas en un día antes que cualquier WAF: pide SES, como ya decía TM-L11. Los eventos de riesgo de Cognito Plus de las renovaciones registran la IP de la tarea y no la de la persona; la operación firmada permite pasársela (`ContextData`) y no se hace todavía.

**(10) Pendiente de comprobar en una instalación.** Que la sesión se crea y se renueva con la versión instalada; que las llamadas de las tareas ya no aparecen en el WAF del user pool; y que cada bloqueo responde lo previsto y dispara su alarma, provocado desde otra dirección. Las cifras de uso (30 % de la oficina activa, 15 peticiones por persona cada 5 minutos) son supuestos razonados, no datos de una empresa: las métricas por regla darán el dato real con el primer cliente. Al aceptar la decisión, el dueño preguntó si el límite de la API hacía falta y lo mantuvo en 6.000: protege a dos tareas pequeñas cuya capacidad nadie ha medido, y se revisa con una prueba de carga, que sigue pendiente en este hito.

**(11) Precisión del 2026-10-06 al punto 3: los números son aproximados.** Medido ese día en una instalación de laboratorio, con ráfagas desde una sola dirección. Una regla por tasa de AWS WAF no bloquea al llegar al número: empieza un rato después de cruzarlo, y hasta entonces deja pasar todo.

| Regla | Límite | Ritmo de la ráfaga | Pasaron antes del primer bloqueo | De más | Retraso desde que se cruzó el límite |
|---|---|---|---|---|---|
| Borde, `ApiRateLimitPerIp` | 6.000 | 40 por segundo | 7.380 | 23 % | 34 s |
| User pool, operaciones con secreto | 1.500 | 12 por segundo | 1.993 | 33 % | 41 s |
| Borde, `RateLimitPerIp` | 20.000 | 100 por segundo | 25.195 | 26 % | 52 s |

- **Frente a una ráfaga, el techo real es el límite más lo que quepa en ese retraso** (entre 34 y 52 segundos en las tres pruebas). A un ritmo mayor que los probados pasa más, en proporción.
- **Con un ritmo apenas por encima del límite puede no bloquear nunca.** 1.760 operaciones con secreto a 5,5 por segundo, contra el límite de 1.500, pasaron todas: el recuento de los últimos 5 minutos llegó a unas 1.650 y la ráfaga terminó antes de que el WAF actuara.
- **El bloqueo no dura un tiempo fijo.** Se levanta cuando el recuento de los últimos 5 minutos de esa dirección baja del límite: 150, 180 y 90 segundos después de que bajó el tráfico, en las tres pruebas.
- **Qué cambia.** Ningún número: los límites siguen siendo los del punto 3 y siguen alcanzando para lo que dice su tabla. Cambia cómo se leen: son el punto a partir del cual el WAF empieza a actuar, no un máximo exacto. Las cuentas que parten de ellos (por ejemplo, las «750 contraseñas por IP cada 5 minutos» del punto 3) son un mínimo frente a una ráfaga; el detalle está en el modelo de amenazas del login, TM-L3.
- Es el comportamiento de las reglas por tasa de AWS WAF, no algo que Mango pueda ajustar.

**(12) Precisión del 2026-10-06 al punto 5: la espera que anuncia un bloqueo es de 180 segundos.** La eligió y aprobó el dueño ese día, al ver la validación. Con `Retry-After: 60`, quien reintentaba al minuto volvía a recibir el rechazo, y su intento volvía a contar: el bloqueo se levantó entre 90 y 180 segundos después de bajar el tráfico (punto 11). `Retry-After` vale ahora 180 segundos en las dos respuestas del borde y la página provisional dice «Espera unos minutos». Sigue siendo una espera fija: el WAF no sabe cuándo bajará el recuento, así que pasado ese tiempo la petición pasa o recibe la misma respuesta. El 403 del WAF del user pool no cambia. Los textos siguen siendo provisionales (D24).

**(13) Precisión del 2026-10-06: la CSP de una respuesta de bloqueo es la de la aplicación.** El web ACL del borde declaraba para sus dos respuestas una CSP cerrada (`default-src 'none'; frame-ancestors 'none'`). En la instalación llegó otra: la de la aplicación. La política de cabeceras de CloudFront se aplica también a lo que responde el WAF y, como reemplaza el valor que encuentre, gana. El código prometía algo que no se entregaba.

- **Qué se hace.** El web ACL ya no declara esa cabecera. Las otras tres (`Retry-After`, `Cache-Control: no-store` y `X-Content-Type-Options: nosniff`) llegan como se declaran. Además llegan las de la política de CloudFront: HSTS, `X-Frame-Options: DENY`, `Referrer-Policy` y `Permissions-Policy`.
- **Qué recibe el navegador.** Lo mismo que antes de este cambio: la CSP de la aplicación, que no permite scripts ni estilos en línea, ni orígenes ajenos, ni que la página se muestre en un marco. La página de bloqueo no trae scripts, estilos, enlaces ni formularios.
- **De qué depende.** De que la política de cabeceras siga puesta en todos los comportamientos de la distribución, con su CSP y reemplazando. Un test lo fija en la plantilla; lo entregado se vio en la instalación, no lo comprueba un test.
- **Si algún día se quiere la CSP cerrada de verdad** en las respuestas de bloqueo, se decide en la política de CloudFront, no en el WAF.

**(14) Lo que se comprobó del punto 10 (2026-10-06, en una instalación de laboratorio), y lo que no.**

- **La sesión con la operación firmada.** Cuatro sesiones de tres personas de prueba, en un navegador, con recargas, una segunda pestaña y cierre: se crearon y se renovaron con la versión instalada. CloudTrail registró 26 `AdminInitiateAuth`, todas del rol de la tarea y sin errores (4 sesiones creadas y 22 renovaciones). En las peticiones de muestra del WAF del user pool no hubo ninguna `InitiateAuth` desde las tareas: de sus direcciones solo salieron los `RevokeToken` de cada cierre. Ningún 503 de sesión en el log de `mango-api`.
- **Los tres bloqueos, provocados desde otra dirección.** La regla de `/api/*` respondió 429 con el JSON de `rate_limited`; la regla general, 429 con la página (también en `/api/*`, cuando es ella la que bloquea); el user pool, 403 `ForbiddenException`. Las dos respuestas del borde llevaban `Retry-After`, `Cache-Control: no-store` y `X-Content-Type-Options: nosniff` como se declaran. Mientras duró el bloqueo de la regla de `/api/*`, la regla general no saltó y otra dirección siguió usando la aplicación; con el del user pool, una persona ingresó desde otra dirección.
- **Las dos alarmas y sus métricas.** `Edge-rate-limited` avisó dos veces (una por cada regla del borde) y `Cognito-rate-limited` una, cerca de un minuto después del primer bloqueo; las tres volvieron solas a `OK` a los 5 minutos. Las métricas de bloqueos existen con las dimensiones exactas que leen las alarmas (sin `Region` las del borde, con `Region` la del user pool) y sus sumas cuadraron con lo que contó quien hacía las peticiones. La suma de `Cognito-rate-limited` dio valor con una sola de sus tres reglas con datos.
- **Sin probar.** Cómo se ve un bloqueo en un navegador, con la página y dentro de la aplicación: solo se vio como respuesta HTTP. Las reglas de correo y total del user pool (`EmailOperationsPerIp` y `RateLimitPerIp`): no se provocaron y sus métricas todavía no existen. Y siguen pendientes, como decía el punto 10, las cifras de uso de una empresa real y la prueba de carga.
