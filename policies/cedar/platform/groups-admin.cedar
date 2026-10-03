// L1 (D26, D35): creating an access group, changing its type or area and deleting it are for
// Mango administrators only. Dual approval (proposer != approver), "nobody decides on a group
// they belong to" and the rules on central groups are enforced by mango-api, which has the
// request context (marketplace threat model, TM-M13).
permit (
  principal is Mango::User,
  action in [Mango::Action::"ProposeGroups", Mango::Action::"ApproveGroups"],
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
