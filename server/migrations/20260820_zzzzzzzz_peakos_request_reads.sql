-- Tracks who has read a request's conversation up to when.
--
-- Without this nothing tells you a reply arrived: you had to open the tab and
-- click every row to find out. One row per (request, reader) holds the moment
-- they last looked, and anything newer counts as unread.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('peakos-request-reads-v1'));

CREATE TABLE IF NOT EXISTS peakos_service_request_reads (
  workspace_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  user_uid TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT peakos_service_request_reads_pkey
    PRIMARY KEY (workspace_id, request_id, user_uid),
  CONSTRAINT peakos_service_request_reads_request_fk
    FOREIGN KEY (workspace_id, request_id)
    REFERENCES peakos_service_requests(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT peakos_service_request_reads_user_fk
    FOREIGN KEY (user_uid) REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS peakos_service_request_reads_user_idx
  ON peakos_service_request_reads (workspace_id, user_uid);

REVOKE ALL ON peakos_service_request_reads FROM calendar_user;
GRANT SELECT, INSERT, UPDATE ON peakos_service_request_reads TO calendar_user;

COMMIT;
