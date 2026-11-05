// L1 (D112): Tickets is a main view for every Mango user with a session (`USER_VIEWS`): anyone
// creates tickets and lists them. Which tickets a list shows is decided ticket by ticket with
// ViewTicket; the agent a new ticket names is checked with UseAgent. `groups` is always set by
// mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action in [Mango::Action::"CreateTicket", Mango::Action::"ListTickets"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
