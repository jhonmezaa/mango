// L1 (D88 (13), (20)): a source on an existing bucket is approved or rejected by an administrator.
// "Not whoever proposed it", also when that was another administrator, is enforced by mango-api
// and by a condition on the Knowledge table, which have the source (the pattern of ApproveAgent).
permit (
  principal is Mango::User,
  action == Mango::Action::"ApproveKbSource",
  resource is Mango::KnowledgeBase
)
when { principal.isAdmin };
