-- Preserve the last known shortlist at its actual message. Older state does not
-- contain agent activity or historical catalog prices, so do not invent either.
INSERT INTO creator_runs(id, conversation_id, message_id, revision, status, input, result, attempt)
SELECT m.id, c.conversation_id, m.id,
  CASE WHEN (c.state->>'revision') ~ '^[0-9]{1,9}$' THEN (c.state->>'revision')::integer ELSE 0 END,
  'ready', jsonb_build_object('brief', c.state->'brief'),
  jsonb_build_object('legacy', true, 'brief', c.state->'brief',
    'candidates', c.state->'candidates',
    'previous', CASE WHEN jsonb_typeof(c.state->'previous') = 'array' THEN c.state->'previous' ELSE '[]'::jsonb END),
  m.id
FROM creator_campaigns c
JOIN workspace_chat_messages m ON m.id::text = c.state->>'lastReplyId'
  AND m.conversation_id = c.conversation_id AND m.role = 'assistant' AND m.status = 'completed'
WHERE CASE WHEN jsonb_typeof(c.state->'candidates') = 'array'
    THEN jsonb_array_length(c.state->'candidates') ELSE 0 END > 0
  AND jsonb_typeof(c.state->'brief') = 'object'
  AND NOT EXISTS (SELECT 1 FROM creator_runs r WHERE r.conversation_id = c.conversation_id)
ON CONFLICT (id) DO NOTHING;
