// L1 (D60): the directory and who belongs to which group are for Mango administrators only.
// Which changes need a second administrator (mango-admin, finops-central, disabling an
// administrator), "nobody decides on their own account", the two-administrator minimum and
// the rate limits are enforced by mango-api, which has the request context
// (people-management-threat-model.md, TM-P1 to TM-P9).
permit (
  principal is Mango::User,
  action in [
    Mango::Action::"ViewPeople",
    Mango::Action::"ManagePeople",
    Mango::Action::"ApprovePeopleChange"
  ],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
