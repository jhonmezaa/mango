// L1 (D109 (b)): only Mango administrators read the Observability view: the traces of every
// agent, with the person of each turn, which they already see in the audit trail.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewObservability",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
