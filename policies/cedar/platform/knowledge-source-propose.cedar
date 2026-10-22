// L1 (D88 (13), (20)): a source on an existing bucket is proposed (and removed) by the owner of
// the knowledge base while that person is an agent creator, or by an administrator: the
// pattern of EditKnowledgeBase. `owner` is set by mango-api from the Knowledge table.
permit (
  principal is Mango::User,
  action == Mango::Action::"ProposeKbSource",
  resource is Mango::KnowledgeBase
)
when {
  principal.isAdmin ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource.owner == principal)
};
