// L1 (D78, D82 (1)): tasks (automations of a published agent). Anyone signed in creates them
// (taken by the owner on 2026-10-16): the agent is what limits them. `groups` is always set
// by mango-api from the verified token (`cognito:groups`), as for ViewApprovals. mango-api
// checks UseAgent on the agent, with the published version's groups and users, before a task is saved and
// before each of its runs; the limits per person and per installation (D78 (4)), the budget
// (D73), approvals for writes (D56) and «central only» for cost anomalies (D79 (5)) still hold.
permit (
  principal is Mango::User,
  action == Mango::Action::"CreateTask",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
