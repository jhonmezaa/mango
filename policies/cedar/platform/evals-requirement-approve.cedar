// L1 (D26, D111 (4)): stopping requiring a suite is decided by a Mango administrator. That the
// administrator is not whoever asked is enforced by mango-api and by the condition of the
// Evals table (TM-EV4), which have the request.
permit (
  principal is Mango::User,
  action == Mango::Action::"ApproveEvalRequirement",
  resource is Mango::Agent
)
when { principal.isAdmin };
