-- PEAK OS chat, with its own store.
--
-- The tab used to read the legacy Paragon chat (83 rooms, 2837 messages).
-- PEAK OS keeps its own rooms so a message written here never lands in
-- Paragon and vice versa. Nothing is copied across: this starts empty.
--
-- Membership is hard-deleted on leave. Everywhere else in this store we retire
-- rows instead, but a membership row IS the permission to read a room -- a
-- retired-but-present row is a revocation that did not happen.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-chat-v1'));

CREATE TABLE IF NOT EXISTS peakos_chat_rooms (
  workspace_id TEXT NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by_uid TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_chat_rooms_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_chat_rooms_creator_fk
    FOREIGN KEY (created_by_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT peakos_chat_rooms_name_check
    CHECK (btrim(name) <> '' AND length(name) <= 120)
);

CREATE TABLE IF NOT EXISTS peakos_chat_members (
  workspace_id TEXT NOT NULL,
  room_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  user_name_snapshot TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_chat_members_pkey PRIMARY KEY (workspace_id, room_id, user_uid),
  CONSTRAINT peakos_chat_members_room_fk
    FOREIGN KEY (workspace_id, room_id) REFERENCES peakos_chat_rooms(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_chat_members_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS peakos_chat_members_user_idx
  ON peakos_chat_members (workspace_id, user_uid);

CREATE TABLE IF NOT EXISTS peakos_chat_messages (
  workspace_id TEXT NOT NULL,
  room_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  body TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  author_uid TEXT NOT NULL,
  author_name_snapshot TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_chat_messages_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT peakos_chat_messages_room_fk
    FOREIGN KEY (workspace_id, room_id) REFERENCES peakos_chat_rooms(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_chat_messages_author_fk
    FOREIGN KEY (author_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 빈 글은 보내지 못한다. 첨부만 보내는 경우는 첨부가 있어야 한다.
  CONSTRAINT peakos_chat_messages_content_check
    CHECK (btrim(body) <> '' OR jsonb_array_length(attachments) > 0),
  CONSTRAINT peakos_chat_messages_body_check CHECK (length(body) <= 4000),
  CONSTRAINT peakos_chat_messages_attachments_check
    CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10)
);

CREATE INDEX IF NOT EXISTS peakos_chat_messages_room_idx
  ON peakos_chat_messages (workspace_id, room_id, created_at DESC) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS peakos_chat_reads (
  workspace_id TEXT NOT NULL,
  room_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_chat_reads_pkey PRIMARY KEY (workspace_id, room_id, user_uid),
  CONSTRAINT peakos_chat_reads_room_fk
    FOREIGN KEY (workspace_id, room_id) REFERENCES peakos_chat_rooms(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_chat_reads_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);

REVOKE ALL ON peakos_chat_rooms FROM calendar_user;
REVOKE ALL ON peakos_chat_members FROM calendar_user;
REVOKE ALL ON peakos_chat_messages FROM calendar_user;
REVOKE ALL ON peakos_chat_reads FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_chat_rooms TO calendar_user;
GRANT SELECT, INSERT, DELETE ON peakos_chat_members TO calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_chat_messages TO calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_chat_reads TO calendar_user;

COMMIT;
