// L1 (D78): tasks (automations of a published agent). Agent creators and administrators
// create them (the design: whoever may create agents); mango-api also checks UseAgent on the
// agent, with the published version's groups and users, before a task is saved and before
// each of its runs.
permit (
  principal is Mango::User,
  action == Mango::Action::"CreateTask",
  resource == Mango::Platform::"mango"
)
when {
  principal.isAdmin ||
  (principal has groups && principal.groups.contains("mango-agent-creator"))
};
