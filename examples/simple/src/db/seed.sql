-- Two owners so scoping is observable: owner 1111… sees two todos, never 2222…'s.
insert into todos (owner, title, done, priority, notes) values
  ('11111111-1111-1111-1111-111111111111', 'Buy milk', false, 1, null),
  ('11111111-1111-1111-1111-111111111111', 'Write tests', true, 2, 'use bun:test'),
  ('22222222-2222-2222-2222-222222222222', 'Not your todo', false, 0, null);
