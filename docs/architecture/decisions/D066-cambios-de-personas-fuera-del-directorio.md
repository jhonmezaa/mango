# D66 · La lista de cambios de personas dice quién ya no está en el directorio

- **Estado:** vigente
- **Fecha:** 2026-10-04
- **Precisa / reemplaza a:** precisa [D60](D060-gestion-de-personas.md) (5) y [D62](D062-proveedores-de-correo-publico.md) (6)
- **Precisada por:** [D67](D067-lecturas-del-directorio-en-auditoria.md) (precisa); [D70](D070-dos-tareas-y-limites-compartidos.md) (precisa: su límite de lecturas se cuenta entre todas las tareas)
- **Tema en el registro original:** La lista de cambios de personas dice quién ya no está en el directorio (precisa [D60](D060-gestion-de-personas.md) (5) y [D62](D062-proveedores-de-correo-publico.md) (6))

## Decisión

Origen: el diseño muestra «Ya no está en el directorio» en las tarjetas de «Cambios de personas» y la API no lo informaba.

**(1)** Cada cambio de `GET /api/admin/people/changes` (y de la lista con la que responde una decisión) lleva `target_in_directory`: `true`, `false` o `null` cuando no se sabe. La tarjeta conserva el correo: es historial.

**(2) Excepción ampliada (decisión del usuario):** la excepción de [D60](D060-gestion-de-personas.md) (5) a «sin revelar si un usuario existe» cubre también este dato, solo para administradores (`ViewPeople`), que ya pueden buscar a esa persona en el directorio.

**(3) Mismos controles que una lectura del directorio:** el GET usa el límite de 120 lecturas por minuto por administrador, compartido con la búsqueda, y se audita como `directory.list` con conteos (`scope: changes`, cuántos cambios y cuántos sin persona), nunca correos; sin auditoría no hay lectura (503). La lista que devuelve una decisión no gasta lectura ni deja ese evento: la decisión ya queda auditada.

**(4) Costo acotado:** se responde con la copia en memoria del directorio que ya usa la lista de personas (30 s), sin consulta por cambio. Solo si el directorio no cabe en una lectura (más de 2000 personas) se consulta a Cognito por las personas que no salieron en ella, primero las de los cambios pendientes y como mucho 20 por lectura (lo consultado se conserva los mismos 30 s, así que releer no vuelve a preguntar); las demás quedan en `null` y la pantalla no afirma nada. Si el directorio no se puede leer, los cambios se listan igual con `null`: decidir no depende de este dato.

**(5) Efecto conocido:** una persona borrada por fuera de Mango puede seguir como presente hasta 30 s, igual que en la lista ([D62](D062-proveedores-de-correo-publico.md) (6)).

Registrada en `AGENTS.md`; TM-P21
