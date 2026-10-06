# D22 · Marketplace: compartir, retirar, modelos y presupuesto del agente

- **Estado:** parcial. Construidos el retiro, el modelo por turno y el acceso por revisión. Faltan editar el presupuesto del agente en Presupuestos (ver [D17](D017-admin-v0.md)) y las evals por modelo ([D38](D038-alcance-de-marketplace-v1.md) las aplaza).
- **Fecha:** 2026-09-30
- **Precisa / reemplaza a:** —
- **Precisada por:** [D38](D038-alcance-de-marketplace-v1.md) (sigue para «Compartir»)

## Decisión

**Compartir** es un cambio de grupos o usuarios que pasa por revisión ([D18](D018-creacion-y-publicacion-de-agentes.md)): los creadores comparten con usuarios o grupos concretos; **solo admins** comparten con toda la organización, también con aprobación de otro admin, y nunca si el agente usa "Datos de cuentas". Sin invitaciones a correos fuera del directorio ni rol "Puede editar". Los agentes no se eliminan ni se archivan: un admin los **retira** y se conserva el historial.

**Modelo en el chat:** la versión aprobada define la lista de modelos permitidos y el usuario elige entre ellos; el presupuesto se reserva con el precio del modelo elegido y las evals obligatorias corren con cada modelo de la lista.

**El presupuesto del agente** se edita solo en Presupuestos (admins); el Builder lo muestra en solo lectura y los agentes nuevos arrancan con el límite por defecto. El catálogo de MCP muestra como "conectores de Mango" solo los que existen
