// L1 (D102): the spend and turns per day of one area in Inicio are for its leader: a bu-lead,
// and only the area of their verified token (`mango_business_unit`), which mango-api reads.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewAreaUsage",
  resource == Mango::Platform::"mango"
)
when {
  principal has role && principal.role == "bu-lead" && principal has businessUnit
};
