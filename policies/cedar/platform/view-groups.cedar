// L1 (D26): the registry of access groups is read by Mango administrators and by agent
// creators (the builder assigns groups to an agent). Membership comes from the verified
// token (`cognito:groups`), never from the request. `groups` is optional in the schema only so
// that tasks of the previous release keep authorizing during a rolling update.
permit (
  principal is Mango::User,
  action == Mango::Action::"ViewGroups",
  resource == Mango::Platform::"mango"
)
when {
  principal.isAdmin ||
  (principal has groups && principal.groups.contains("mango-agent-creator"))
};
