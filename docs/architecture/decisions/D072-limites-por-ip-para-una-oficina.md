# D72 · Los límites por IP alcanzan para una oficina detrás de una sola dirección, y `mango-api` renueva la sesión con la operación firmada

- **Estado:** propuesta
- **Fecha:** 2026-10-06
- **Precisa / reemplaza a:** precisa [D70](D070-dos-tareas-y-limites-compartidos.md) (4: los límites de la sesión ya no protegen un límite por IP, y la nota «con una salida compartida, revisar» queda resuelta), [D63](D063-sesion-web-con-cookie.md) (la sesión se crea y se renueva con la operación firmada; el margen del WAF del user pool queda medido) y [D28](D028-implementacion-del-login-propio.md) (los números del WAF regional del user pool)
- **Precisada por:** —

## Decisión

Origen: hito 1, «instalable por una empresa real». El 2026-10-06 se midió cuántas peticiones hace una persona (navegador contra una instalación de laboratorio) y se cruzó con los límites por IP de los dos WAF. El dueño vio la propuesta ese día y eligió el diseño de abajo. Queda `propuesta` hasta que acepte este texto.

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

**(8) Costo y tamaño.** Una regla más en el borde (USD 1 al mes) y cuatro métricas más de alarma (USD 0,40). El web ACL del borde usa 961 unidades de capacidad y el del user pool 269; el precio base cubre 1.500 y el máximo es 5.000. Un recurso más en `Core` (la alarma). Sin parámetros nuevos, sin supresiones nuevas de cdk-nag, cfn-guard ni Checkov y sin excepciones nuevas a las reglas de seguridad.

**(9) Lo que queda fuera.** La web deja de sacar a la persona al ingreso cuando la renovación no responde (es un defecto aparte, en otra rama). La cuota de 50 correos al día del remitente por defecto frena un alta de más de 50 personas en un día antes que cualquier WAF: pide SES, como ya decía TM-L11. Los eventos de riesgo de Cognito Plus de las renovaciones registran la IP de la tarea y no la de la persona; la operación firmada permite pasársela (`ContextData`) y no se hace todavía.

**(10) Pendiente de comprobar en una instalación.** Que la sesión se crea y se renueva con la versión instalada; que las llamadas de las tareas ya no aparecen en el WAF del user pool; y que cada bloqueo responde lo previsto y dispara su alarma, provocado desde otra dirección. Las cifras de uso (30 % de la oficina activa, 15 peticiones por persona cada 5 minutos) son supuestos razonados, no datos de una empresa: las métricas por regla darán el dato real con el primer cliente.
