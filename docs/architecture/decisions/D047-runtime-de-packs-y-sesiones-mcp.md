# D47 · Runtime de los packs: tiempo de inactividad de 60 s, y sesiones MCP en el Gateway

- **Estado:** vigente
- **Fecha:** 2026-10-01 · punto (4b) del 2026-10-02
- **Precisa / reemplaza a:** —
- **Precisada por:** —

## Decisión

**Contexto (S-M5, medido en el laboratorio).** Cada llamada a una tool de un pack arrancaba una microVM nueva (4 a 6 s) que seguía facturando memoria los 900 s del tiempo de inactividad por defecto: USD 0,003 a 0,005 por llamada. En caliente el servidor responde en 0,5 s.

**(1) Inactividad de 60 s en el Runtime de cada pack.** El provisioner de packs crea cada versión del Runtime con `lifecycleConfiguration`: `idleRuntimeSessionTimeout` de 60 s (el mínimo de AgentCore) y `maxLifetime` de 28 800 s (el valor por defecto, escrito a propósito). Son constantes del provisioner, no configuración de la instalación. Una microVM deja de facturar un minuto después de su última llamada; la latencia no cambia.

**(2) Runtimes ya instalados.** El cambio altera la huella de configuración, pero no hay migración automática: el provisioner solo actúa con una habilitación aprobada, y una versión nueva del Runtime debe pasar la comparación de `tools/list` antes de recibir tráfico. Un Runtime instalado sigue con 900 s hasta la siguiente ejecución aprobada de ese pack (actualizar, cambiar parámetros, o deshabilitar y volver a habilitar); esa ejecución crea una versión nueva con los 60 s y mueve `live` a ella. Mientras tanto la diferencia es solo de costo.

**(3) Sesiones MCP en el Gateway.** El Gateway se crea con `protocolConfiguration.mcp.sessionConfiguration` y un tiempo de sesión de 900 s (el mínimo; cuenta desde el `initialize`). Dentro de una sesión el Gateway guarda la sesión de cada target MCP y la reutiliza: la segunda llamada de un turno al mismo pack va a la misma microVM. Una invocación dura como máximo 600 s y su firma vence 60 s después, así que la sesión nunca tiene que durar más.

**(4) Efecto en todas las tools.** Con sesiones, el Gateway responde 400 a cualquier petición posterior al `initialize` que no lleve el `Mcp-Session-Id` que emitió, también para las tools de FinOps, y 404 si la sesión venció o es de otro usuario (la liga al `sub` del token). El harness de AgentCore es un cliente MCP estándar y `mango-api` le pasa cabeceras nuevas en cada invocación, así que abre una sesión por invocación. La documentación no describe el manejo de sesiones del harness: se comprueba en el laboratorio tras desplegar (`docs/runbooks/poc-deploy.md`).

**(4b) `mango-api` también es cliente MCP (2026-10-02).** Al ejecutar una llamada de escritura aprobada ([D27](D027-confirmacion-de-escritura-por-tramos.md)), `mango-api` llama al Gateway sin el harness: abre su propia sesión (`initialize`, `notifications/initialized`) y envía el `tools/call` con el `Mcp-Session-Id` recibido. Medido en el laboratorio: sin sesión el Gateway responde 400 (`Missing required Mcp-Session-Id header`), y lo hace **después** de pasar por el interceptor, que ya gastó la aprobación; la solicitud quedaba fallida sin haberse ejecutado. Por eso el token de aprobación solo viaja en el `tools/call`: si la sesión no abre, nada se ejecutó, la aprobación sigue sin usar y la solicitud vuelve a «aprobada». Si el `initialize` no devuelve `Mcp-Session-Id` (Gateway sin sesiones), la llamada va sin esa cabecera.

**(5) Lo que no cambia.** Cada petición sigue pasando por la autenticación del Gateway, el interceptor (token y firma v2 por petición) y Cedar. El interceptor no necesitó cambios. Un target no puede propagar `Mcp-Session-Id` por su cuenta: con sesiones, AgentCore rechaza esa configuración.

**(6) Vuelta atrás por configuración (regla 8).** `gateway.mcpSessions` en la configuración de la instalación, `true` por defecto; con `false` el Gateway queda sin sesiones, como antes.

**(7) Primera llamada de cada turno.** Sigue en frío: la sesión es por invocación.

**Riesgo aceptado.** Dentro de una sesión, una microVM de un pack atiende varias llamadas del mismo usuario en el mismo turno (antes, una microVM por llamada); nunca las de otro usuario.

Amenaza TM-B21 en `docs/security/threat-models/mcp-pack-provisioner-threat-model.md`
