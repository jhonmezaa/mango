# Tickets de Mango (write connector)

Catalog data only: `manifest.json` (what the MCP catalog and the tool policies show) and
`tool-schema.json` (what the Gateway target exposes). The tools run in
`functions/approval-executor` (target `ops`, D112 (9)), only with a valid approval (D27). They
write the table `Mango-<ns>-Tickets` and nothing else: no IAM grant in AWS accounts, so the
catalog lets their policy be born self-confirmed (D112 (8)). mango-api decides `CreateTicket`,
`EditTicket` or `CommentTicket` with Cedar when the request is created and again when it is
confirmed. There is no read tool: an agent never reads tickets (D112 (9)).
