# Cuenta del proveedor

Lo que el proveedor de Mango mantiene en **su propia cuenta de AWS**, fuera de la organización de cualquier cliente (D58): el almacén de releases, la imagen de `mango-api` y la llave de firma. Nada de esto se instala en una cuenta de cliente.

Todo vive en un único stack, **`Mango-provider`** (`infra/lib/stacks/provider-stack.ts`, app `infra/bin/provider.ts`), con nombres `Mango-provider-…` y `mango-provider-…`. No lleva assets ni necesita bootstrap de CDK.

Diseño: `docs/specs/customer-distribution.md` §5 y §6. Modelo de amenazas: `docs/security/threat-models/customer-distribution-threat-model.md`.

## Qué crea

| Recurso | Nombre | Reglas |
|---|---|---|
| Bucket de plantillas | `mango-provider-releases-<cuenta>` | Versionado, TLS obligatorio, sin acceso público |
| Bucket de assets (regional) | `mango-provider-releases-<cuenta>-<región>` | Ídem. Lambda solo carga código de un bucket de su región |
| Bucket de access logs | `mango-provider-access-logs-<cuenta>` | Expira a los 90 días |
| Repositorio de la imagen | `mango-provider/api` | Tags inmutables, escaneo al subir, cifrado con KMS |
| Llave de firma | `alias/mango-provider-signing` | `ECC_NIST_P256`, `SIGN_VERIFY`. Firma declaraciones de packs y manifiestos de release |
| Proveedor OIDC | `token.actions.githubusercontent.com` | Uno por cuenta: si la cuenta ya tiene uno, el stack no se crea |
| Rol | `Mango-provider-pack-signing` | Lo asume el job `sign` de `packs.yml` (entorno `pack-signing`). Solo firma |
| Rol | `Mango-provider-release-publisher` | Lo asume el job de publicación (entorno `release`). Firma el manifiesto, escribe en `mango/*` y sube la imagen |
| Alertas | Topic `Mango-provider-alerts` y cinco reglas de EventBridge | Firma por otro principal, y cambios en la llave, los roles, los buckets o el repositorio |

## Quién puede qué

- **Leer** (`s3:GetObject` en `mango/*`, pull de la imagen): cualquier principal de las organizaciones de `CustomerOrganizationIds` (`aws:PrincipalOrgID`). Sin listado. Las lecturas las hacen quien llama a `CreateStack`, la identidad con la que Lambda copia su código y los roles de la cuenta del cliente.
- **Escribir:** solo el rol de publicación, solo bajo `mango/` y solo claves nuevas: la política de los buckets niega todo `PutObject` sin `If-None-Match`. Con `aws s3 cp` hace falta `--no-overwrite`. Ni siquiera un administrador de la cuenta escribe sin cambiar antes la política, y ese cambio dispara una alerta.
- **Borrar:** el rol de publicación no puede. En una cuenta definitiva la política niega además `DeleteObject` y `DeleteObjectVersion` a todos, y los buckets llevan Object Lock (GOVERNANCE, 365 días).
- **Firmar:** solo los dos roles, con `ECDSA_SHA_256` sobre un digest. La cuenta administra la llave, pero tiene negados `kms:Sign` y `kms:CreateGrant`.

Los dos roles confían en el `sub` exacto del repositorio, con identificadores inmutables (`repo:<owner>@<id>/<repo>@<id>:environment:<entorno>`). El prefijo se consulta con `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`.

## Instalar o actualizar

Con credenciales de la cuenta del proveedor:

```sh
deployment/provider/deploy.sh 'repo:<owner>@<owner id>/<repo>@<repo id>' 'o-xxxxxxxxxx,o-yyyyyyyyyy' [correo-de-alertas]
```

- **Añadir un cliente:** repetir el comando con su id de organización en la lista.
- **Dar de baja un cliente:** repetirlo sin su id. Deja de leer en el acto; lo que ya instaló sigue funcionando, pero `mango-api` no podrá arrancar tareas nuevas (descarga la imagen de este repositorio).
- `MANGO_PROVIDER_LOCAL_PUBLISHER=<arn de un rol de la cuenta>`: ese rol también puede asumir el rol de publicación, para publicar desde una estación de trabajo (releases de laboratorio). Vacío en una cuenta donde solo publica el workflow.
- `MANGO_PROVIDER_TEMPORARY=1`: para una cuenta temporal. Nada se retiene al borrar el stack y los buckets no llevan Object Lock (no se puede quitar después).

Las alertas leen eventos de administración de CloudTrail: la cuenta necesita un trail que los registre.

## Después de instalar

1. Llave pública: `aws kms get-public-key --key-id alias/mango-provider-signing --query PublicKey --output text | base64 -d | openssl pkey -pubin -inform DER -outform PEM` → `packs/signing-key.pub`, por PR.
2. Variables del repositorio en GitHub: `PACK_SIGNING_ROLE_ARN`, `PACK_SIGNING_KEY_ARN` (outputs `PackSigningRoleArn` y `SigningKeyArn`) y `PACK_SIGNING_REGION`.
3. Para publicar releases (`.github/workflows/release.yml`): variables `RELEASE_PUBLISHER_ROLE_ARN` (output `ReleasePublisherRoleArn`), `RELEASE_BUCKET` (output `TemplatesBucket`) y `PROVIDER_ACCOUNT_ID`. Sin ellas el workflow no corre. **El workflow no se ha ejecutado todavía**: las releases de prueba se publicaron desde una estación de trabajo con `python3 deployment/dist.py --publish`.
4. Entornos `pack-signing` y `release` en GitHub, limitados a la rama `main` (y a las etiquetas de versión, el de `release`), cada uno con un revisor obligatorio, y `main` protegida (`packs/README.md`, «Infraestructura de firma»).
5. Confirmar la suscripción del correo de alertas.

## Cambiar de repositorio

Los dos roles solo confían en un repositorio, por sus identificadores numéricos (parámetro `GitHubSubjectPrefix`). Un repositorio nuevo, aunque tenga el mismo nombre, **no hereda** la confianza. Para pasar la firma y la publicación a otro repositorio:

1. En el repositorio nuevo, consultar su prefijo: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (campo `sub_claim_prefix`; si `use_immutable_subject` no está activo, activarlo antes).
2. Repetir `deployment/provider/deploy.sh` con ese prefijo y la misma lista de clientes. Es un `UpdateStack` que solo cambia el trust de los dos roles; dispara la alerta de cambio de rol, como debe. Desde ese momento el repositorio anterior ya no puede firmar ni publicar.
3. En el repositorio nuevo: proteger `main`, crear los entornos `pack-signing` y `release` (limitados a `main`, con revisor obligatorio) y las variables `PACK_SIGNING_ROLE_ARN`, `PACK_SIGNING_KEY_ARN` y `PACK_SIGNING_REGION` con los outputs del stack.
4. La llave no cambia: `packs/signing-key.pub` y los packs ya firmados siguen valiendo.

## Borrar (solo cuenta temporal)

Vaciar los tres buckets, con todas sus versiones, y `aws cloudformation delete-stack --stack-name Mango-provider`. La llave de firma queda siete días pendiente de borrado: todo lo firmado con ella deja de poder renovarse.

## Comprobado (2026-10-03)

Cuenta del proveedor en una organización, cliente en otra (`~/.config/mango/lab/reports/customer-dist/crossorg-probe.md`):

- Un principal de la organización del cliente lee un objeto; no puede listar; una petición anónima recibe 403.
- CloudFormation en la cuenta del cliente crea un stack desde una `TemplateURL` del bucket de plantillas, con una Lambda cuyo código está en el bucket regional.
- El administrador de la cuenta del proveedor no puede escribir. El rol de publicación no puede escribir sin `If-None-Match`, ni sobre una clave existente (412), ni fuera de `mango/`, ni borrar. Una subida multiparte con `--no-overwrite` funciona.
- El repositorio de la imagen autoriza a la organización del cliente y nada más; ECS Fargate de la cuenta del cliente descargó la imagen por digest.
- Una release completa publicada con `mise run dist -- --publish` (rol de publicación asumido desde una estación de trabajo) e instalada en la organización del cliente: `docs/specs/customer-distribution.md` §12.
