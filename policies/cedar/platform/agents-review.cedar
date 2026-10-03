// L1 (D18): reviewing (approve, reject, retry a failed publication) and retiring agents are
// for Mango administrators only. "Approver != author of the version" is enforced by mango-api
// and by a condition on the Agents table, which have the version (TM-M2).
permit (
  principal is Mango::User,
  action in [Mango::Action::"ApproveAgent", Mango::Action::"RetireAgent"],
  resource
)
when { principal.isAdmin };
