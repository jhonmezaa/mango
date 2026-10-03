# AWS Budgets (write connector)

Catalog data only: `manifest.json` (what the MCP catalog and the tool policies show) and
`tool-schema.json` (what the Gateway target exposes). The code that runs these tools is
`functions/approval-executor`: the only package allowed to write to AWS accounts (AGENTS.md),
and only with a valid approval (D27).
