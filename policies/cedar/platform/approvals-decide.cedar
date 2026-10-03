// L1 (D27): signing or rejecting a write tool call that needs approvers is for Mango
// administrators and central FinOps. Separation of duties (never who asked for the action,
// nobody twice, nothing after it expired) is enforced by mango-api and again by a condition
// on the Approvals table, which have the request (TM-W5).
permit (
  principal is Mango::User,
  action == Mango::Action::"ApproveToolCall",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || (principal has role && principal.role == "finops-central") };
