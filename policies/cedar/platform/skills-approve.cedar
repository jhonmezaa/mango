// L1 (D92): each version of a skill is approved or rejected by an administrator. "Not whoever
// proposed it", also when that was another administrator, is enforced by mango-api and by a
// condition on the Skills table, which have the request (the pattern of ApproveKbSource).
permit (
  principal is Mango::User,
  action == Mango::Action::"ApproveSkill",
  resource == Mango::Platform::"mango"
)
when { principal.isAdmin };
