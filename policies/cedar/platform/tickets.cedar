// L1 (D112): a ticket is seen, changed and commented by whoever created it, whoever has it
// assigned, whoever may use its agent, and administrators. mango-api builds the Ticket entity
// from the Tickets table (`creator`, `assignee`) and the Agent entity from the published
// version of its agent (`groups`, `users`, as for UseAgent, D33): nothing comes from the
// request. A ticket without an agent is only of its creator, its assignee and administrators.
permit (
  principal is Mango::User,
  action in [
    Mango::Action::"ViewTicket",
    Mango::Action::"EditTicket",
    Mango::Action::"CommentTicket"
  ],
  resource is Mango::Ticket
)
when {
  principal.isAdmin ||
  resource.creator == principal ||
  (resource has assignee && resource.assignee == principal) ||
  (resource has agent &&
   ((resource.agent has users && resource.agent.users.contains(principal)) ||
    (resource.agent has groups &&
     principal has groups &&
     resource.agent.groups.containsAny(principal.groups))))
};
