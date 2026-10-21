// L1 (D88 (13), (22)): a knowledge base answers whoever is in one of its groups, read from the
// Knowledge table when asked (a change of groups holds at once). Being an administrator or its
// owner is not enough: the search runs as the person who asks (rule 5).
permit (
  principal is Mango::User,
  action == Mango::Action::"UseKnowledgeBase",
  resource is Mango::KnowledgeBase
)
when { principal has groups && resource.groups.containsAny(principal.groups) };
