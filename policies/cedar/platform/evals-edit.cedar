// L1 (D111 (2)): suites of an agent are created, edited and run by whoever edits the agent
// (as EditAgent and the Playground, D91 (4)): a Mango administrator or the creator of the
// agent while still an agent creator. Central FinOps sees results but does not edit.
permit (
  principal is Mango::User,
  action == Mango::Action::"EditEvals",
  resource is Mango::Agent
)
when {
  principal.isAdmin ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource has creator &&
   resource.creator == principal)
};
