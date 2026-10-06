# Comprobar una instalación (`tests/install`)

Recorridos en un navegador real (Playwright) contra una instalación de Mango: lo que el mock no puede probar (Cognito, CSP, cookies, AgentCore). Se corre con un comando, tras instalar o actualizar, y deja un informe **fuera del repositorio**.

```sh
export MANGO_INSTALL_CONFIG=~/.config/mango/install.json
mise run install-check                              # solo lectura
MANGO_INSTALL_EFFECTS=all mise run install-check    # además, los recorridos con efecto
```

En CI no corre contra nada (no hay instalación): solo pasan su lint, sus tipos y los tests unitarios de sus piezas (`pnpm -r run lint|typecheck|test`).

## Configuración

Un archivo JSON local, fuera del repositorio, cuya ruta va en `MANGO_INSTALL_CONFIG`. [`config.example.json`](config.example.json) muestra la forma, con marcadores.

| Campo         | Qué es                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`     | Origen de la instalación (output `AppUrl` de `Mango-<ns>-Core`), con `https`                                                                                                                                                                                                 |
| `secretsFile` | Ruta (relativa al archivo de configuración) de un JSON `{ "<correo>": { "password": "…", "totp": "<secreto base32>" } }`. Es el mismo formato que usa `tests/e2e/smoke.py --secrets`. La configuración solo apunta a él: los secretos no se copian                           |
| `outputDir`   | Dónde van los informes y las capturas. Por defecto `~/.config/mango/install-check`                                                                                                                                                                                           |
| `users`       | Un usuario de prueba por papel: `admin`, `secondAdmin`, `creator` (tiene `mango-agent-creator`), `areaMember` (líder o miembro de un área), `plain` (sin grupos de privilegio). Los papeles son opcionales: lo que necesita uno que falta se salta y el informe dice por qué |
| `release`     | Opcional. Etiqueta que la instalación debe mostrar (`v0.1.0-g…`); sin ella, solo se anota la que muestra                                                                                                                                                                     |
| `chat`        | Para el recorrido con efecto `chat`: papel que pregunta, nombre del agente y una pregunta corta que lo obligue a usar una tool                                                                                                                                               |
| `people`      | Para el recorrido con efecto `people`: dominio de la persona desechable. Debe terminar en `.invalid` (nunca recibe correo, no es de nadie)                                                                                                                                   |
| `aws`         | Opcional. Perfil de la AWS CLI con permiso para borrar a la persona desechable en el directorio (`cognito-idp:AdminGetUser` y `AdminDeleteUser`). El directorio y la región se leen de la instalación                                                                        |

Reglas que el código impone: la configuración, el archivo de secretos y el directorio de salida no pueden estar dentro del repositorio; un error de configuración nombra el campo, nunca su valor.

**Usuarios de prueba, nunca personas reales ni la cuenta del dueño de la instalación.** Cada uno necesita contraseña fija y MFA (TOTP) ya registrado.

## Qué comprueba

Vigilancia común a todos los recorridos: fallan ante una violación de CSP, un error de JavaScript, una respuesta 5xx, o un 4xx que el recorrido no declaró como esperado.

**Solo lectura** (por defecto; deja eventos de ingreso y de lectura en Auditoría):

| Archivo           | Recorrido                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-headers`      | Cabeceras de seguridad de la página y de la API, la API rechaza sin sesión, `config.json` sin secretos y con MFA obligatorio                                                                                                                                                            |
| `02-session`      | Ingreso con contraseña y TOTP; atributos de la cookie de sesión; nada de la sesión en Web Storage; la recarga conserva la sesión; cerrar sesión deja fuera a la otra pestaña                                                                                                            |
| `03-access`       | Por cada papel: pantallas de administración según el papel, en la pantalla y en la API; el Marketplace muestra los agentes que la API devuelve; el Org Chart muestra «Editar», «No puedes usar este agente» y «Ver en Marketplace» según `can_edit` y `can_use`; sin personas nombradas |
| `04-audit`        | Auditoría con sus etiquetas en palabras, sin claves crudas, con y sin «Mostrar lecturas»                                                                                                                                                                                                |
| `05-installation` | Ajustes › Instalación muestra la release                                                                                                                                                                                                                                                |
| `99-closing`      | Cada sesión que la corrida abrió tiene su cierre en Auditoría                                                                                                                                                                                                                           |

**Con efecto** (solo si se piden con `MANGO_INSTALL_EFFECTS=chat`, `people`, `chat,people` o `all`):

| Efecto   | Recorrido                                                                                                                                                                                                 | Qué deja                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`   | Una pregunta corta al agente, respondida con una tool                                                                                                                                                     | Gasta presupuesto de quien pregunta. Una conversación en su historial (la API no la borra) y sus eventos en Auditoría                                                                                                                                                               |
| `people` | Una persona **desechable** que la prueba invita: un grupo sensible que necesita la aprobación del segundo administrador (en la pantalla), y la carrera de dos administradores aprobando a la vez (`busy`) | La persona se cierra siempre: sin cambios pendientes, sin grupos y deshabilitada; con `aws` configurado y credenciales vigentes, borrada. Sin credenciales queda deshabilitada, el informe lo dice y la prueba no falla. Quedan las tarjetas de sus cambios (30 días) y sus eventos |

Ningún recorrido toca a una persona, un grupo o un agente que no haya creado.

## Salida y secretos

- En `outputDir/<fecha>/`: `informe.md` (URL enmascarada, release, qué pasó, qué se saltó y por qué, qué quedó en la instalación), `resultado.json` y, si algo falló, `capturas/`.
- Todo lo que se imprime o se escribe pasa por un enmascarado: correos (los de los usuarios de prueba salen como `<admin>`, `<areaMember>`…), el host, ids de cuenta, de organización y de directorio, ARNs, UUIDs y tokens. Las capturas tapan correos e ids.
- **Sin trazas ni video de Playwright:** guardan la cookie de sesión, los tokens y el código TOTP tal como se escribió. No hay opción para activarlos.
- La contraseña y el secreto TOTP se leen al ingresar y no se guardan; el token de la sesión vive solo en memoria; la sesión no se escribe a disco (`storageState` está prohibido por lint).
- Un código TOTP no se reutiliza: `outputDir/.totp-windows.json` recuerda la última ventana de 30 s que usó cada persona (bajo un hash del correo, sin secretos) y el siguiente ingreso espera a la ventana nueva. Por eso dos corridas seguidas funcionan, a costa de unos segundos de espera.
- Cada sesión se cierra aunque el recorrido falle; si el menú de la cuenta no responde, se cierra con la misma petición que enviaría.

## Relación con las otras pruebas

| Carpeta          | Contra qué                                | Qué prueba                                                                                                                                                |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/e2e`   | El mock local (`vite --mode mock`), en CI | Los flujos de la SPA sin AWS. No ve Cognito, la CSP de CloudFront, la cookie real ni AgentCore                                                            |
| `tests/e2e/*.py` | Una instalación, por la API               | La batería que **cambia** la instalación: crea agentes, habilita packs, fija contraseñas, prueba el acceso entre cuentas. Solo en instalaciones de prueba |
| `tests/install`  | Una instalación, por el navegador         | Lo que una persona ve tras instalar o actualizar. Solo lectura salvo que se pida lo contrario                                                             |

## Añadir un recorrido

- Selectores por rol y nombre accesible; nada de esperas fijas (`waitForTimeout` está prohibido por lint): se espera una respuesta o un elemento.
- La sesión de un papel se pide con `as('admin')`; si necesita ingresar y salir por su cuenta, `ownBrowser()` y un `finally` que cierre.
- Un 4xx provocado a propósito se declara con `expect4xx`.
- Lo que deja en la instalación se escribe con `leaves(testInfo, '…')`; si tiene efecto, empieza por `needsEffect('…')` y restaura en un `finally`.
- Nada se imprime con `console`: el único que escribe es el reporter, que enmascara.
