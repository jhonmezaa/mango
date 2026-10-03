# Reglas de cfn-guard

`wa-Security-Pillar.guard` es el ruleset **Well-Architected Security Pillar** del
[AWS Guard Rules Registry](https://github.com/aws-cloudformation/aws-guard-rules-registry),
release `v1.0.2` (`ruleset-build-v1.0.2.zip`), sin modificaciones. Licencia Apache-2.0: el texto está en
`LICENSE-Apache-2.0.txt` y el aviso en el `NOTICE` de la raíz.

- SHA-256: `61a3ec20378293c9531edc00cfbc96b5b4c761d92d1ed3f14685e6e1cb402302`
- Se ejecuta con `mise run guard` (y en CI) sobre las plantillas sintetizadas.
- Las supresiones van en el recurso (`Metadata.guard.SuppressedRules`) desde `infra/lib/guard.ts`,
  y cada una es un falso positivo o una excepción acordada en `AGENTS.md`.

Para actualizar el ruleset: descargar la nueva release, reemplazar el archivo, actualizar versión y
hash aquí y revisar los hallazgos nuevos antes del merge.
