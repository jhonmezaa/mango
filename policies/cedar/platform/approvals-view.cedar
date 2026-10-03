// L1 (D27): reading approval requests and the tool policies is for any Mango user with a
// session. Which requests each person sees is decided by mango-api per object: approvers see
// the requests that need approvers, everyone else only what they asked for (TM-W9). `groups`
// is always set by mango-api from the verified token (`cognito:groups`).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewApprovals",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || principal has role || principal has groups };
