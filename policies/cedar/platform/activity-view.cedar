// L1 (D90): the Actividad is for any Mango user with a session. Whose activity each person sees
// is decided by mango-api: their own, read from their partition with row-level security
// (`dynamodb:LeadingKeys`), or everyone's for who also has `ViewAudit` (administrators).
// `groups` is always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewActivity",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
