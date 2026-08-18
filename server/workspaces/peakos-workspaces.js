'use strict';

const path = require('node:path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260809_peakos_workspaces.sql',
);

const PEAK_WORKSPACE_ID = 'ws_peak';
const WORKSPACE_HEADER = 'x-peakos-workspace';
const WORKSPACE_AREAS = Object.freeze([
  'calendar',
  'chat',
  'projects',
  'settlements',
  'documents',
  'sales',
]);
const PERMISSION_LEVELS = Object.freeze(['none', 'read', 'write']);
const WORKSPACES = Object.freeze([
  Object.freeze({ id: PEAK_WORKSPACE_ID, slug: 'peak', name: '피크마케팅 본사', kind: 'headquarters' }),
  Object.freeze({ id: 'ws_build_solution', slug: 'build-solution', name: '빌드솔루션', kind: 'company' }),
  Object.freeze({ id: 'ws_jeonju', slug: 'jeonju', name: '피크마케팅 전주지사', kind: 'branch' }),
  Object.freeze({ id: 'ws_daegu', slug: 'daegu', name: '피크마케팅 대구지사', kind: 'branch' }),
]);
const WORKSPACE_BY_SLUG = new Map(WORKSPACES.map(workspace => [workspace.slug, workspace]));
const REQUIRED_WORKSPACE_COLUMNS = Object.freeze([
  ['peakos_workspaces', 'id'],
  ['peakos_workspace_memberships', 'workspace_id'],
  ['peakos_workspace_membership_audit', 'workspace_id'],
  ['peakos_workspace_bootstrap_state', 'key'],
  ['peakos_workspace_documents', 'workspace_id'],
  ['events', 'workspace_id'],
  ['custom_event_types', 'workspace_id'],
  ['custom_todo_cats', 'workspace_id'],
  ['chat_rooms', 'workspace_id'],
  ['chat_room_groups', 'workspace_id'],
  ['projects', 'workspace_id'],
  ['peakos_intake', 'workspace_id'],
  ['peakos_monthly', 'workspace_id'],
  ['peakos_intake_tombstones', 'workspace_id'],
  ['peakos_intake_audit_log', 'workspace_id'],
  ['peakos_monthly_tombstones', 'workspace_id'],
  ['peakos_monthly_audit_log', 'workspace_id'],
  ['peakos_settlement_import_runs', 'workspace_id'],
  ['peakos_price', 'workspace_id'],
  ['peakos_fund', 'workspace_id'],
]);
const REQUIRED_COMPOSITE_PRIMARY_KEYS = Object.freeze({
  peakos_intake_tombstones: 'PRIMARY KEY (workspace_id, target_id)',
  peakos_monthly_tombstones: 'PRIMARY KEY (workspace_id, target_id)',
  peakos_price: 'PRIMARY KEY (workspace_id, key)',
  peakos_fund: 'PRIMARY KEY (workspace_id, id)',
});
const OVERSIGHT_NAMES = Object.freeze(['패션TV봉이', '박종원', '김대호', '손명아']);

const DIRECT_PERMISSIONS = Object.freeze({
  calendar: 'write',
  chat: 'write',
  projects: 'write',
  settlements: 'write',
  // Upload/delete remains a separate document-manager grant. A workspace
  // membership alone never makes every employee a company-document editor.
  documents: 'read',
  sales: 'write',
});
const OVERSIGHT_PERMISSIONS = Object.freeze({
  calendar: 'none',
  chat: 'none',
  projects: 'read',
  settlements: 'read',
  documents: 'read',
  sales: 'read',
});

class WorkspaceAccessError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeWorkspaceSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) return null;
  return slug;
}

function readWorkspaceSlugHeader(req) {
  const raw = typeof req?.get === 'function'
    ? req.get(WORKSPACE_HEADER)
    : req?.headers?.[WORKSPACE_HEADER];
  if (Array.isArray(raw)) return null;
  return normalizeWorkspaceSlug(raw);
}

function normalizePermissions(value, role = 'member') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = role === 'oversight' ? OVERSIGHT_PERMISSIONS : DIRECT_PERMISSIONS;
  return Object.freeze(Object.fromEntries(WORKSPACE_AREAS.map(area => {
    const permission = PERMISSION_LEVELS.includes(source[area]) ? source[area] : defaults[area];
    return [area, permission];
  })));
}

function serializeWorkspaceRow(row) {
  const role = String(row.membership_role || row.role || 'member');
  const permissions = normalizePermissions(row.permissions, role);
  return Object.freeze({
    id: String(row.workspace_id || row.id),
    slug: String(row.slug),
    name: String(row.name),
    kind: String(row.kind),
    role,
    permissions,
    headquartersOversight: role === 'oversight',
    is_default: row.is_default === true,
  });
}

function permissionAllows(permission, action) {
  if (action === 'read') return permission === 'read' || permission === 'write';
  if (action === 'write') return permission === 'write';
  return false;
}

function sendWorkspaceError(res, error) {
  const status = Number(error?.statusCode) || 500;
  const code = String(error?.code || 'PEAKOS_WORKSPACE_ERROR');
  const message = status >= 500 ? '워크스페이스를 확인하지 못했습니다.' : error.message;
  return res.status(status).json({ code, error: message });
}

function workspaceRequestIsMutation(req) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(req?.method || '').toUpperCase());
}

function workspacePublicAttachmentMutation(req) {
  if (!workspaceRequestIsMutation(req)) return false;
  const pathname = String(req?.path || req?.originalUrl || '').split('?')[0];
  return /^\/api\/chat-rooms\/[^/]+\/(?:upload|upload-file)\/?$/.test(pathname)
    || /^\/api\/projects\/upload\/?$/.test(pathname);
}

function workspaceSlugForGroup({ groupId, workspaceSlug } = {}) {
  if (workspaceSlug !== undefined && workspaceSlug !== null && String(workspaceSlug).trim() !== '') {
    const explicit = normalizeWorkspaceSlug(workspaceSlug);
    if (!explicit || !WORKSPACE_BY_SLUG.has(explicit)) {
      throw new WorkspaceAccessError('올바르지 않은 워크스페이스입니다.', 'PEAKOS_WORKSPACE_INVALID', 400);
    }
    return explicit;
  }
  const immutableGroupId = String(groupId || '').trim().toLowerCase();
  if (immutableGroupId === 'daegu') return 'daegu';
  if (immutableGroupId === 'jeonju') return 'jeonju';
  return 'peak';
}

function parseAccessUidMap(environment = process.env) {
  let value;
  try {
    value = JSON.parse(String(environment.PEAKOS_ACCESS_UIDS_JSON || ''));
  } catch (_) {
    throw new Error('PEAKOS_ACCESS_UIDS_JSON 형식이 올바르지 않습니다.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PEAKOS_ACCESS_UIDS_JSON 설정이 필요합니다.');
  }
  const uidByName = new Map();
  const seen = new Set();
  for (const name of OVERSIGHT_NAMES) {
    const uid = String(value[name] || '').trim();
    if (!/^[A-Za-z0-9:_-]{6,256}$/.test(uid) || seen.has(uid)) {
      throw new Error('본사 지사 열람 권한 UID가 누락·중복되었거나 올바르지 않습니다.');
    }
    uidByName.set(name, uid);
    seen.add(uid);
  }
  return uidByName;
}

async function ensurePeakosWorkspaceInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const params = [];
  const values = REQUIRED_WORKSPACE_COLUMNS.map(([tableName, columnName]) => {
    params.push(tableName, columnName);
    return `($${params.length - 1}::text,$${params.length}::text)`;
  });
  const missing = await pool.query(
    `WITH required(table_name, column_name) AS (VALUES ${values.join(',')})
     SELECT required.table_name, required.column_name
       FROM required
      WHERE NOT EXISTS (
        SELECT 1
          FROM information_schema.columns existing
         WHERE existing.table_schema = current_schema()
           AND existing.table_name = required.table_name
           AND existing.column_name = required.column_name
      )
      ORDER BY required.table_name, required.column_name`,
    params,
  );
  if (missing.rows.length) {
    const detail = missing.rows
      .map(row => `${row.table_name}.${row.column_name}`)
      .slice(0, 8)
      .join(', ');
    const error = new Error(`PEAK OS workspace 운영 migration이 필요합니다: ${detail}`);
    error.code = 'PEAKOS_WORKSPACE_MIGRATION_REQUIRED';
    throw error;
  }

  const workspaceRows = await pool.query(
    `SELECT id, slug
       FROM peakos_workspaces
      WHERE id = ANY($1::text[])
      ORDER BY id`,
    [WORKSPACES.map(workspace => workspace.id)],
  );
  const actualById = new Map(workspaceRows.rows.map(row => [String(row.id), String(row.slug)]));
  const invalidWorkspace = WORKSPACES.find(workspace => actualById.get(workspace.id) !== workspace.slug);
  if (invalidWorkspace) {
    const error = new Error('PEAK OS workspace seed가 누락되었거나 기준 slug와 다릅니다.');
    error.code = 'PEAKOS_WORKSPACE_MIGRATION_REQUIRED';
    throw error;
  }

  const keyTables = Object.keys(REQUIRED_COMPOSITE_PRIMARY_KEYS);
  const primaryKeys = await pool.query(
    `SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND constraint_row.contype = 'p'
        AND relation.relname = ANY($1::text[])`,
    [keyTables],
  );
  const primaryKeyByTable = new Map(primaryKeys.rows.map(row => [
    String(row.table_name),
    String(row.definition).replace(/\s+/g, ' ').trim(),
  ]));
  const invalidPrimaryKey = keyTables.find(tableName => (
    primaryKeyByTable.get(tableName) !== REQUIRED_COMPOSITE_PRIMARY_KEYS[tableName]
  ));
  if (invalidPrimaryKey) {
    const error = new Error(`PEAK OS workspace composite key migration이 필요합니다: ${invalidPrimaryKey}`);
    error.code = 'PEAKOS_WORKSPACE_MIGRATION_REQUIRED';
    throw error;
  }
  return Object.freeze({ checkedColumns: REQUIRED_WORKSPACE_COLUMNS.length, workspaces: WORKSPACES.length });
}

async function backfillPeakWorkspaceBatches(pool, {
  table,
  primaryKey = 'id',
  batchSize = 2_000,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const allowedTables = new Set([
    'events', 'custom_event_types', 'custom_todo_cats', 'chat_rooms', 'chat_room_groups',
    'projects', 'service_requests', 'ideas', 'peakos_intake', 'peakos_monthly',
    'peakos_credit', 'peakos_credit_requests', 'peakos_finance_requests',
    'peakos_bank_accounts', 'peakos_bank_transactions', 'peakos_bank_allocations',
    'peakos_settlement_import_runs', 'peakos_fund', 'peakos_price',
  ]);
  if (!allowedTables.has(table) || !/^[a-z_][a-z0-9_]*$/.test(primaryKey)) {
    throw new TypeError('허용되지 않은 워크스페이스 backfill 대상입니다.');
  }
  const limit = Math.max(1, Math.min(Number(batchSize) || 2_000, 10_000));
  let updated = 0;
  while (true) {
    const result = await pool.query(
      `WITH batch AS (
         SELECT ${primaryKey}
           FROM ${table}
          WHERE workspace_id IS NULL
          ORDER BY ${primaryKey}
          LIMIT $1
       )
       UPDATE ${table} target
          SET workspace_id = $2
         FROM batch
        WHERE target.${primaryKey} = batch.${primaryKey}`,
      [limit, PEAK_WORKSPACE_ID],
    );
    const count = Number(result.rowCount || 0);
    updated += count;
    if (count < limit) break;
  }
  return updated;
}

function createPeakosWorkspaceService({ pool, environment = process.env, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');

  // Cross-workspace visibility is a separate, immutable-identity capability.
  // It must not be inferred from a display name, global role, preview persona,
  // or leftover membership rows. If the UID configuration is unavailable the
  // policy fails closed: users retain only their canonical direct workspace.
  let portfolioUidSet;
  function canAccessWorkspacePortfolio(uid) {
    if (portfolioUidSet === undefined) {
      try {
        portfolioUidSet = new Set(parseAccessUidMap(environment).values());
      } catch (_) {
        portfolioUidSet = new Set();
      }
    }
    return portfolioUidSet.has(String(uid || '').trim());
  }

  async function resolvePrimaryDirectForUser(uid) {
    const result = await pool.query(
      `SELECT w.id AS workspace_id, w.slug, w.name, w.kind,
              m.role AS membership_role, m.permissions, m.is_default
         FROM peakos_workspace_memberships m
         JOIN peakos_workspaces w ON w.id = m.workspace_id
        WHERE m.user_uid = $1
          AND m.active = TRUE
          AND m.role <> 'oversight'
          AND w.active = TRUE
        ORDER BY m.is_default DESC, m.created_at, w.slug
        LIMIT 1`,
      [uid],
    );
    return result.rows[0] ? serializeWorkspaceRow(result.rows[0]) : null;
  }

  async function seedOversightMemberships() {
    const uidByName = parseAccessUidMap(environment);
    const uids = [...uidByName.values()];
    if (typeof pool.connect !== 'function') throw new TypeError('oversight reconcile에는 pool.connect가 필요합니다.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query(
        `SELECT uid
           FROM users
          WHERE uid = ANY($1::text[])
            AND approved = true
            AND COALESCE(is_active, true) = true`,
        [uids],
      );
      const activeUids = new Set(active.rows.map(row => String(row.uid)));
      if (activeUids.size !== uids.length || uids.some(uid => !activeUids.has(uid))) {
        throw new Error('본사 지사 열람 대상 중 미승인·비활성 계정이 있습니다.');
      }
      const branchWorkspaceIds = WORKSPACES
        .filter(item => item.id !== PEAK_WORKSPACE_ID)
        .map(item => item.id);
      // Environment UID rotation must revoke prior policy grants in the same
      // transaction as the current exact-four upsert. Direct memberships and
      // manually managed rows are deliberately outside this reconciliation.
      await client.query(
        `WITH deactivated AS (
           UPDATE peakos_workspace_memberships
              SET active = FALSE,
                  is_default = FALSE,
                  updated_at = NOW()
            WHERE workspace_id = ANY($1::text[])
              AND role = 'oversight'
              AND membership_source = 'hq_oversight_policy'
              AND NOT (user_uid = ANY($2::text[]))
              AND active = TRUE
          RETURNING workspace_id, user_uid, role, permissions
         )
         INSERT INTO peakos_workspace_membership_audit
           (workspace_id, target_uid, actor_uid, action, before_state, after_state)
         SELECT workspace_id,
                user_uid,
                'system:workspace-bootstrap',
                'deactivate',
                jsonb_build_object('role', role, 'permissions', permissions, 'active', TRUE),
                jsonb_build_object('role', role, 'permissions', permissions, 'active', FALSE)
           FROM deactivated`,
        [branchWorkspaceIds, uids],
      );
      const permissions = JSON.stringify(OVERSIGHT_PERMISSIONS);
      for (const workspaceId of branchWorkspaceIds) {
        await client.query(
          `INSERT INTO peakos_workspace_memberships
            (workspace_id, user_uid, role, permissions, is_default, membership_source, created_by)
           SELECT $1, candidate_uid, 'oversight', $2::jsonb, FALSE, 'hq_oversight_policy', 'system:workspace-bootstrap'
             FROM unnest($3::text[]) AS candidate(candidate_uid)
           ON CONFLICT (workspace_id, user_uid) DO UPDATE
             SET role = 'oversight',
                 permissions = EXCLUDED.permissions,
                 is_default = FALSE,
                 membership_source = EXCLUDED.membership_source,
                 active = TRUE,
                 updated_at = NOW()
           WHERE peakos_workspace_memberships.role = 'oversight'`,
          [workspaceId, permissions, uids],
        );
      }
      await client.query('COMMIT');
      logger?.log?.(`[PEAK OS] 지사 read-only 본사 열람자 ${uids.length}명 권한 확인`);
      return uids.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function listForUser(uid) {
    if (!canAccessWorkspacePortfolio(uid)) {
      const primary = await resolvePrimaryDirectForUser(uid);
      return primary ? [primary] : [];
    }
    const result = await pool.query(
      `SELECT w.id AS workspace_id, w.slug, w.name, w.kind,
              m.role AS membership_role, m.permissions, m.is_default
         FROM peakos_workspace_memberships m
         JOIN peakos_workspaces w ON w.id = m.workspace_id
        WHERE m.user_uid = $1
          AND m.active = TRUE
          AND w.active = TRUE
        ORDER BY m.is_default DESC,
                 CASE WHEN w.id = $2 THEN 0 ELSE 1 END,
                 w.name`,
      [uid, PEAK_WORKSPACE_ID],
    );
    return result.rows.map(serializeWorkspaceRow);
  }

  async function resolveForUser(uid, slug) {
    const normalized = normalizeWorkspaceSlug(slug);
    if (!normalized || !WORKSPACE_BY_SLUG.has(normalized)) {
      throw new WorkspaceAccessError('올바르지 않은 워크스페이스입니다.', 'PEAKOS_WORKSPACE_INVALID', 400);
    }
    if (!canAccessWorkspacePortfolio(uid)) {
      const primary = await resolvePrimaryDirectForUser(uid);
      if (!primary || primary.slug !== normalized) {
        throw new WorkspaceAccessError(
          '이 워크스페이스에 접근할 수 없습니다.',
          'PEAKOS_WORKSPACE_FORBIDDEN',
          403,
        );
      }
      return primary;
    }
    const result = await pool.query(
      `SELECT w.id AS workspace_id, w.slug, w.name, w.kind,
              m.role AS membership_role, m.permissions, m.is_default
         FROM peakos_workspaces w
         JOIN peakos_workspace_memberships m ON m.workspace_id = w.id
        WHERE w.slug = $1
          AND w.active = TRUE
          AND m.user_uid = $2
          AND m.active = TRUE`,
      [normalized, uid],
    );
    if (!result.rows[0]) {
      throw new WorkspaceAccessError('이 워크스페이스에 접근할 수 없습니다.', 'PEAKOS_WORKSPACE_FORBIDDEN', 403);
    }
    return serializeWorkspaceRow(result.rows[0]);
  }

  async function resolveDefaultForUser(uid) {
    return resolvePrimaryDirectForUser(uid);
  }

  async function attachRequestWorkspace(req, { required = false } = {}) {
    if (!req?.uid) {
      throw new WorkspaceAccessError('로그인이 필요합니다.', 'PEAKOS_WORKSPACE_UNAUTHENTICATED', 401);
    }
    const rawHeader = typeof req.get === 'function'
      ? req.get(WORKSPACE_HEADER)
      : req.headers?.[WORKSPACE_HEADER];
    if (rawHeader !== undefined && rawHeader !== null && String(rawHeader).trim() !== '') {
      const slug = readWorkspaceSlugHeader(req);
      if (!slug) {
        throw new WorkspaceAccessError('올바르지 않은 워크스페이스 헤더입니다.', 'PEAKOS_WORKSPACE_INVALID', 400);
      }
      req.workspace = await resolveForUser(req.uid, slug);
      req.workspaceSelectedByHeader = true;
      return req.workspace;
    }
    if (required) {
      throw new WorkspaceAccessError('워크스페이스를 선택해 주세요.', 'PEAKOS_WORKSPACE_REQUIRED', 400);
    }
    req.workspace = await resolveDefaultForUser(req.uid);
    req.workspaceSelectedByHeader = false;
    return req.workspace;
  }

  function requireWorkspace({ area, action, requireHeader = false } = {}) {
    if (!WORKSPACE_AREAS.includes(area)) throw new TypeError('올바른 workspace area가 필요합니다.');
    if (!['read', 'write'].includes(action)) throw new TypeError('workspace action은 read 또는 write여야 합니다.');
    return async function peakosWorkspaceMiddleware(req, res, next) {
      try {
        if (!req.workspace) await attachRequestWorkspace(req, { required: requireHeader });
        if (requireHeader && req.workspaceSelectedByHeader !== true) {
          throw new WorkspaceAccessError('워크스페이스를 선택해 주세요.', 'PEAKOS_WORKSPACE_REQUIRED', 400);
        }
        const workspace = req.workspace;
        res.set?.('Cache-Control', 'private, no-store');
        res.vary?.('X-PeakOS-Workspace');
        res.vary?.('Authorization');
        const permission = workspace.permissions[area];
        if (!permissionAllows(permission, action)) {
          throw new WorkspaceAccessError(
            action === 'write' ? '이 워크스페이스는 읽기 전용입니다.' : '이 영역을 볼 수 없습니다.',
            action === 'write' ? 'PEAKOS_WORKSPACE_READ_ONLY' : 'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
            403,
          );
        }
        if (workspace.headquartersOversight && workspaceRequestIsMutation(req)) {
          throw new WorkspaceAccessError('본사 열람 권한으로 지사 데이터를 변경할 수 없습니다.', 'PEAKOS_WORKSPACE_READ_ONLY', 403);
        }
        next();
      } catch (error) {
        sendWorkspaceError(res, error);
      }
    };
  }

  function requireSelectedWorkspace() {
    return async function peakosSelectedWorkspaceMiddleware(req, res, next) {
      try {
        if (!req.workspace) await attachRequestWorkspace(req, { required: true });
        if (req.workspaceSelectedByHeader !== true) {
          throw new WorkspaceAccessError('워크스페이스를 선택해 주세요.', 'PEAKOS_WORKSPACE_REQUIRED', 400);
        }
        res.set?.('Cache-Control', 'private, no-store');
        res.vary?.('X-PeakOS-Workspace');
        res.vary?.('Authorization');
        next();
      } catch (error) {
        sendWorkspaceError(res, error);
      }
    };
  }

  async function userHasDirectMembership(userUid, workspaceId) {
    const result = await pool.query(
      `SELECT 1
         FROM peakos_workspace_memberships
        WHERE workspace_id = $1
          AND user_uid = $2
          AND active = TRUE
          AND role <> 'oversight'`,
      [workspaceId, userUid],
    );
    return !!result.rows[0];
  }

  async function assertNoActiveWorkspaceResponsibilities(db, userUid, workspaceIds) {
    const affectedWorkspaceIds = [...new Set((Array.isArray(workspaceIds) ? workspaceIds : [])
      .map(workspaceId => String(workspaceId || '').trim())
      .filter(Boolean))];
    if (!affectedWorkspaceIds.length) return;

    const dependency = await db.query(
      `WITH active_responsibilities AS (
         SELECT project_member.workspace_id,
                project_member.project_id,
                project.name AS project_name,
                'project_member'::text AS responsibility
           FROM peakos_structured_project_members project_member
           JOIN peakos_structured_projects project
             ON project.workspace_id = project_member.workspace_id
            AND project.id = project_member.project_id
            AND project.status = 'active'
          WHERE project_member.workspace_id = ANY($2::text[])
            AND project_member.active = TRUE
            AND project_member.user_uid = $1
         UNION ALL
         SELECT project.workspace_id,
                project.id AS project_id,
                project.name AS project_name,
                'project_lead'::text AS responsibility
           FROM peakos_structured_projects project
          WHERE project.workspace_id = ANY($2::text[])
            AND project.status = 'active'
            AND project.lead_uid = $1
         UNION ALL
         SELECT medium.workspace_id,
                medium.project_id,
                project.name AS project_name,
                'medium_manager'::text AS responsibility
           FROM peakos_structured_project_medium_categories medium
           JOIN peakos_structured_projects project
             ON project.workspace_id = medium.workspace_id
            AND project.id = medium.project_id
            AND project.status = 'active'
          WHERE medium.workspace_id = ANY($2::text[])
            AND medium.active = TRUE
            AND medium.manager_uid = $1
         UNION ALL
         SELECT task.workspace_id,
                task.project_id,
                project.name AS project_name,
                'open_task'::text AS responsibility
           FROM peakos_structured_project_tasks task
           JOIN peakos_structured_projects project
             ON project.workspace_id = task.workspace_id
            AND project.id = task.project_id
            AND project.status = 'active'
         WHERE task.workspace_id = ANY($2::text[])
            AND task.status <> 'done'
            AND $1 IN (task.assignee_uid, task.assigned_by_uid, task.reviewer_uid)
         UNION ALL
         SELECT sales_lead.workspace_id,
                sales_lead.id AS project_id,
                sales_lead.company_name AS project_name,
                'active_sales_lead_owner'::text AS responsibility
           FROM peakos_sales_leads sales_lead
          WHERE sales_lead.workspace_id = ANY($2::text[])
            AND sales_lead.archived_at IS NULL
            AND sales_lead.owner_uid = $1
       )
       SELECT workspace_id, project_id, project_name, responsibility
         FROM active_responsibilities
        ORDER BY workspace_id, project_id, responsibility
        LIMIT 1`,
      [userUid, affectedWorkspaceIds],
    );
    if (dependency.rows[0]) {
      throw new WorkspaceAccessError(
        '진행 중인 프로젝트의 팀원·책임 역할 또는 활성 영업 리드 담당을 먼저 이전·정리한 뒤 소속 이동·계정 비활성화·제한 설정을 진행해 주세요.',
        'PEAKOS_WORKSPACE_MEMBER_HAS_ACTIVE_PROJECT_RESPONSIBILITY',
        409,
      );
    }
  }

  async function syncUserDefaultMembership({
    actorUid,
    targetUid,
    groupId,
    workspaceSlug,
    role,
    client: suppliedClient,
  } = {}) {
    const normalizedTargetUid = String(targetUid || '').trim();
    const normalizedActorUid = String(actorUid || '').trim();
    if (!normalizedTargetUid || !normalizedActorUid) {
      throw new WorkspaceAccessError('권한 변경 계정을 확인할 수 없습니다.', 'PEAKOS_WORKSPACE_MEMBER_INVALID', 400);
    }
    const lookupDb = suppliedClient || pool;
    const target = await lookupDb.query(
      `SELECT u.uid, u.role, u.group_id
         FROM users u
        WHERE u.uid = $1
          AND u.approved = TRUE
          AND COALESCE(u.is_active, TRUE) = TRUE`,
      [normalizedTargetUid],
    );
    if (!target.rows[0]) {
      throw new WorkspaceAccessError('승인된 활성 계정만 소속을 지정할 수 있습니다.', 'PEAKOS_WORKSPACE_MEMBER_INVALID', 400);
    }
    let preservedSlug = null;
    if ((workspaceSlug === undefined || workspaceSlug === null || String(workspaceSlug).trim() === '')
        && groupId === undefined) {
      const currentMembership = await lookupDb.query(
        `SELECT w.slug
           FROM peakos_workspace_memberships m
           JOIN peakos_workspaces w ON w.id = m.workspace_id
          WHERE m.user_uid = $1
            AND m.role <> 'oversight'
          ORDER BY m.active DESC, m.is_default DESC, m.updated_at DESC
          LIMIT 1`,
        [normalizedTargetUid],
      );
      preservedSlug = currentMembership.rows[0]?.slug || null;
    }
    const resolvedSlug = workspaceSlugForGroup({
      groupId: groupId !== undefined ? groupId : target.rows[0].group_id,
      workspaceSlug: workspaceSlug || preservedSlug,
    });
    const workspace = WORKSPACE_BY_SLUG.get(resolvedSlug);
    const resolvedRole = ['admin', 'manager', 'member'].includes(role)
      ? role
      : (['admin', 'manager'].includes(target.rows[0].role) ? target.rows[0].role : 'member');
    const db = suppliedClient || (typeof pool.connect === 'function' ? await pool.connect() : pool);
    const ownsTransaction = !suppliedClient && db !== pool;
    try {
      if (ownsTransaction) await db.query('BEGIN');
      const before = await db.query(
        `SELECT workspace_id, role, permissions, is_default, active
           FROM peakos_workspace_memberships
          WHERE user_uid = $1 AND role <> 'oversight'
          FOR UPDATE`,
        [normalizedTargetUid],
      );
      const deactivatedWorkspaceIds = before.rows
        .filter(membership => (
          membership.active === true
          && String(membership.role) !== 'oversight'
          && String(membership.workspace_id) !== workspace.id
        ))
        .map(membership => membership.workspace_id);
      await assertNoActiveWorkspaceResponsibilities(
        db,
        normalizedTargetUid,
        deactivatedWorkspaceIds,
      );
      await db.query(
        `UPDATE peakos_workspace_memberships
            SET active = FALSE, is_default = FALSE, updated_at = NOW()
          WHERE user_uid = $1 AND role <> 'oversight'`,
        [normalizedTargetUid],
      );
      const permissions = JSON.stringify(DIRECT_PERMISSIONS);
      await db.query(
        `INSERT INTO peakos_workspace_memberships
          (workspace_id, user_uid, role, permissions, is_default, membership_source, active, created_by)
         VALUES ($1,$2,$3,$4::jsonb,TRUE,'admin_assignment',TRUE,$5)
         ON CONFLICT (workspace_id, user_uid) DO UPDATE
           SET role = EXCLUDED.role,
               permissions = EXCLUDED.permissions,
               is_default = TRUE,
               membership_source = EXCLUDED.membership_source,
               active = TRUE,
               updated_at = NOW()`,
        [workspace.id, normalizedTargetUid, resolvedRole, permissions, normalizedActorUid],
      );
      await db.query(
        `INSERT INTO peakos_workspace_membership_audit
          (workspace_id, target_uid, actor_uid, action, before_state, after_state)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          workspace.id,
          normalizedTargetUid,
          normalizedActorUid,
          before.rows.length ? 'update' : 'assign',
          JSON.stringify(before.rows),
          JSON.stringify({ workspace_id: workspace.id, role: resolvedRole, is_default: true, active: true }),
        ],
      );
      if (ownsTransaction) await db.query('COMMIT');
      return { workspace_id: workspace.id, slug: workspace.slug, role: resolvedRole };
    } catch (error) {
      if (ownsTransaction) await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (ownsTransaction) db.release();
    }
  }

  async function setUserMembershipsActive({ actorUid, targetUid, active, client: suppliedClient } = {}) {
    const normalizedTargetUid = String(targetUid || '').trim();
    const normalizedActorUid = String(actorUid || '').trim();
    if (!normalizedTargetUid || !normalizedActorUid || typeof active !== 'boolean') {
      throw new WorkspaceAccessError('계정 활성 상태를 확인할 수 없습니다.', 'PEAKOS_WORKSPACE_MEMBER_INVALID', 400);
    }
    const db = suppliedClient || (typeof pool.connect === 'function' ? await pool.connect() : pool);
    const ownsTransaction = !suppliedClient && db !== pool;
    try {
      if (ownsTransaction) await db.query('BEGIN');
      const before = await db.query(
        `SELECT workspace_id, role, permissions, is_default, active
           FROM peakos_workspace_memberships
          WHERE user_uid = $1
            AND ($2::boolean = FALSE OR role = 'oversight')
          FOR UPDATE`,
        [normalizedTargetUid, active],
      );
      if (!active) {
        await assertNoActiveWorkspaceResponsibilities(
          db,
          normalizedTargetUid,
          before.rows
            .filter(membership => membership.active === true && String(membership.role) !== 'oversight')
            .map(membership => membership.workspace_id),
        );
      }
      await db.query(
        `UPDATE peakos_workspace_memberships
            SET active = $2,
                updated_at = NOW()
          WHERE user_uid = $1
            AND ($2::boolean = FALSE OR role = 'oversight')`,
        [normalizedTargetUid, active],
      );
      for (const membership of before.rows) {
        await db.query(
          `INSERT INTO peakos_workspace_membership_audit
            (workspace_id, target_uid, actor_uid, action, before_state, after_state)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [
            membership.workspace_id,
            normalizedTargetUid,
            normalizedActorUid,
            active ? 'reactivate' : 'deactivate',
            JSON.stringify(membership),
            JSON.stringify({ ...membership, active }),
          ],
        );
      }
      if (ownsTransaction) await db.query('COMMIT');
      return before.rows.length;
    } catch (error) {
      if (ownsTransaction) await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (ownsTransaction) db.release();
    }
  }

  async function setUserRestrictionMode({
    actorUid,
    targetUid,
    mode,
    enabled,
    client: suppliedClient,
  } = {}) {
    const normalizedTargetUid = String(targetUid || '').trim();
    const normalizedActorUid = String(actorUid || '').trim();
    const normalizedMode = String(mode || '').trim();
    if (!normalizedTargetUid || !normalizedActorUid
        || !['chat_only', 'external_calendar_only'].includes(normalizedMode)
        || typeof enabled !== 'boolean') {
      throw new WorkspaceAccessError(
        '제한 계정 설정을 확인할 수 없습니다.',
        'PEAKOS_WORKSPACE_RESTRICTION_INVALID',
        400,
      );
    }
    if (!suppliedClient && typeof pool.connect !== 'function') {
      throw new TypeError('제한 계정 변경에는 pool.connect 또는 transaction client가 필요합니다.');
    }
    const db = suppliedClient || await pool.connect();
    const ownsTransaction = !suppliedClient;
    try {
      if (ownsTransaction) await db.query('BEGIN');
      const target = await db.query(
        `SELECT uid, role
           FROM users
          WHERE uid = $1
          FOR UPDATE`,
        [normalizedTargetUid],
      );
      if (!target.rows[0]) {
        throw new WorkspaceAccessError(
          '사용자를 찾을 수 없습니다.',
          'PEAKOS_WORKSPACE_MEMBER_NOT_FOUND',
          404,
        );
      }
      const memberships = await db.query(
        `SELECT workspace_id, role, active
           FROM peakos_workspace_memberships
          WHERE user_uid = $1
            AND active = TRUE
            AND role <> 'oversight'
          ORDER BY workspace_id
          FOR UPDATE`,
        [normalizedTargetUid],
      );
      if (enabled && String(target.rows[0].role) === 'admin') {
        throw new WorkspaceAccessError(
          normalizedMode === 'chat_only'
            ? 'admin 계정은 chat-only로 제한할 수 없습니다.'
            : 'admin 계정은 외부 캘린더 계정으로 제한할 수 없습니다.',
          'PEAKOS_WORKSPACE_ADMIN_RESTRICTION_FORBIDDEN',
          400,
        );
      }
      if (enabled) {
        await assertNoActiveWorkspaceResponsibilities(
          db,
          normalizedTargetUid,
          memberships.rows.map(membership => membership.workspace_id),
        );
      }
      if (normalizedMode === 'chat_only') {
        await db.query(
          'UPDATE users SET chat_only = $1 WHERE uid = $2',
          [enabled, normalizedTargetUid],
        );
      } else {
        await db.query(
          `UPDATE users
              SET external_calendar_only = $1,
                  chat_only = CASE WHEN $1 THEN FALSE ELSE chat_only END,
                  can_view_all_attendance = CASE WHEN $1 THEN FALSE ELSE can_view_all_attendance END,
                  can_view_all_reports = CASE WHEN $1 THEN FALSE ELSE can_view_all_reports END,
                  can_manage_team = CASE WHEN $1 THEN FALSE ELSE can_manage_team END,
                  viewable_groups = CASE WHEN $1 THEN ARRAY[]::text[] ELSE viewable_groups END
            WHERE uid = $2`,
          [enabled, normalizedTargetUid],
        );
      }
      if (ownsTransaction) await db.query('COMMIT');
      return { uid: normalizedTargetUid, mode: normalizedMode, enabled };
    } catch (error) {
      if (ownsTransaction) await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (ownsTransaction) db.release();
    }
  }

  async function assertUsersInWorkspace(userUids, workspaceId) {
    const unique = [...new Set((Array.isArray(userUids) ? userUids : [])
      .map(uid => String(uid || '').trim()).filter(Boolean))];
    if (!unique.length) return [];
    const result = await pool.query(
      `SELECT u.uid
         FROM users u
         JOIN peakos_workspace_memberships m
           ON m.user_uid = u.uid
          AND m.workspace_id = $1
          AND m.active = TRUE
          AND m.role <> 'oversight'
        WHERE u.uid = ANY($2::text[])
          AND u.approved = TRUE
          AND COALESCE(u.is_active, TRUE) = TRUE`,
      [workspaceId, unique],
    );
    const valid = result.rows.map(row => String(row.uid));
    if (valid.length !== unique.length || unique.some(uid => !valid.includes(uid))) {
      throw new WorkspaceAccessError(
        '다른 워크스페이스 사용자를 초대하거나 공유할 수 없습니다.',
        'PEAKOS_CROSS_WORKSPACE_MEMBER_FORBIDDEN',
        400,
      );
    }
    return valid;
  }

  function workspaceId(req, { legacyPeakDefault = false } = {}) {
    if (req?.workspace?.id) return req.workspace.id;
    if (legacyPeakDefault) return PEAK_WORKSPACE_ID;
    throw new WorkspaceAccessError('워크스페이스가 확인되지 않았습니다.', 'PEAKOS_WORKSPACE_REQUIRED', 400);
  }

  return Object.freeze({
    attachRequestWorkspace,
    assertUsersInWorkspace,
    listForUser,
    requireWorkspace,
    requireSelectedWorkspace,
    resolveDefaultForUser,
    resolveForUser,
    seedOversightMemberships,
    setUserMembershipsActive,
    setUserRestrictionMode,
    syncUserDefaultMembership,
    userHasDirectMembership,
    canAccessWorkspacePortfolio,
    workspaceId,
  });
}

function invokeMiddleware(middleware, req, res, next, onSuccess) {
  try {
    const result = middleware(req, res, error => {
      if (error) return next(error);
      return onSuccess();
    });
    if (result && typeof result.catch === 'function') result.catch(next);
    return result;
  } catch (error) {
    return next(error);
  }
}

function registerPeakosWorkspaceRoutes({ app, authMiddleware, requireOsSession, service } = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('app이 필요합니다.');
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware가 필요합니다.');
  if (typeof requireOsSession !== 'function') throw new TypeError('requireOsSession이 필요합니다.');
  if (!service || typeof service.listForUser !== 'function') throw new TypeError('workspace service가 필요합니다.');

  const osAuth = (req, res, next) => invokeMiddleware(authMiddleware, req, res, next, () => (
    invokeMiddleware(requireOsSession, req, res, next, () => next())
  ));

  app.get('/api/os/workspaces', osAuth, async (req, res) => {
    try {
      if (req.userDoc?.approved !== true || req.userDoc?.is_active === false) {
        throw new WorkspaceAccessError('승인된 활성 계정만 사용할 수 있습니다.', 'PEAKOS_WORKSPACE_ACCOUNT_INACTIVE', 403);
      }
      const workspaces = await service.listForUser(req.uid);
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('Authorization');
      const defaultWorkspace = workspaces.find(item => item.is_default && !item.headquartersOversight)
        || workspaces.find(item => !item.headquartersOversight)
        || null;
      res.json({ workspaces, default_slug: defaultWorkspace?.slug || null });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.get('/api/os/workspaces/:slug/context', osAuth, async (req, res) => {
    try {
      if (req.userDoc?.approved !== true || req.userDoc?.is_active === false) {
        throw new WorkspaceAccessError('승인된 활성 계정만 사용할 수 있습니다.', 'PEAKOS_WORKSPACE_ACCOUNT_INACTIVE', 403);
      }
      const headerSlug = readWorkspaceSlugHeader(req);
      const pathSlug = normalizeWorkspaceSlug(req.params.slug);
      if (!headerSlug || headerSlug !== pathSlug) {
        throw new WorkspaceAccessError('워크스페이스 선택 정보가 일치하지 않습니다.', 'PEAKOS_WORKSPACE_REQUIRED', 400);
      }
      const workspace = await service.resolveForUser(req.uid, pathSlug);
      res.set?.('Cache-Control', 'private, no-store');
      res.vary?.('X-PeakOS-Workspace');
      res.vary?.('Authorization');
      res.json({ workspace, permissions: workspace.permissions, membership: {
        role: workspace.role,
        permissions: workspace.permissions,
        headquartersOversight: workspace.headquartersOversight,
      } });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  return service;
}

module.exports = {
  DIRECT_PERMISSIONS,
  MIGRATION_PATH,
  OVERSIGHT_NAMES,
  OVERSIGHT_PERMISSIONS,
  PEAK_WORKSPACE_ID,
  PERMISSION_LEVELS,
  REQUIRED_COMPOSITE_PRIMARY_KEYS,
  REQUIRED_WORKSPACE_COLUMNS,
  WORKSPACES,
  WORKSPACE_AREAS,
  WORKSPACE_HEADER,
  WorkspaceAccessError,
  backfillPeakWorkspaceBatches,
  createPeakosWorkspaceService,
  ensurePeakosWorkspaceInfrastructure,
  normalizePermissions,
  normalizeWorkspaceSlug,
  parseAccessUidMap,
  permissionAllows,
  readWorkspaceSlugHeader,
  registerPeakosWorkspaceRoutes,
  serializeWorkspaceRow,
  workspaceRequestIsMutation,
  workspacePublicAttachmentMutation,
  workspaceSlugForGroup,
};
