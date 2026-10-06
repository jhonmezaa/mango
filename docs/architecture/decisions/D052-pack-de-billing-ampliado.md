# D52 · Pack de Billing ampliado

- **Estado:** vigente
- **Fecha:** 2026-10-01
- **Precisa / reemplaza a:** precisa [D37](D037-packs-de-datos-de-cuentas.md) y [D43](D043-provisioner-de-packs.md)
- **Precisada por:** —
- **Tema en el registro original:** Pack de Billing ampliado (C3b, precisa [D37](D037-packs-de-datos-de-cuentas.md) y [D43](D043-provisioner-de-packs.md))

## Decisión

**(1) El rol detrás del broker crece, solo en lectura.** `BILLING_READER_DATA_ACTIONS` (`Mango-<ns>-BillingReader`, cuenta pagadora) pasa de 6 a 37 acciones exactas, sin comodines, todas de lectura y comprobadas contra la referencia de servicios de IAM: 29 de facturación (16 `ce:Get*`, 8 `compute-optimizer:Get*`, 4 de `cost-optimization-hub` y `budgets:ViewBudget`) y 8 de inventario. Ninguna crea, cambia ni arranca nada ([D43](D043-provisioner-de-packs.md)). El trust no cambia. El pack `aws-billing` pasa de 3 a 9 tools de lectura y cada llamada suya queda limitada a 36 acciones (28 de facturación y las 8 de inventario).

**(2) Budgets acotado.** `budgets:ViewBudget` solo sobre `arn:aws:budgets::<pagadora>:budget/*`, con un reconocimiento granular de cdk-nag (`AwsSolutions-IAM5` para ese recurso) y su motivo junto al código: los nombres de los presupuestos no se conocen de antemano.

**(3) Inventario de solo lectura para Compute Optimizer (usuario, 2026-10-01).** Para devolver recomendaciones, Compute Optimizer comprueba al llamador contra la acción que lista cada tipo de recurso. El rol recibe exactamente esas acciones: `ec2:DescribeInstances`, `ec2:DescribeVolumes`, `autoscaling:DescribeAutoScalingGroups`, `lambda:ListProvisionedConcurrencyConfigs`, `rds:DescribeDBInstances`, `rds:DescribeDBClusters`, `ecs:ListClusters` y `ecs:ListServices`. Ninguna lee contenido de datos y ninguna tool del pack las llama. **`lambda:ListFunctions` queda fuera (usuario, 2026-10-01):** devuelve las variables de entorno de las funciones de Lambda de la pagadora; a cambio, las recomendaciones de Lambda pueden responder `AccessDenied`. Un test impide añadirla.

**(4) El conector de Cost Explorer comparte el rol y no cambia:** sigue asumiéndolo con una session policy de una acción por llamada, así que sus usuarios no alcanzan nada nuevo. Lo que crece es lo que podría leer quien comprometa un rol capaz de asumir el broker (TM-BL11, TM-C4).

**(5) `region` se queda.** La tool `compute-optimizer` acepta la región como argumento del modelo: el servicio es regional, botocore solo admite un nombre de host válido dentro de un dominio de AWS, y la credencial y la session policy son las mismas en cualquier región (TM-BL12).

**(6) Sin inscripción.** Mango no inscribe la pagadora en Compute Optimizer ni en Cost Optimization Hub, ni tiene permisos para hacerlo; mientras el cliente no los active, sus tools responden ese error.

**(7) Fuera del pack:** `session-sql`, `storage-lens`, `sp-recommendation` y `sp-purchase-analyzer` (estado compartido, escritura o trabajos), y las tools de lectura que piden acciones fuera de esta lista (`budget-actions`, `rec-details`, `sp-explorer` y el resto)
