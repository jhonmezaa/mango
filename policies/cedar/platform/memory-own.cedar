// L1 (D122): «Memoria» is for any Mango user with a session, over their own memory only:
// mango-api builds the actor of every read and deletion from the verified `sub`, and no input
// names another person. Nobody reads another person's memory, an administrator neither (D23,
// D122 (5)). `groups` is always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"OwnMemory",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
