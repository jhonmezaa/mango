// L1 (D102): the spend and turns per day of the whole organization in Inicio are for Mango
// administrators and central FinOps, the people who see the organization in Gobernanza (D89).
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewOrgUsage",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin || (principal has role && principal.role == "finops-central") };
