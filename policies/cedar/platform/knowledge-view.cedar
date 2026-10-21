// L1 (D88 (13)): the documents and the search test of a knowledge base are for its owner, a
// Mango administrator, and the agent creators in its groups. `owner` and `groups` are set by
// mango-api from the Knowledge table, never from the request; membership comes from the
// verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewKnowledgeBase",
  resource is Mango::KnowledgeBase
)
when {
  principal.isAdmin ||
  resource.owner == principal ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource.groups.containsAny(principal.groups))
};
