# render-document

`Mango-<ns>-RenderDocument` (D117): Lambda-contenedor que convierte un Word, Excel o PowerPoint de los archivos del chat en un PDF y un PNG por página, con LibreOffice headless y Poppler. Modelo de amenazas: `docs/security/threat-models/code-interpreter-threat-model.md` (TM-CI8).

- **Contrato del evento:** en el docstring de `src/mango_render_document/handler.py` y en D117 (7). Todavía no tiene target del Gateway: lo añade el conector del sandbox (C2).
- **Imagen:** `Dockerfile` (contexto: la raíz del repositorio). La construye solo el pipeline de la release (`deployment/dist.py --publish`) y la sube al repositorio de mango-api con el tag `render-document-<label>`. La plantilla la nombra por digest (D58, D117 (6)). Es reproducible: base por digest, Debian de una instantánea fija (`DEBIAN_SNAPSHOT`) y una sola capa con una fecha para todo. Para tomar parches de seguridad, se cambia `DEBIAN_SNAPSHOT`.
- **Infra:** `infra/lib/constructs/render-document.ts`, en el stack anidado `RenderDocument` de `Core`, solo en una release.

## Probar la imagen en local

```sh
docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH=315532800 \
  --file functions/render-document/Dockerfile --tag mango-render-document:local --load .
```

La prueba de conversión de `tests/test_render_document.py` se salta donde no hay LibreOffice. Dentro de la imagen corre toda la suite, con la raíz de solo lectura y `/tmp` en memoria como en Lambda. La red solo hace falta para instalar pytest en `/tmp`:

```sh
docker run --rm --read-only --tmpfs /tmp:exec,size=1g \
  -v "$PWD/functions/render-document:/fn:ro" --entrypoint sh mango-render-document:local -c \
  'python -m pip install -q --target /tmp/py pytest && cd /tmp && \
   PYTHONPATH=/tmp/py:/fn/src:/app python -m pytest -q -p no:cacheprovider --rootdir /tmp /fn/tests'
```

Después: `docker builder prune -af`.
