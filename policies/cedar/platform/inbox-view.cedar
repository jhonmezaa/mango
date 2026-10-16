// L1 (D83): the Bandeja is for any Mango user with a session. What each person sees is decided
// by mango-api per object: notices live in the caller's own partition (row-level security,
// `dynamodb:LeadingKeys`), and approvals only appear to who can sign them (D56). `groups` is
// always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewInbox",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
