// L1 (D17): Admin v0 operations are for Mango administrators only. Dual approval
// (proposer != approver) and "nobody edits what affects them" are enforced by mango-api,
// which has the request context (threat model admin-v0, TM-A1/TM-A3).
permit (
  principal is Mango::User,
  action in [
    Mango::Action::"ViewAdmin",
    Mango::Action::"ManageBudgets",
    Mango::Action::"ProposeBusinessUnits",
    Mango::Action::"ApproveBusinessUnits"
  ],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
