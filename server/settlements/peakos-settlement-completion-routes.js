'use strict';

const {
  SettlementCompletionPolicyError,
  canManageCompletion,
  canReadCompletion,
  canReopenCompletion,
  cleanText,
  deriveRuleFromMonthlySource,
  evaluateEligibility,
  normalizeEvidence,
  normalizeReason,
} = require('./peakos-settlement-completion-policy');

const SOURCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;
const ACTIONS = new Set(['complete', 'freeze', 'reopen']);

class SettlementCompletionRouteError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'SettlementCompletionRouteError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function routeFail(status, code, message, details = null) {
  throw new SettlementCompletionRouteError(status, code, message, details);
}

function sourceId(value) {
  const id = String(value || '').trim();
  if (!SOURCE_ID_PATTERN.test(id)) routeFail(400, 'SETTLEMENT_COMPLETION_SOURCE_ID_INVALID', '정산 원본 ID를 확인해 주세요.');
  return id;
}

function expectedVersion(value, { allowZero = false } = {}) {
  const version = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(version) || version < minimum) {
    routeFail(400, 'SETTLEMENT_COMPLETION_VERSION_REQUIRED', '최신 정산 완료 버전이 필요합니다.');
  }
  return version;
}

function requestIsPreview(req) {
  const headers = req?.headers || {};
  const preview = typeof req?.get === 'function' ? req.get('x-peakos-preview') : headers['x-peakos-preview'];
  return /^(?:1|true|yes|on)$/i.test(String(preview || '').trim())
    || Boolean(headers['x-peakos-preview-persona'] || headers['x-peakos-preview-owner']);
}

function workspaceId(req, getWorkspaceId) {
  const selected = String(getWorkspaceId(req) || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(selected) || String(req?.workspace?.id || '') !== selected) {
    routeFail(403, 'SETTLEMENT_COMPLETION_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  return selected;
}

function actor(req, getName) {
  const uid = String(req?.uid || '').trim();
  if (!uid || uid.length > 200) routeFail(403, 'SETTLEMENT_COMPLETION_ACTOR_REQUIRED', '작업자 계정을 확인할 수 없습니다.');
  return Object.freeze({ uid, name: cleanText(getName(req), 160) });
}

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function evidenceFromRow(row) {
  return Object.freeze({
    exposureStartedAt: iso(row?.exposure_started_at),
    exposureCompletedAt: iso(row?.exposure_completed_at),
    serviceStartedAt: iso(row?.service_started_at),
    serviceCompletedAt: iso(row?.service_completed_at),
    completedIssueCount: row?.completed_issue_count === null || row?.completed_issue_count === undefined
      ? null : Number(row.completed_issue_count),
    eighthIssueCompletedAt: iso(row?.eighth_issue_completed_at),
  });
}

function lifecycleFromRow(row) {
  return Object.freeze({
    completedAt: iso(row?.settlement_completed_at),
    completedByName: String(row?.settlement_completed_by_name || ''),
    completionReason: String(row?.settlement_completion_reason || ''),
    frozenAt: iso(row?.frozen_at),
    frozenByName: String(row?.frozen_by_name || ''),
    freezeReason: String(row?.freeze_reason || ''),
    reopenedAt: iso(row?.reopened_at),
    reopenedByName: String(row?.reopened_by_name || ''),
    reopenReason: String(row?.reopen_reason || ''),
  });
}

function completionOut(row, source, { asOf = new Date() } = {}) {
  const ruleCode = row?.rule_code || deriveRuleFromMonthlySource(source);
  const evidence = evidenceFromRow(row);
  const eligibility = evaluateEligibility(ruleCode, evidence, { asOf });
  const status = row?.status || 'OPEN';
  return Object.freeze({
    tracked: Boolean(row),
    sourceId: String(source.id),
    ruleCode,
    status,
    locked: ['COMPLETED', 'FROZEN'].includes(status),
    rowVersion: row ? Number(row.row_version) : 0,
    evidence,
    evidenceUpdatedAt: iso(row?.evidence_updated_at),
    evidenceUpdatedByName: String(row?.evidence_updated_by_name || ''),
    eligibility,
    lifecycle: lifecycleFromRow(row),
  });
}

function evidenceDatabaseValues(evidence) {
  return [
    evidence.exposureStartedAt,
    evidence.exposureCompletedAt,
    evidence.serviceStartedAt,
    evidence.serviceCompletedAt,
    evidence.completedIssueCount,
    evidence.eighthIssueCompletedAt,
  ];
}

function evidenceChanged(row, evidence) {
  const current = evidenceFromRow(row);
  return Object.entries(evidence).some(([key, value]) => {
    const normalized = value instanceof Date ? value.toISOString() : value;
    return current[key] !== normalized;
  });
}

async function selectSource(database, id, selectedWorkspace, lock = '') {
  const result = await database.query(
    `SELECT id, owner_uid, view, kind, c, COALESCE(workspace_id, 'ws_peak') AS workspace_id
       FROM peakos_monthly
      WHERE id = $1
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = 'ws_peak'))
      ${lock}`,
    [id, selectedWorkspace],
  );
  const row = result.rows[0];
  if (!row) routeFail(404, 'SETTLEMENT_COMPLETION_SOURCE_NOT_FOUND', '정산 원본 판매 행을 찾지 못했습니다.');
  // Derive once before any authorization response so unsupported run/category
  // rows never become side-channel-visible completion cases.
  deriveRuleFromMonthlySource(row);
  return row;
}

async function selectCase(database, id, selectedWorkspace, lock = '') {
  const result = await database.query(
    `SELECT * FROM peakos_settlement_completion_cases
      WHERE workspace_id = $1 AND source_monthly_id = $2
      ${lock}`,
    [selectedWorkspace, id],
  );
  return result.rows[0] || null;
}

function assertRead(req, source, canSeeAll) {
  if (!canReadCompletion(req, source.owner_uid, { canSeeAll: Boolean(canSeeAll(req)) })) {
    routeFail(403, 'SETTLEMENT_COMPLETION_READ_FORBIDDEN', '이 정산 완료 상태를 볼 수 없습니다.');
  }
}

function assertManage(req) {
  if (requestIsPreview(req)) {
    routeFail(403, 'SETTLEMENT_COMPLETION_PREVIEW_READ_ONLY', '계정 미리보기에서는 정산 완료 상태를 변경할 수 없습니다.');
  }
  if (!canManageCompletion(req)) {
    routeFail(403, 'SETTLEMENT_COMPLETION_WRITE_FORBIDDEN', '정산 완료 근거를 변경할 권한이 없습니다.');
  }
}

function routeError(res, error, logger) {
  if (error instanceof SettlementCompletionRouteError || error instanceof SettlementCompletionPolicyError) {
    return res.status(error.status || 400).json({
      code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error?.constraint === 'peakos_settlement_completion_cases_not_eligible') {
    return res.status(409).json({
      code: 'SETTLEMENT_COMPLETION_NOT_ELIGIBLE',
      error: '완료 조건을 충족하지 않아 정산 완료 처리할 수 없습니다.',
    });
  }
  if (error?.constraint === 'peakos_monthly_settlement_completion_lock') {
    return res.status(409).json({
      code: 'SETTLEMENT_COMPLETION_SOURCE_LOCKED',
      error: '완료 또는 동결된 정산 원본은 재개 후 수정할 수 있습니다.',
    });
  }
  if (['23503', '23514', '22007'].includes(String(error?.code || ''))) {
    return res.status(409).json({
      code: 'SETTLEMENT_COMPLETION_STATE_CONFLICT',
      error: '정산 완료 상태가 현재 원본 또는 근거와 일치하지 않습니다.',
    });
  }
  if (['42P01', '42703', '42883'].includes(String(error?.code || ''))) {
    return res.status(503).json({
      code: 'SETTLEMENT_COMPLETION_SCHEMA_NOT_READY',
      error: '정산 완료 데이터 준비가 아직 끝나지 않았습니다.',
    });
  }
  logger.error?.('settlement completion route failed:', error?.message || error);
  return res.status(500).json({
    code: 'SETTLEMENT_COMPLETION_FAILED',
    error: '정산 완료 상태를 처리하지 못했습니다.',
  });
}

function registerPeakosSettlementCompletionRoutes({
  app,
  authMiddleware,
  pool,
  approvedActive,
  getName,
  canSeeAll = () => false,
  getWorkspaceId = req => req?.workspace?.id,
  clock = () => new Date(),
  logger = console,
}) {
  if (!app || !pool || typeof pool.connect !== 'function') throw new TypeError('app과 pool이 필요합니다.');
  if (typeof approvedActive !== 'function' || typeof getName !== 'function') {
    throw new TypeError('계정 정책 함수가 필요합니다.');
  }

  app.get('/api/peakos/settlement-completion/:sourceId', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ code: 'SETTLEMENT_COMPLETION_ACCOUNT_FORBIDDEN', error: '승인된 활성 계정만 정산 완료 상태를 볼 수 있습니다.' });
    try {
      const selectedWorkspace = workspaceId(req, getWorkspaceId);
      const id = sourceId(req.params.sourceId);
      const source = await selectSource(pool, id, selectedWorkspace);
      assertRead(req, source, canSeeAll);
      const row = await selectCase(pool, id, selectedWorkspace);
      res.set?.('Cache-Control', 'no-store');
      return res.json(completionOut(row, source, { asOf: clock() }));
    } catch (error) { return routeError(res, error, logger); }
  });

  app.get('/api/peakos/settlement-completion/:sourceId/audit', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ code: 'SETTLEMENT_COMPLETION_ACCOUNT_FORBIDDEN', error: '승인된 활성 계정만 정산 완료 이력을 볼 수 있습니다.' });
    try {
      const selectedWorkspace = workspaceId(req, getWorkspaceId);
      const id = sourceId(req.params.sourceId);
      const source = await selectSource(pool, id, selectedWorkspace);
      assertRead(req, source, canSeeAll);
      const limit = req.query?.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        routeFail(400, 'SETTLEMENT_COMPLETION_AUDIT_LIMIT_INVALID', '완료 이력은 1~100건까지 조회할 수 있습니다.');
      }
      const result = await pool.query(
        `SELECT action, row_version, actor_name, reason, created_at
           FROM peakos_settlement_completion_audit
          WHERE workspace_id = $1 AND source_monthly_id = $2
          ORDER BY id DESC LIMIT $3`,
        [selectedWorkspace, id, limit],
      );
      res.set?.('Cache-Control', 'no-store');
      return res.json({ rows: result.rows.map(row => ({
        action: String(row.action),
        rowVersion: Number(row.row_version),
        actorName: String(row.actor_name || ''),
        reason: String(row.reason || ''),
        createdAt: iso(row.created_at),
      })) });
    } catch (error) { return routeError(res, error, logger); }
  });

  app.put('/api/peakos/settlement-completion/:sourceId/evidence', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ code: 'SETTLEMENT_COMPLETION_ACCOUNT_FORBIDDEN', error: '승인된 활성 계정만 정산 완료 근거를 기록할 수 있습니다.' });
    let selectedWorkspace;
    let id;
    let version;
    let reason;
    try {
      assertManage(req);
      selectedWorkspace = workspaceId(req, getWorkspaceId);
      id = sourceId(req.params.sourceId);
      version = expectedVersion(req.body?.expectedVersion, { allowZero: true });
      reason = normalizeReason(req.body?.reason);
      if (Object.keys(req.body || {}).some(key => !['expectedVersion', 'reason', 'evidence'].includes(key))) {
        routeFail(400, 'SETTLEMENT_COMPLETION_BODY_FIELD_INVALID', '허용되지 않은 완료 근거 요청 필드가 있습니다.');
      }
    } catch (error) { return routeError(res, error, logger); }
    const currentActor = actor(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-settlement-completion-v1:${selectedWorkspace}:${id}`]);
      const source = await selectSource(client, id, selectedWorkspace, 'FOR SHARE');
      const ruleCode = deriveRuleFromMonthlySource(source);
      assertRead(req, source, canSeeAll);
      const evidence = normalizeEvidence(req.body?.evidence, ruleCode);
      const current = await selectCase(client, id, selectedWorkspace, 'FOR UPDATE');
      if (!current && version !== 0) routeFail(409, 'SETTLEMENT_COMPLETION_VERSION_CONFLICT', '다른 작업자가 먼저 정산 완료 근거를 만들었습니다.');
      if (current && Number(current.row_version) !== version) routeFail(409, 'SETTLEMENT_COMPLETION_VERSION_CONFLICT', '다른 작업자가 먼저 정산 완료 근거를 수정했습니다.');
      if (current?.status !== undefined && current.status !== 'OPEN') {
        routeFail(409, 'SETTLEMENT_COMPLETION_LOCKED', '완료 또는 동결된 정산은 재개 후 근거를 바꿀 수 있습니다.');
      }
      if (current && !evidenceChanged(current, evidence)) {
        routeFail(400, 'SETTLEMENT_COMPLETION_EVIDENCE_UNCHANGED', '변경된 정산 완료 근거가 없습니다.');
      }
      const now = clock();
      const values = evidenceDatabaseValues(evidence);
      const result = current
        ? await client.query(
          `UPDATE peakos_settlement_completion_cases
              SET exposure_started_at=$3, exposure_completed_at=$4,
                  service_started_at=$5, service_completed_at=$6,
                  completed_issue_count=$7, eighth_issue_completed_at=$8,
                  evidence_updated_at=$9, evidence_updated_by_uid=$10,
                  evidence_updated_by_name=$11, last_action='EVIDENCE_RECORDED',
                  last_action_reason=$12, last_actor_uid=$10, last_actor_name=$11,
                  last_action_at=$9, updated_at=$9, row_version=row_version+1
            WHERE workspace_id=$1 AND source_monthly_id=$2 RETURNING *`,
          [selectedWorkspace, id, ...values, now, currentActor.uid, currentActor.name, reason],
        )
        : await client.query(
          `INSERT INTO peakos_settlement_completion_cases
            (workspace_id,source_monthly_id,rule_code,status,row_version,
             exposure_started_at,exposure_completed_at,service_started_at,service_completed_at,
             completed_issue_count,eighth_issue_completed_at,evidence_updated_at,
             evidence_updated_by_uid,evidence_updated_by_name,last_action,last_action_reason,
             last_actor_uid,last_actor_name,last_action_at,created_at,updated_at)
           VALUES ($1,$2,$3,'OPEN',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                   'EVIDENCE_RECORDED',$13,$11,$12,$10,$10,$10)
           RETURNING *`,
          [selectedWorkspace, id, ruleCode, ...values, now, currentActor.uid, currentActor.name, reason],
        );
      await client.query('COMMIT');
      return res.json(completionOut(result.rows[0], source, { asOf: now }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return routeError(res, error, logger);
    } finally { client.release(); }
  });

  app.post('/api/peakos/settlement-completion/:sourceId/:action', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ code: 'SETTLEMENT_COMPLETION_ACCOUNT_FORBIDDEN', error: '승인된 활성 계정만 정산 완료 상태를 변경할 수 있습니다.' });
    let selectedWorkspace;
    let id;
    let action;
    let version;
    let reason;
    try {
      assertManage(req);
      selectedWorkspace = workspaceId(req, getWorkspaceId);
      id = sourceId(req.params.sourceId);
      action = String(req.params.action || '');
      if (!ACTIONS.has(action)) routeFail(404, 'SETTLEMENT_COMPLETION_ACTION_NOT_FOUND', '없는 정산 완료 작업입니다.');
      if (action === 'reopen' && !canReopenCompletion(req)) {
        routeFail(403, 'SETTLEMENT_COMPLETION_REOPEN_FORBIDDEN', '정산 완료 재개는 워크스페이스 관리자만 할 수 있습니다.');
      }
      if (Object.keys(req.body || {}).some(key => !['expectedVersion', 'reason'].includes(key))) {
        routeFail(400, 'SETTLEMENT_COMPLETION_BODY_FIELD_INVALID', '허용되지 않은 정산 상태 요청 필드가 있습니다.');
      }
      version = expectedVersion(req.body?.expectedVersion);
      reason = normalizeReason(req.body?.reason);
    } catch (error) { return routeError(res, error, logger); }
    const currentActor = actor(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-settlement-completion-v1:${selectedWorkspace}:${id}`]);
      const source = await selectSource(client, id, selectedWorkspace, 'FOR SHARE');
      assertRead(req, source, canSeeAll);
      const current = await selectCase(client, id, selectedWorkspace, 'FOR UPDATE');
      if (!current) routeFail(409, 'SETTLEMENT_COMPLETION_EVIDENCE_REQUIRED', '먼저 정산 완료 근거를 기록해 주세요.');
      if (Number(current.row_version) !== version) routeFail(409, 'SETTLEMENT_COMPLETION_VERSION_CONFLICT', '다른 작업자가 먼저 정산 완료 상태를 변경했습니다.');
      const now = clock();
      let result;
      if (action === 'complete') {
        if (current.status !== 'OPEN') routeFail(409, 'SETTLEMENT_COMPLETION_ALREADY_CLOSED', '열린 정산만 완료 처리할 수 있습니다.');
        const eligibility = evaluateEligibility(current.rule_code, evidenceFromRow(current), { asOf: now });
        if (!eligibility.eligible) {
          routeFail(409, 'SETTLEMENT_COMPLETION_NOT_ELIGIBLE', '완료 조건을 충족하지 않아 정산 완료 처리할 수 없습니다.', eligibility);
        }
        result = await client.query(
          `UPDATE peakos_settlement_completion_cases
              SET status='COMPLETED', settlement_completed_at=$3,
                  settlement_completed_by_uid=$4, settlement_completed_by_name=$5,
                  settlement_completion_reason=$6, last_action='COMPLETED',
                  last_action_reason=$6, last_actor_uid=$4, last_actor_name=$5,
                  last_action_at=$3, updated_at=$3, row_version=row_version+1
            WHERE workspace_id=$1 AND source_monthly_id=$2 RETURNING *`,
          [selectedWorkspace, id, now, currentActor.uid, currentActor.name, reason],
        );
      } else if (action === 'freeze') {
        if (current.status !== 'COMPLETED') routeFail(409, 'SETTLEMENT_COMPLETION_NOT_COMPLETED', '완료된 정산만 최종 동결할 수 있습니다.');
        result = await client.query(
          `UPDATE peakos_settlement_completion_cases
              SET status='FROZEN', frozen_at=$3, frozen_by_uid=$4, frozen_by_name=$5,
                  freeze_reason=$6, last_action='FROZEN', last_action_reason=$6,
                  last_actor_uid=$4, last_actor_name=$5, last_action_at=$3,
                  updated_at=$3, row_version=row_version+1
            WHERE workspace_id=$1 AND source_monthly_id=$2 RETURNING *`,
          [selectedWorkspace, id, now, currentActor.uid, currentActor.name, reason],
        );
      } else {
        if (!['COMPLETED', 'FROZEN'].includes(current.status)) {
          routeFail(409, 'SETTLEMENT_COMPLETION_ALREADY_OPEN', '이미 열린 정산입니다.');
        }
        result = await client.query(
          `UPDATE peakos_settlement_completion_cases
              SET status='OPEN', settlement_completed_at=NULL,
                  settlement_completed_by_uid=NULL, settlement_completed_by_name=NULL,
                  settlement_completion_reason=NULL, frozen_at=NULL, frozen_by_uid=NULL,
                  frozen_by_name=NULL, freeze_reason=NULL, reopened_at=$3,
                  reopened_by_uid=$4, reopened_by_name=$5, reopen_reason=$6,
                  last_action='REOPENED', last_action_reason=$6, last_actor_uid=$4,
                  last_actor_name=$5, last_action_at=$3, updated_at=$3,
                  row_version=row_version+1
            WHERE workspace_id=$1 AND source_monthly_id=$2 RETURNING *`,
          [selectedWorkspace, id, now, currentActor.uid, currentActor.name, reason],
        );
      }
      await client.query('COMMIT');
      return res.json(completionOut(result.rows[0], source, { asOf: now }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return routeError(res, error, logger);
    } finally { client.release(); }
  });
}

module.exports = {
  SettlementCompletionRouteError,
  completionOut,
  evidenceChanged,
  evidenceFromRow,
  registerPeakosSettlementCompletionRoutes,
  requestIsPreview,
  routeError,
};
