# D68 · El filtro de la búsqueda de personas se nombra en Auditoría, la pantalla espera al otro cambio de administradores y «Respuesta completa» solo avisa a quien no ve el final

- **Estado:** vigente
- **Fecha:** 2026-10-05
- **Precisa / reemplaza a:** precisa [D67](D067-lecturas-del-directorio-en-auditoria.md)
- **Precisada por:** —
- **Tema en el registro original:** El filtro de la búsqueda de personas se nombra en Auditoría, la pantalla espera al otro cambio de administradores y «Respuesta completa» solo avisa a quien no ve el final (precisa [D67](D067-lecturas-del-directorio-en-auditoria.md))

## Decisión

Origen: la ronda de Claude Design del 2026-10-05 (decimotercera) respondió cinco precisiones.

**(1) El filtro se muestra:** la frase de `directory.list` es «Buscó personas» o «Buscó por texto», luego el filtro si no es «Todas» y luego el conteo («Buscó personas · Sin acceso · 3 resultados»); la sección «Lectura» lleva «Filtro» siempre. Es el `filter` que la API ya registraba ([D67](D067-lecturas-del-directorio-en-auditoria.md) (2)): no es un dato nuevo ni cambia la API. El texto buscado sigue sin registrarse ni mostrarse ([D60](D060-gestion-de-personas.md) (5)).

**(2) Después de `busy`:** la pantalla lee la lista de cambios al momento y luego cada 3 s, hasta que un cambio de administradores cambie de estado o pasen 30 s (sustituye la única relectura a los 3 s de [D67](D067-lecturas-del-directorio-en-auditoria.md) (4)). Mientras tanto, las tarjetas de cambios de administradores no ofrecen «Aprobar» ni «Rechazar» y dicen «Otro cambio se está aplicando…»; «Retirar» sigue. Es solo para mostrar: la API sigue respondiendo `busy`. Cada relectura lee solo la lista de cambios (no el directorio), es una lectura auditada y cuenta para el límite de 120 por minuto: como mucho 10 por cada `busy`. **Qué es un cambio de administradores en la pantalla:** el del grupo de administradores y los de deshabilitar o habilitar; un cambio no dice si su persona es administradora, y la API no expone nada nuevo para saberlo.

**(3) «Respuesta completa»:** el aviso sale solo si la pestaña está en segundo plano o la persona subió más de 80 px en la conversación; si ve el final, no sale y el fin de la respuesta se anuncia a lectores de pantalla en una región `aria-live`. Salir del chat detiene la respuesta, así que el caso «está en otra pantalla» del diseño no existe en el producto.

**(4) Avisos:** la pila no capta clics fuera de sus avisos.

La API no cambia; TM-P21 no cambia
