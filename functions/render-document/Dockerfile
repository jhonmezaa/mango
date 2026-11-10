# render-document Lambda container (linux/arm64, D117). Build context: repository root.
#
# Built only by the release pipeline (`deployment/dist.py --publish`), pushed to the provider's
# repository and named by digest in the template (D58): nothing is built, downloaded or
# installed in a customer account (D25). LibreOffice, Poppler and the fonts are fixed here, so
# what renders a document is the same in every installation.
#
# Reproducible: base images pinned by digest (the tag is kept for people and for Dependabot),
# Debian packages from one snapshot of the archive (apt still checks its signatures), and one
# date for every file of the final image, which is a single layer copied from the runtime stage.
FROM ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 AS uv

FROM public.ecr.aws/docker/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY functions/render-document functions/render-document
# Only the function and its runtime dependencies, from the lockfile with hashes.
RUN uv export --frozen --no-dev --package mango-render-document --no-emit-workspace --no-header \
      --format requirements-txt > /tmp/requirements.txt \
 && uv pip install --system --no-cache --requirement /tmp/requirements.txt --target /app \
 && cp -R functions/render-document/src/. /app/

FROM public.ecr.aws/docker/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS runtime
# The Debian archive as it was on this date: the same packages on every build. Change it to
# take security updates (and say so in the release notes).
ARG DEBIAN_SNAPSHOT=20261105T000000Z
ARG DEBIAN_FRONTEND=noninteractive
COPY functions/task-report/src/mango_task_report/fonts/ /usr/local/share/fonts/ibm-plex/
# Headless LibreOffice without Java or Python scripting (no `-nogui` package brings them),
# Poppler for PDF to PNG, and the fonts of the documents the agents write: Noto and DejaVu for
# coverage, IBM Plex like the task reports (D87; Debian has no package of it, so the same files
# as the reports, from the repository), and the metric-compatible families of the
# Office defaults (Liberation for Arial, Times New Roman and Courier New; Carlito for Calibri;
# Caladea for Cambria), so that pages break where Office breaks them.
RUN printf '%s\n' \
      "Types: deb" \
      "URIs: https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      "Suites: trixie trixie-updates" \
      "Components: main" \
      "Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp" \
      "" \
      "Types: deb" \
      "URIs: https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      "Suites: trixie-security" \
      "Components: main" \
      "Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp" \
      > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get -y --no-install-recommends upgrade \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      poppler-utils \
      fonts-noto-core fonts-dejavu-core \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* /tmp/* \
 # The font cache is built here, with the font folders already at the image's date: fontconfig
 # trusts it at run time and never scans the fonts again (a read-only filesystem, a cold start).
 && { find /usr/share/fonts /usr/local/share/fonts /etc/fonts \
      -exec touch --no-dereference --date=@315532800 {} + 2>/dev/null || true; } \
 && fc-cache --really-force --system-only \
 && rm -rf /var/log/*
COPY --from=build /app /app
# One date for every file: the layer depends on what the files hold, not on when it was built.
# ldconfig's auxiliary cache records inodes and times of the build machine: it is only a cache.
RUN rm -f /var/cache/ldconfig/aux-cache \
 && find / -xdev -not -path '/proc/*' -not -path '/sys/*' -not -path '/dev/*' \
      -exec touch --no-dereference --date=@315532800 {} + 2>/dev/null || true

# One layer: the final image is the runtime stage's filesystem, without the history of how it
# was made (package lists, caches), so the same inputs give the same digest.
FROM scratch
COPY --from=runtime / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    MANGO_SOFFICE=/usr/bin/soffice MANGO_PDFTOPPM=/usr/bin/pdftoppm MANGO_PDFINFO=/usr/bin/pdfinfo
WORKDIR /app
USER 10001:10001
# Lambda ignores it; it serves local runs: LibreOffice and Poppler of the image start.
HEALTHCHECK --interval=5m --timeout=30s --retries=1 \
  CMD ["/usr/bin/soffice", "--headless", "--version"]
ENTRYPOINT ["/usr/local/bin/python", "-m", "awslambdaric"]
CMD ["mango_render_document.handler.lambda_handler"]
