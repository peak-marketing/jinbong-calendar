'use strict';

const path = require('node:path');
const {
  getPeakosCollaborationContext,
  isPeakosCollaborationAuthenticated,
} = require('./peakos-collaboration-routes');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260816_peakos_workspace_event_hides.sql',
);
const EVENT_HIDE_TABLE = 'peakos_workspace_event_hides';

class PeakosEventVisibilityError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PeakosEventVisibilityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPeakosEventVisibilityRequest(req) {
  return isPeakosCollaborationAuthenticated(req) && !!getPeakosCollaborationContext(req);
}

function validateSqlAlias(value) {
  const alias = String(value || 'e');
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new TypeError('event SQL alias가 올바르지 않습니다.');
  return alias;
}

function validateSqlParameter(value) {
  const parameter = Number(value);
  if (!Number.isSafeInteger(parameter) || parameter < 1 || parameter > 1000) {
    throw new TypeError('workspace SQL parameter가 올바르지 않습니다.');
  }
  return parameter;
}

// Adds no bound value: callers reuse the workspace parameter already present
// in the canonical query. Legacy requests deliberately receive an empty
// predicate, preserving the Paragon query and its visibility semantics.
function eventHiddenPredicate(req, {
  eventAlias = 'e',
  workspaceParameter,
} = {}) {
  if (!isPeakosEventVisibilityRequest(req)) return '';
  const alias = validateSqlAlias(eventAlias);
  const parameter = validateSqlParameter(workspaceParameter);
  return ` AND NOT EXISTS (
    SELECT 1 FROM ${EVENT_HIDE_TABLE} event_hide
    WHERE event_hide.workspace_id = $${parameter}
      AND event_hide.event_id = ${alias}.id
  )`;
}

function normalizedContextEventId(req) {
  if (!isPeakosEventVisibilityRequest(req)) return null;
  const suffix = String(getPeakosCollaborationContext(req)?.suffix || '');
  const parts = suffix.split('/');
  if (parts.length < 3 || parts[0] !== '' || parts[1] !== 'events') return null;
  if (!parts[2] || [
    'checklist-summary',
    'checklist-instructions',
    'instructors',
    'reorder',
  ].includes(parts[2])) return null;
  if (parts[3] === 'os-hide') return null;
  try {
    const eventId = decodeURIComponent(parts[2]);
    if (!eventId || eventId.length > 200 || /[\u0000-\u001f\u007f]/.test(eventId)) return null;
    return eventId;
  } catch (_) {
    return null;
  }
}

function sendVisibilityError(res, error) {
  const missingMigration = error?.code === '42P01' || error?.code === '42703';
  const status = missingMigration ? 503 : Number(error?.statusCode || error?.status) || 500;
  const code = missingMigration
    ? 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED'
    : String(error?.code || 'PEAKOS_EVENT_VISIBILITY_ERROR');
  const message = status >= 500
    ? (missingMigration ? 'OS 일정 숨김 migration이 필요합니다.' : 'OS 일정 표시 상태를 처리하지 못했습니다.')
    : error.message;
  return res.status(status).json({ code, error: message });
}

function createPeakosEventVisibilityGuard({ pool, workspaceIdForRequest } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  if (typeof workspaceIdForRequest !== 'function') throw new TypeError('workspaceIdForRequest가 필요합니다.');

  return async function peakosEventVisibilityGuard(req, res, next) {
    const eventId = normalizedContextEventId(req);
    if (!eventId) return next();
    try {
      const workspaceId = workspaceIdForRequest(req);
      const hidden = await pool.query(
        `SELECT 1
           FROM ${EVENT_HIDE_TABLE}
          WHERE workspace_id = $1 AND event_id = $2`,
        [workspaceId, eventId],
      );
      if (!hidden.rows[0]) return next();
      return res.status(404).json({
        code: 'PEAKOS_EVENT_HIDDEN',
        error: 'OS에서 숨긴 일정입니다.',
      });
    } catch (error) {
      return sendVisibilityError(res, error);
    }
  };
}

async function ensurePeakosEventVisibilityInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const requiredColumns = ['workspace_id', 'event_id', 'hidden_by_uid', 'hidden_at'];
  const result = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2::text[])
      ORDER BY column_name`,
    [EVENT_HIDE_TABLE, requiredColumns],
  );
  const actual = new Set(result.rows.map(row => String(row.column_name)));
  const missing = requiredColumns.filter(column => !actual.has(column));
  if (missing.length) {
    const error = new Error(`OS 일정 숨김 migration이 필요합니다: ${missing.join(', ')}`);
    error.code = 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED';
    error.missing = missing;
    throw error;
  }

  const requiredConstraints = new Map([
    ['peakos_workspace_event_hides_pkey', /PRIMARY KEY \(workspace_id, event_id\)/],
    ['peakos_workspace_event_hides_workspace_fk', /FOREIGN KEY \(workspace_id\) REFERENCES (?:public\.)?peakos_workspaces\(id\)/],
    ['peakos_workspace_event_hides_event_fk', /FOREIGN KEY \(event_id\) REFERENCES (?:public\.)?events\(id\).*ON DELETE CASCADE/],
    [
      'peakos_workspace_event_hides_actor_membership_fk',
      /FOREIGN KEY \(workspace_id, hidden_by_uid\) REFERENCES (?:public\.)?peakos_workspace_memberships\(workspace_id, user_uid\)/,
    ],
  ]);
  const constraints = await pool.query(
    `SELECT constraint_row.conname,
            pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid = to_regclass(current_schema() || '.' || $1)
        AND constraint_row.conname = ANY($2::text[])`,
    [EVENT_HIDE_TABLE, [...requiredConstraints.keys()]],
  );
  const definitionByName = new Map(constraints.rows.map(row => [
    String(row.conname),
    String(row.definition || '').replace(/\s+/g, ' ').trim(),
  ]));
  const invalidConstraints = [...requiredConstraints].filter(([name, pattern]) => (
    !pattern.test(definitionByName.get(name) || '')
  )).map(([name]) => name);
  if (invalidConstraints.length) {
    const error = new Error(`OS 일정 숨김 constraint migration이 필요합니다: ${invalidConstraints.join(', ')}`);
    error.code = 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED';
    error.missing = invalidConstraints;
    throw error;
  }

  const indexes = await pool.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = $1
        AND indexname = $2`,
    [EVENT_HIDE_TABLE, 'peakos_workspace_event_hides_event_idx'],
  );
  if (!indexes.rows.some(row => /\(event_id\)/.test(String(row.indexdef || '').replace(/\s+/g, ' ')))) {
    const error = new Error('OS 일정 숨김 event index migration이 필요합니다.');
    error.code = 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED';
    error.missing = ['peakos_workspace_event_hides_event_idx'];
    throw error;
  }

  const requiredTriggers = new Map([
    ['peakos_workspace_event_hides_workspace_guard', EVENT_HIDE_TABLE],
    ['peakos_events_workspace_hide_guard', 'events'],
  ]);
  const triggers = await pool.query(
    `SELECT trigger_row.tgname, relation.relname AS table_name
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      WHERE trigger_row.tgname = ANY($1::text[])
        AND namespace_row.nspname = current_schema()
        AND trigger_row.tgisinternal = FALSE`,
    [[...requiredTriggers.keys()]],
  );
  const actualTriggers = new Map(triggers.rows.map(row => [String(row.tgname), String(row.table_name)]));
  const missingTriggers = [...requiredTriggers].filter(([name, tableName]) => (
    actualTriggers.get(name) !== tableName
  )).map(([name]) => name);
  if (missingTriggers.length) {
    const error = new Error(`OS 일정 숨김 workspace guard migration이 필요합니다: ${missingTriggers.join(', ')}`);
    error.code = 'PEAKOS_EVENT_VISIBILITY_MIGRATION_REQUIRED';
    error.missing = missingTriggers;
    throw error;
  }
  return Object.freeze({
    ready: true,
    table: EVENT_HIDE_TABLE,
    columns: requiredColumns.length,
    constraints: requiredConstraints.size,
    indexes: 1,
    triggers: requiredTriggers.size,
  });
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertOsHideRequest(req) {
  if (!isPeakosEventVisibilityRequest(req)) {
    throw new PeakosEventVisibilityError(404, 'PEAKOS_EVENT_HIDE_ROUTE_NOT_FOUND', '요청한 경로를 찾을 수 없습니다.');
  }
  if (req.userDoc?.approved !== true || req.userDoc?.is_active === false) {
    throw new PeakosEventVisibilityError(403, 'PEAKOS_EVENT_HIDE_ACCOUNT_FORBIDDEN', '승인된 활성 계정만 사용할 수 있습니다.');
  }
}

async function loadOwnedEventForHide(db, req, workspaceId, peakWorkspaceId) {
  const result = await db.query(
    `SELECT id, owner_id
       FROM events
      WHERE id = $1
        AND deleted = false
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
      FOR UPDATE`,
    [req.params.id, workspaceId, peakWorkspaceId],
  );
  const event = result.rows[0];
  if (!event) {
    throw new PeakosEventVisibilityError(404, 'PEAKOS_EVENT_NOT_FOUND', '일정을 찾을 수 없습니다.');
  }
  if (req.userDoc?.role !== 'admin' && String(event.owner_id) !== String(req.uid)) {
    throw new PeakosEventVisibilityError(403, 'PEAKOS_EVENT_HIDE_FORBIDDEN', '일정 작성자 또는 관리자만 OS에서 숨길 수 있습니다.');
  }
  return event;
}

function registerPeakosEventVisibilityRoutes({
  app,
  authMiddleware,
  pool,
  workspaceIdForRequest,
  peakWorkspaceId,
} = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('app이 필요합니다.');
  }
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware가 필요합니다.');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  if (typeof workspaceIdForRequest !== 'function') throw new TypeError('workspaceIdForRequest가 필요합니다.');
  if (!peakWorkspaceId) throw new TypeError('peakWorkspaceId가 필요합니다.');

  app.post('/api/events/:id/os-hide', authMiddleware, async (req, res) => {
    try {
      assertOsHideRequest(req);
      const workspaceId = workspaceIdForRequest(req);
      const row = await withTransaction(pool, async db => {
        const event = await loadOwnedEventForHide(db, req, workspaceId, peakWorkspaceId);
        const inserted = await db.query(
          `INSERT INTO ${EVENT_HIDE_TABLE}
            (workspace_id, event_id, hidden_by_uid)
           VALUES ($1,$2,$3)
           ON CONFLICT (workspace_id, event_id) DO NOTHING
           RETURNING workspace_id, event_id, hidden_at`,
          [workspaceId, event.id, req.uid],
        );
        if (inserted.rows[0]) return inserted.rows[0];
        const existing = await db.query(
          `SELECT workspace_id, event_id, hidden_at
             FROM ${EVENT_HIDE_TABLE}
            WHERE workspace_id = $1 AND event_id = $2`,
          [workspaceId, event.id],
        );
        if (!existing.rows[0]) {
          throw new PeakosEventVisibilityError(409, 'PEAKOS_EVENT_HIDE_RETRY', '일정 숨김 상태가 변경되었습니다. 다시 시도해 주세요.');
        }
        return existing.rows[0];
      });
      return res.json({
        ok: true,
        eventId: String(row.event_id),
        workspaceId: String(row.workspace_id),
        hiddenAt: row.hidden_at,
      });
    } catch (error) {
      return sendVisibilityError(res, error);
    }
  });

  app.delete('/api/events/:id/os-hide', authMiddleware, async (req, res) => {
    try {
      assertOsHideRequest(req);
      const workspaceId = workspaceIdForRequest(req);
      const eventId = await withTransaction(pool, async db => {
        const event = await loadOwnedEventForHide(db, req, workspaceId, peakWorkspaceId);
        await db.query(
          `DELETE FROM ${EVENT_HIDE_TABLE}
            WHERE workspace_id = $1 AND event_id = $2`,
          [workspaceId, event.id],
        );
        return event.id;
      });
      return res.json({
        ok: true,
        eventId: String(eventId),
        workspaceId: String(workspaceId),
        hiddenAt: null,
      });
    } catch (error) {
      return sendVisibilityError(res, error);
    }
  });
}

module.exports = {
  EVENT_HIDE_TABLE,
  MIGRATION_PATH,
  PeakosEventVisibilityError,
  createPeakosEventVisibilityGuard,
  ensurePeakosEventVisibilityInfrastructure,
  eventHiddenPredicate,
  isPeakosEventVisibilityRequest,
  normalizedContextEventId,
  registerPeakosEventVisibilityRoutes,
};
