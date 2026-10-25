// L1 (D89): the Gobernanza view is for Mango administrators and central FinOps, the people who
// sign write tool calls (as ApproveToolCall). It only summarizes: each section is decided again
// by mango-api with the action of its own screen (ApproveToolCall for approvals, ViewAdmin for
// budgets and areas, ViewAudit for the audit trail), and a section the caller may not read is
// left out.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewGovernance",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || (principal has role && principal.role == "finops-central") };
