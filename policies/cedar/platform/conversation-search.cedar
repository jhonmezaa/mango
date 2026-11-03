// L1 (D103): «Buscar conversaciones» is for any Mango user with a session, over their own
// conversations only: mango-api reads them with the person's row-level security session
// (`dynamodb:LeadingKeys` = `USER#<sub>`) and no input names another person. `groups` is
// always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"SearchConversations",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
