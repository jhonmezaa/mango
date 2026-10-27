# Perfiles de MCP remoto

Un **perfil de MCP remoto** es lo que una release de Mango permite de un servidor MCP de terceros que no corre en AWS, como el de Azure DevOps (D93, D98 (14)). No hay código que construir ni que ejecutar: el perfil se convierte en el esquema y las cabeceras de un target del Gateway, y el token de cada persona vive en el vault de AgentCore Identity.

Aquí viven los perfiles y su pipeline. Registrar un perfil en una instalación (proveedor de Identity, target, políticas e ítem firmado) es trabajo de `mango-api` y del provisioner de remotos, que todavía no existen.

Modelo de amenazas: `docs/security/threat-models/remote-mcp-threat-model.md`.

## Qué hay en un perfil

```
remotes/<id>/
├── profile.yaml       # qué es el servicio y qué se permite de él
└── tool-schema.json   # {"tools": [...]}: el mcpToolSchema del target, tal como lo devolvió el servidor
```

El esquema de `profile.yaml` es `RemoteProfile` en `packages/py/mango-packs/src/mango_packs/remote.py`. Es estricto: un campo desconocido es un error.

| Campo | Regla |
|---|---|
| `id` | `^[a-z][a-z0-9-]{1,23}$`, igual que su carpeta |
| `version` | `<fecha de la lista de tools capturada>-<revisión de Mango>`, p. ej. `2026.10.27-1` |
| `data_leaves_aws` | Siempre `true` en v1: el catálogo y el agente lo dicen |
| `endpoint` | `host` fijo, sin comodín ni IP; `path` solo puede ser `/{organization}`. El patrón de la organización es una constante del código (D93 (5)), nunca del perfil |
| `link_hosts`, `link_org` | Para clasificar los enlaces del servicio (diseño A1) |
| `provider` | `vendor: MicrosoftOauth2` (así lo escribe botocore), scopes de lectura y lo que la ficha muestra en «Permisos» |
| `forced_headers` | Exactamente `X-MCP-Readonly: "true"` y `X-MCP-Toolsets: "{toolsets}"`. Nunca `Authorization`: pisaría el token del vault |
| `toolsets` | Lo que un administrador puede elegir. Cada uno con su valor de `X-MCP-Toolsets` (`header`), salvo los `always`, que pueden no tenerlo. Dos toolsets no comparten valor |
| `probe` | La tool del sondeo de «Conectar»; debe estar en un toolset `always` |
| `tools` | Una por tool del esquema, con su toolset y `access: read`. Otra clase, o ninguna, hace fallar el check (D84 (5)) |
| `tools_sha256` | sha256 del JSON canónico de `tool-schema.json` (`mango_packs.canonical`) |
| `max_result_chars` | Recorte de cada resultado en el interceptor `RESPONSE` |

`X-MCP-Toolsets` se arma con los valores de los toolsets elegidos más los `always`, en el orden del perfil (`mango_packs.remote.forced_headers`). Un registro tiene que elegir al menos un toolset con valor: sin la cabecera, el servidor sirve todos sus toolsets.

## Check y firma

`mango-pack-builder remote check remotes/<id>` corre sin red ni AWS y falla si:

- una tool no es `read`, o no tiene clase;
- `tools` y `tool-schema.json` no traen los mismos nombres, o el hash no coincide;
- un nombre de tool no cumple `^[A-Za-z][A-Za-z0-9_-]{0,63}$`;
- una tool está fuera de un toolset declarado, un toolset no tiene tools o la del sondeo no está en uno `always`;
- el host lleva comodín o es una IP;
- `forced_headers` trae algo distinto de las dos cabeceras;
- el esquema trae una anotación MCP que lo contradice (`readOnlyHint: false` o `destructiveHint: true`; D84 (4));
- el esquema pasa de 1 MB (la cuota de esquema inline de un target).

El workflow `packs` (`.github/workflows/packs.yml`) arranca también con un cambio en `remotes/**`:

1. `remote-build` (sin secretos ni AWS): corre el check y `remote build`, que escribe la declaración (`dist/remotes/<id>-<versión>.statement.json`). La declaración lleva el perfil, el esquema entero y el commit.
2. `remote-sign` (solo en un `push` a `main`, en el entorno `pack-signing`, con la aprobación del dueño): vuelve a escribir la declaración desde el commit, exige que sea idéntica byte a byte a la comprobada y solo entonces asume el rol de firma. Firma con la misma llave que los packs (`alias/mango-provider-signing`, D93 (1)), verifica con `packs/signing-key.pub` y sube el artefacto `remote-<id>-signed` (`<id>-<versión>.remote.json`).

El sobre es DSSE, como el de los packs, con su propio tipo (`application/vnd.mango.remote-profile.v1+json`): una firma de pack no vale como firma de perfil, ni al revés.

La release (`release.yml`) baja los `remote-*-signed` a `dist/remotes/`. En la síntesis, `RemoteRelease` (`infra/lib/constructs/remote-release.ts`) verifica cada sobre con la llave pública y falla si una tool no es `read`; lo copia al bucket de packs como `remotes/<id>/<sha256 de la declaración>.json` y nombra ese digest en `REMOTE_CATALOG`. Sin llave de firma, el catálogo queda vacío. El construct todavía no está conectado al stack `Core`: lo conectan quienes lo usan (`mango-api` y el provisioner de remotos).

Para añadir un perfil: su carpeta y su entrada en la matriz `remote` de `remote-build` y `remote-sign` (un test exige que la matriz liste todas las carpetas).

## Azure DevOps

- Servidor: `https://mcp.dev.azure.com/{organización}`, de Microsoft.
- Esquema: 13 tools, capturadas el 2026-10-27 con `X-MCP-Readonly: true` (servidor `AzureDevOps.Mcp` 1.0.0.0, protocolo `2025-06-18`). Todas traen `readOnlyHint: true` y `destructiveHint: false`.
- Fuera de todo toolset (TM-011): `pipelines_artifact` y `wit_work_item_attachment`.

### Valores de `X-MCP-Toolsets`

Salen de la documentación del servidor remoto de Microsoft: <https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops> (leída el 2026-10-27).

| Toolset del perfil | Tools | Valor | Fuente |
|---|---|---|---|
| `core` (siempre) | `core_list_projects`, `core_list_project_teams` | ninguno | La documentación dice que las tools de *core* están siempre disponibles; `core` no es un valor de la cabecera |
| `wit` | `wit_work_item`, `wit_query`, `wit_backlog`, `search_workitem` | `wit` | Documentado: «Work item tools and `search_workitem`» |
| `wiki` | `wiki`, `search_wiki` | `wiki` | Documentado: «Wiki tools and `search_wiki`» |
| `pipelines` | `pipelines_definition`, `pipelines_run`, `pipelines_build`, `pipelines_build_log` | `pipelines` | Documentado: «Pipeline and build tools» |
| `search-code` | `search_code` | `repos` | **Deducido, no documentado.** La documentación no da un valor solo para `search_code`: la pone en la tabla de tools de *Repos*, y el valor `repos` se describe como «Repository and pull request tools». Hay que comprobarlo en vivo antes de habilitarlo en un cliente (D98 (6)) |

Con `repos`, el servidor ofrece también las demás tools de lectura de *Repos*, pero el esquema del target y el ítem firmado solo traen `search_code`: el Gateway no expone ninguna otra.

### Refrescar el esquema a mano (D98 (5))

El CI no puede comparar el perfil con el servidor: el repositorio es público y no tiene credenciales de Microsoft (TM-005). Cuando Microsoft cambie sus tools, o antes de una release que toque el perfil, alguien con acceso a una organización de pruebas lo refresca a mano:

1. **Preparar el acceso.** Una organización de Azure DevOps de pruebas respaldada por un tenant de Entra, y un token de una persona de pruebas con el scope del perfil (`2a72489c-aab2-4b65-b93a-a91edccf33b8/.default`). Si hacen falta recursos temporales (una app registrada, un target del laboratorio), cada uno se aprueba antes y se borra al terminar. Nada de esto entra al repositorio.
2. **Capturar.** Contra `https://mcp.dev.azure.com/<organización>`: `initialize` y `tools/list` (con su paginación), con `X-MCP-Readonly: true` y **sin** `X-MCP-Toolsets`, para ver todas las tools de lectura. Guardar la respuesta en una carpeta local fuera del repositorio. Conviene repetir sin `X-MCP-Readonly` para ver qué tools de escritura hay y comprobar que ninguna se cuela.
3. **Comprobar los toolsets.** Repetir `tools/list` con `X-MCP-Toolsets` igual a cada valor del perfil (y a `repos` para `search_code`) y anotar qué tools trae cada uno. Si un valor deducido queda confirmado, o cambia, se actualiza la tabla de arriba.
4. **Recortar.** Quedarse solo con las tools del perfil, tal como las devolvió el servidor (sin tocar descripciones ni esquemas), en `{"tools": [...]}`. Una tool nueva entra solo si es de lectura y alguien la revisó: se añade a `tools` con su toolset; una que ya no existe se quita.
5. **Revisar que no haya datos reales:** nombres de organización, proyecto o equipo, correos, ids de tenant o de cuenta. Un esquema de tools no debería traer ninguno.
6. **Fijar el hash y la versión.** `mango-pack-builder remote check remotes/azure-devops` dice el hash nuevo cuando no coincide: ponerlo en `tools_sha256`, y subir `version` (fecha de la captura; la revisión de Mango vuelve a `1`).
7. **Revisar el diff** de `tool-schema.json` como el de un `tools.snapshot.json` de pack: descripciones y esquemas son lo que lee el modelo. Un cambio de esquema llega a una instalación solo con una release, y allí pide otra aprobación.
8. Correr los tests (`uv run pytest packages/py/mango-packs deployment/pack-builder`), abrir el PR y, al integrarlo, aprobar la firma en `pack-signing`.
