// L1 (D102): Inicio is for any Mango user with a session. Whose numbers each person gets is
// decided by mango-api with ViewOrgUsage and ViewAreaUsage, deny by default: without them,
// their own, read from their keys with row-level security (`dynamodb:LeadingKeys`). `groups`
// is always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewHome",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
