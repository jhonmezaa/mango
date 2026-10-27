// L1 (D98 (18)): a remote MCP registration serves whoever is in one of its groups, read from
// `REMOTE#<reg>` when asked. Being an administrator is not enough: the remote service is read
// with the person's own account (rule 5), and only the groups the registration names may.
permit (
  principal is Mango::User,
  action == Mango::Action::"UseRemoteMcp",
  resource is Mango::RemoteMcp
)
when { principal has groups && resource.groups.containsAny(principal.groups) };
