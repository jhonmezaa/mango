// L1 (D38, spec §4.5): the model catalog (Brains) is for Mango administrators only: listing
// it, enabling or disabling a model and confirming its prices. One administrator is enough
// (no dual approval); mango-api audits every change.
permit (
  principal is Mango::User,
  action == Mango::Action::"ManageModels",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
