-- Apply manually, outside a transaction, after bounded workspace backfill.
-- CREATE INDEX CONCURRENTLY cannot run inside the application's startup
-- migration transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS events_workspace_alive_date_idx
  ON events(workspace_id, deleted, date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_rooms_workspace_created_idx
  ON chat_rooms(workspace_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS projects_workspace_status_idx
  ON projects(workspace_id, status, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS peakos_intake_workspace_date_idx
  ON peakos_intake(workspace_id, date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS peakos_monthly_workspace_view_date_idx
  ON peakos_monthly(workspace_id, view, date DESC);
