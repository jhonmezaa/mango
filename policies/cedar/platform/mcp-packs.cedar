// L1 (D19, D26): asking for an MCP pack (enable, change its parameters, update, retry a
// failed installation, disable) and deciding on a request are for Mango administrators only.
// Dual approval (whoever asks does not approve) is enforced by mango-api and by a condition
// on the Settings table, which have the request (TM-M2). Reading the catalog is
// `ViewMcpCatalog` (agents-create.cedar).
permit (
  principal is Mango::User,
  action in [Mango::Action::"EnableMcp", Mango::Action::"ApproveMcp"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
