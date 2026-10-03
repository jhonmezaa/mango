// L1 (D33): UseAgent is decided from the agent's own data. mango-api builds the Agent entity
// from the published version it read from the Agents table: `groups` and `users` are the ones
// that version was approved with (D18). Nothing comes from the request, and no policy is
// written at runtime. Membership comes from the verified token (`cognito:groups`).
// `groups` is optional on both sides only so that tasks of the previous release keep
// authorizing during a rolling update; an agent without attributes matches nobody.
permit (
  principal is Mango::User,
  action == Mango::Action::"UseAgent",
  resource is Mango::Agent
)
when {
  (resource has users && resource.users.contains(principal)) ||
  (resource has groups &&
   principal has groups &&
   resource.groups.containsAny(principal.groups))
};
