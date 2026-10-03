// L1 (D18): the drafts of an agent are edited by a Mango administrator or by the creator of
// the agent, while that person is still an agent creator. `creator` is set by mango-api from
// the Agents table, never from the request. Only drafts are editable and whoever writes a
// version cannot approve it: mango-api enforces both (TM-M2).
permit (
  principal is Mango::User,
  action == Mango::Action::"EditAgent",
  resource is Mango::Agent
)
when {
  principal.isAdmin ||
  (principal has groups &&
   principal.groups.contains("mango-agent-creator") &&
   resource has creator &&
   resource.creator == principal)
};
