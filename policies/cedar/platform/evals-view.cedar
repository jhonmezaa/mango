// L1 (D111 (1)): the suites, cases and runs of an agent's evals are seen by Mango
// administrators, central FinOps and whoever edits the agent (as EditAgent: its creator, while
// that person is still an agent creator). `creator` is set by mango-api from the Agents table,
// never from the request; mango-api filters lists with this same action, per agent.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewEvals",
  resource is Mango::Agent
)
when {
  principal.isAdmin ||
  (principal has role && principal.role == "finops-central") ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource has creator &&
   resource.creator == principal)
};
