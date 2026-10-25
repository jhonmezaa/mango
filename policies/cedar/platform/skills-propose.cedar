// L1 (D92): Mango administrators and agent creators see the skills (their instructions
// included) and propose new skills and new versions of any of them.
permit (
  principal is Mango::User,
  action in [Mango::Action::"ViewSkills", Mango::Action::"ProposeSkill"],
  resource == Mango::Platform::"mango"
)
when {
  principal.isAdmin ||
  (principal has groups && principal.groups.contains("mango-agent-creator"))
};
