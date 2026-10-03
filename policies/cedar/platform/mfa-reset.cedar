// L1 (D20): resetting a user's MFA is for Mango administrators only. Dual approval
// (proposer != approver), "nobody resets their own MFA" and rate limits are enforced by
// mango-api, which has the request context (login threat model, TM-L14).
permit (
  principal is Mango::User,
  action in [Mango::Action::"ProposeMfaReset", Mango::Action::"ApproveMfaReset"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
