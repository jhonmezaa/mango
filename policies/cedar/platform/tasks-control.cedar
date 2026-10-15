// L1 (D78): a task is seen, paused and retired by its owner or by an administrator. `owner` is set by
// mango-api from the Tasks table (the verified subject of whoever created it), never from
// the request.
permit (
  principal is Mango::User,
  action in [Mango::Action::"ViewTask", Mango::Action::"ControlTask"],
  resource is Mango::Task
)
when { principal.isAdmin || resource.owner == principal };
