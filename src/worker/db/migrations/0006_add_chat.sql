-- Live chat opt-in per stream. When 1, the broadcaster and viewers connect to the
-- per-stream ChatRoom Durable Object (WebSocket) at /api/streams/:id/chat. Default off;
-- existing streams are unaffected.
ALTER TABLE streams ADD COLUMN chat_enabled INTEGER DEFAULT 0;
