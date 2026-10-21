// L1 (D88 (13)): a knowledge base is edited, synchronized and deleted by its owner while that
// person is still an agent creator, or by a Mango administrator (the pattern of EditAgent).
// `owner` is set by mango-api from the Knowledge table, never from the request.
permit (
  principal is Mango::User,
  action == Mango::Action::"EditKnowledgeBase",
  resource is Mango::KnowledgeBase
)
when {
  principal.isAdmin ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource.owner == principal)
};
