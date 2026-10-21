// L1 (D88 (4), (13)): Mango administrators and agent creators create knowledge bases and see
// the list (name, description, status, groups; design 2.7). The documents and «Probar
// búsqueda» of each one are `ViewKnowledgeBase` on the knowledge base itself.
permit (
  principal is Mango::User,
  action in [Mango::Action::"CreateKnowledgeBase", Mango::Action::"ViewKnowledgeBase"],
  resource == Mango::Platform::"mango"
)
when {
  principal.isAdmin ||
  (principal has groups && principal.groups.contains("mango-agent-creator"))
};
