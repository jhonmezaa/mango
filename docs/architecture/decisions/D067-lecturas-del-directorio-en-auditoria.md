# D67 · Las lecturas del directorio se leen en palabras en Auditoría, y un cambio de quien ya no está no se aprueba

- **Estado:** vigente
- **Fecha:** 2026-10-05
- **Precisa / reemplaza a:** precisa [D62](D062-proveedores-de-correo-publico.md) y [D66](D066-cambios-de-personas-fuera-del-directorio.md)
- **Precisada por:** [D68](D068-filtro-de-busqueda-y-espera-de-cambios.md) (precisa; sustituye la relectura única del punto 4)
- **Tema en el registro original:** Las lecturas del directorio se leen en palabras en Auditoría, y un cambio de quien ya no está no se aprueba (precisa [D62](D062-proveedores-de-correo-publico.md) y [D66](D066-cambios-de-personas-fuera-del-directorio.md))

## Decisión

Origen: la ronda de Claude Design del 2026-10-05 (duodécima) respondió lo visto en una instalación.

**(1) `directory.list` con frase propia:** la búsqueda de personas lleva `scope: people` en su detalle, junto a `scope: changes` de la lista de cambios ([D66](D066-cambios-de-personas-fuera-del-directorio.md) (3)); no es un dato nuevo, solo nombra qué lectura fue. La pantalla muestra «Buscó personas · n resultados» o «Leyó los cambios de personas · n cambios · m de personas que ya no están» y una sección «Lectura» en el panel, nunca las claves crudas ni el resultado de la lectura. Una búsqueda escrita antes de este cambio se reconoce por `searched`.

**(2) El texto buscado sigue sin registrarse:** el diseño admite mostrarlo «si la instalación lo registra»; la excepción de [D60](D060-gestion-de-personas.md) (5) dice que nunca, así que la frase es «Buscó por texto · n resultados». `filter` se sigue registrando y no se muestra: el diseño no lo nombra.

**(3) Cambio pendiente de una persona que ya no está (`target_in_directory: false`):** la tarjeta no ofrece «Aprobar»; dice por qué y ofrece «Rechazar» con el motivo ya escrito, editable. Es solo para mostrar: la API ya rechaza esa aprobación con 404 `user_not_found`, que ahora tiene texto propio. Con `null` (no se sabe) la tarjeta no cambia.

**(4) Relectura tras un rechazo:** después de `busy`, de «ya no está pendiente» o de `user_not_found`, la pantalla vuelve a leer la lista de cambios y conserva el aviso. Tras `busy` lee al momento y otra vez a los 3 s: el otro cambio de administradores todavía se está aplicando cuando llega el rechazo, y la primera lectura puede verlo aún pendiente. Cada relectura es una lectura auditada y cuenta para el límite de 120 por minuto.

La API no expone nada nuevo; TM-P21 no cambia
