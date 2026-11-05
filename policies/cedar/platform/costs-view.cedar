// L1 (D105): Costos, the spend on Amazon Bedrock per day, agent, model and origin with the
// budget of each agent, is for Mango administrators and central FinOps, and both see the same
// (D105 (c), which widens D17 and D89 (1) for this view: the budgets of the agents included).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewCosts",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || (principal has role && principal.role == "finops-central") };
