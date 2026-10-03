// L1 (D27): changing the approval policy of a write tool (threshold, approvers, expiry) is
// for Mango administrators only. Dual approval (whoever proposes does not approve) is
// enforced by mango-api and by a condition on the Settings table (TM-W6).
permit (
  principal is Mango::User,
  action in [Mango::Action::"ProposeToolPolicy", Mango::Action::"ApproveToolPolicy"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
