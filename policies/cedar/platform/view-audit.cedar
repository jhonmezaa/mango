// L1: only Mango administrators may read the audit trail.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewAudit",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
