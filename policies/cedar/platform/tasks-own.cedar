// L1 (D78): a task runs with its owner's identity (D26): only the owner edits it, runs it now or
// resumes it. An administrator cannot, so nobody makes a task act as someone else.
permit (
  principal is Mango::User,
  action == Mango::Action::"OwnTask",
  resource is Mango::Task
)
when { resource.owner == principal };
