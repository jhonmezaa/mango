// L1 (D93 (7), D98 (18)): registering a remote MCP server for an organization (asking, rotating
// its secret, retrying, disabling) and deciding on a request are for Mango administrators only.
// Dual approval (whoever asks does not approve) is enforced by mango-api and by a condition on
// the Settings table, which have the request. Reading the catalog is `ViewMcpCatalog`.
permit (
  principal is Mango::User,
  action in [Mango::Action::"ManageRemoteMcp", Mango::Action::"ApproveRemoteMcp"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
