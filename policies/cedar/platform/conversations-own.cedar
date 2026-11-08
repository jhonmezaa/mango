// L1 (D121 (7), TM-TW3): only the owner of a conversation reads the stream of its turns or
// stops one. An administrator cannot either (D23). The owner is read from the turn's record in
// the person's own partition (row-level security), never from the request.
permit (
  principal is Mango::User,
  action == Mango::Action::"OwnConversation",
  resource is Mango::Conversation
)
when { resource.owner == principal };
