// L1 (D18): Mango administrators and agent creators create agents (drafts and new versions)
// and read what the builder needs: the MCP catalog and the enabled models. Creating never
// publishes; the quotas per creator are enforced by mango-api (TM-M9).
permit (
  principal is Mango::User,
  action in [Mango::Action::"CreateAgent", Mango::Action::"ViewMcpCatalog"],
  resource == Mango::Platform::"mango"
)
when {
  principal.isAdmin ||
  (principal has groups && principal.groups.contains("mango-agent-creator"))
};
