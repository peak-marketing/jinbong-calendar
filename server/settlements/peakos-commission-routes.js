'use strict';

const crypto = require('node:crypto');
const {
  CommissionPolicyError,
  calculateCommission,
  calculationInputFingerprint,
  canManageRules,
  canReadCalculation,
  canReadRules,
  cleanText,
  currentRuleSnapshot,
  dateKey,
  isOversight,
  normalizeRuleDraft,
  requiredReason,
} = require('./peakos-commission-policy');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;

class CommissionRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CommissionRouteError';
    this.status = status;
    this.code = code;
  }
}

function routeFail(status, code, message) {
  throw new CommissionRouteError(status, code, message);
}

function requestIsPreview(req) {
  const headers = req?.headers || {};
  const preview = typeof req?.get === 'function' ? req.get('x-peakos-preview') : headers['x-peakos-preview'];
  return /^(?:1|true|yes|on)$/i.test(String(preview || '').trim())
    || Boolean(headers['x-peakos-preview-persona'] || headers['x-peakos-preview-owner']);
}

function assertNotPreview(req) {
  if (requestIsPreview(req)) {
    routeFail(403, 'COMMISSION_PREVIEW_FORBIDDEN', '계정 미리보기에서는 수당 규칙과 산출 결과 API를 사용할 수 없습니다.');
  }
}

function workspaceId(req, getWorkspaceId) {
  const id = String(getWorkspaceId(req) || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(id) || String(req?.workspace?.id || '') !== id) {
    routeFail(403, 'COMMISSION_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  return id;
}

function actor(req, getName) {
  const uid = String(req?.uid || '').trim();
  const name = cleanText(getName(req), 160);
  if (!uid || uid.length > 256 || !name) {
    routeFail(403, 'COMMISSION_ACTOR_REQUIRED', '작업자 계정을 확인할 수 없습니다.');
  }
  return Object.freeze({ uid, name });
}

function uuid(value, code = 'COMMISSION_RULE_ID_INVALID') {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) routeFail(400, code, '수당 규칙 ID를 확인해 주세요.');
  return id;
}

function sourceId(value) {
  const id = String(value || '').trim();
  if (!SOURCE_ID_PATTERN.test(id)) {
    routeFail(400, 'COMMISSION_SOURCE_ID_INVALID', '정산 원본 ID를 확인해 주세요.');
  }
  return id;
}

function expectedVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    routeFail(400, 'COMMISSION_RULE_VERSION_REQUIRED', '최신 수당 규칙 버전이 필요합니다.');
  }
  return version;
}

function exactBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    routeFail(400, 'COMMISSION_BODY_INVALID', '요청 형식을 확인해 주세요.');
  }
  if (Object.keys(body).some(key => !allowed.has(key))) {
    routeFail(400, 'COMMISSION_FIELDS_NOT_ALLOWED', '허용되지 않은 요청 값이 있습니다.');
  }
}

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function day(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function kstDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid date');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function estimateDateRange(query, now) {
  const today = kstDay(now);
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const from = query?.from ? dateKey(query.from, '조회 시작') : defaultFrom;
  const to = query?.to ? dateKey(query.to, '조회 종료') : today;
  if (to < from) routeFail(400, 'COMMISSION_DATE_RANGE_INVALID', '조회 종료일은 시작일보다 빠를 수 없습니다.');
  const inclusiveDays = ((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86400000) + 1;
  if (inclusiveDays > 366) routeFail(400, 'COMMISSION_DATE_RANGE_TOO_WIDE', '수당 예상 조회는 한 번에 1년 이내로 선택해 주세요.');
  return Object.freeze({ from, to });
}

function ruleOut(row) {
  const rule = currentRuleSnapshot(row);
  return Object.freeze({
    id: rule.id,
    seriesId: rule.seriesId,
    version: rule.version,
    status: rule.status,
    scope: rule.scope,
    rateBasisPoints: rule.rateBasisPoints,
    ratePercent: rule.rateBasisPoints / 100,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    reason: String(row.reason),
    actorName: String(row.actor_name),
    createdAt: iso(row.created_at),
  });
}

function calculationOut(row, { masked = false, self = false } = {}) {
  const common = {
    id: String(row.id),
    ownerName: String(row.source_owner_name),
    businessDate: day(row.source_business_date),
    platform: row.source_platform || null,
    product: {
      a: String(row.source_product_a || ''),
      b: String(row.source_product_b || ''),
      c: String(row.source_product_c || ''),
    },
    status: String(row.calculation_status),
    label: row.calculation_status === 'UNCONFIGURED' ? '규칙 미설정'
      : row.calculation_status === 'RULE_OVERLAP' ? '규칙 충돌'
        : row.calculation_status === 'CALCULATED' ? '예상 수당' : '계산 제외',
    estimatedCommissionAmount: row.estimated_commission_amount == null
      ? null : Number(row.estimated_commission_amount),
    payoutEligible: row.payout_eligible === true,
    payoutBlockers: Array.isArray(row.payout_blockers) ? row.payout_blockers : [],
    rateBasisPoints: row.rate_basis_points == null ? null : Number(row.rate_basis_points),
    calculatedAt: iso(row.calculated_at),
  };
  if (masked) return Object.freeze(common);
  return Object.freeze({
    ...common,
    sourceId: String(row.source_intake_id),
    sourceRowVersion: Number(row.source_row_version),
    salesAmount: row.sales_amount == null ? null : Number(row.sales_amount),
    salespersonSupplyAmount: row.salesperson_supply_amount == null
      ? null : Number(row.salesperson_supply_amount),
    commissionBaseAmount: row.commission_base_amount == null
      ? null : Number(row.commission_base_amount),
    ...(self ? {} : {
      ownerUid: String(row.source_owner_uid),
      ruleVersionId: row.rule_version_id == null ? null : String(row.rule_version_id),
      ruleSeriesId: row.rule_series_id == null ? null : String(row.rule_series_id),
      ruleVersion: row.rule_version == null ? null : Number(row.rule_version),
      sourceSnapshotSha256: String(row.source_snapshot_sha256),
      calculatedByName: String(row.calculated_by_name),
    }),
  });
}

function estimateOut(result, { masked = false } = {}) {
  const common = {
    ownerName: result.source.ownerName,
    businessDate: result.source.businessDate,
    platform: result.source.platform,
    product: result.source.product,
    status: result.status,
    label: result.status === 'UNCONFIGURED' ? '규칙 미설정'
      : result.status === 'RULE_OVERLAP' ? '규칙 충돌'
        : result.status === 'CALCULATED' ? '예상 수당' : '계산 제외',
    estimatedCommissionAmount: result.estimatedCommissionAmount,
    payoutEligible: result.payoutEligible,
    payoutBlockers: result.payoutBlockers,
    rateBasisPoints: result.rateBasisPoints,
  };
  if (masked) return Object.freeze(common);
  return Object.freeze({
    ...common,
    sourceId: result.source.id,
    sourceRowVersion: result.source.rowVersion,
    salesAmount: result.salesAmount,
    salespersonSupplyAmount: result.salespersonSupplyAmount,
    commissionBaseAmount: result.commissionBaseAmount,
  });
}

async function currentRuleVersions(database, selectedWorkspace, { lock = '' } = {}) {
  const result = await database.query(
    `SELECT rule.*
       FROM peakos_commission_rule_versions rule
      WHERE rule.workspace_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM peakos_commission_rule_versions newer
           WHERE newer.workspace_id = rule.workspace_id
             AND newer.rule_series_id = rule.rule_series_id
             AND newer.version > rule.version
        )
      ORDER BY rule.created_at DESC, rule.rule_series_id
      ${lock}`,
    [selectedWorkspace],
  );
  return result.rows;
}

async function latestSeriesVersion(database, selectedWorkspace, seriesId, lock = '') {
  const result = await database.query(
    `SELECT * FROM peakos_commission_rule_versions
      WHERE workspace_id = $1 AND rule_series_id = $2
      ORDER BY version DESC LIMIT 1 ${lock}`,
    [selectedWorkspace, seriesId],
  );
  if (!result.rows[0]) routeFail(404, 'COMMISSION_RULE_NOT_FOUND', '수당 규칙을 찾지 못했습니다.');
  return result.rows[0];
}

function ruleInsertValues({ workspace, id, seriesId, version, supersedesId, status, source, reason, actor: who, now }) {
  return [
    workspace, id, seriesId, version, supersedesId, status,
    source.scope_owner_uid ?? source.scopeOwnerUid ?? null,
    source.scope_platform ?? source.scopePlatform ?? null,
    source.scope_product_a ?? source.scopeProductA ?? null,
    source.scope_product_b ?? source.scopeProductB ?? null,
    source.scope_product_c ?? source.scopeProductC ?? null,
    Number(source.rate_basis_points ?? source.rateBasisPoints),
    day(source.effective_from ?? source.effectiveFrom),
    (source.effective_to ?? source.effectiveTo) == null ? null : day(source.effective_to ?? source.effectiveTo),
    reason, who.uid, who.name, now,
  ];
}

const RULE_INSERT_SQL = `INSERT INTO peakos_commission_rule_versions
  (workspace_id,id,rule_series_id,version,supersedes_id,status,
   scope_owner_uid,scope_platform,scope_product_a,scope_product_b,scope_product_c,
   rate_basis_points,effective_from,effective_to,reason,actor_uid,actor_name,created_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
 RETURNING *`;

function databaseCalculationValues({ workspace, id, inputFingerprint, result, vendorEvidence, who, now }) {
  const source = result.source;
  const rule = result.rule;
  return [
    workspace, id, inputFingerprint, source.id, source.ownerUid, source.ownerName,
    source.businessDate, source.rowVersion, result.sourceSha256, source.kind, source.platform,
    source.product.a, source.product.b, source.product.c, source.qty, source.sellPerUnit,
    source.salespersonUnit, result.salesAmount, result.salespersonSupplyAmount,
    result.commissionBaseAmount, rule?.id ?? null, rule?.seriesId ?? null, rule?.version ?? null,
    result.rateBasisPoints, result.status, result.estimatedCommissionAmount,
    result.payoutEligible, JSON.stringify(result.payoutBlockers),
    vendorEvidence?.batch_id ?? null, vendorEvidence?.source_settled_row_version ?? null,
    JSON.stringify(source), rule == null ? null : JSON.stringify(rule), who.uid, who.name, now,
  ];
}

const CALCULATION_INSERT_SQL = `INSERT INTO peakos_commission_calculation_ledger
  (workspace_id,id,input_fingerprint,source_intake_id,source_owner_uid,source_owner_name,
   source_business_date,source_row_version,source_snapshot_sha256,source_kind,source_platform,
   source_product_a,source_product_b,source_product_c,source_qty,source_sell_per_unit,
   source_salesperson_unit,sales_amount,salesperson_supply_amount,commission_base_amount,
   rule_version_id,rule_series_id,rule_version,rate_basis_points,calculation_status,
   estimated_commission_amount,payout_eligible,payout_blockers,vendor_batch_id,
   vendor_source_settled_row_version,source_snapshot,rule_snapshot,calculated_by_uid,
   calculated_by_name,calculated_at)
 VALUES (${Array.from({ length: 35 }, (_, index) => `$${index + 1}`).join(',')})
 ON CONFLICT (workspace_id,input_fingerprint) DO NOTHING
 RETURNING *`;

function routeError(res, error, logger) {
  if (error instanceof CommissionRouteError || error instanceof CommissionPolicyError) {
    return res.status(error.status || 400).json({ code: error.code, error: error.message });
  }
  if (error?.constraint === 'peakos_commission_rule_overlap_check') {
    return res.status(409).json({
      code: 'COMMISSION_RULE_OVERLAP',
      error: '같은 판매 행에 둘 이상의 수당 규칙이 적용될 수 있어 승인하지 않았습니다.',
    });
  }
  if (error?.constraint === 'peakos_commission_rule_predecessor_check'
      || error?.constraint === 'peakos_commission_rule_transition_check') {
    return res.status(409).json({ code: 'COMMISSION_RULE_VERSION_CONFLICT', error: '다른 작업자가 먼저 수당 규칙을 변경했습니다.' });
  }
  if (['42P01', '42703', '42883'].includes(String(error?.code || ''))) {
    return res.status(503).json({ code: 'COMMISSION_SCHEMA_NOT_READY', error: '수당 산출 데이터 준비가 아직 끝나지 않았습니다.' });
  }
  if (['23503', '23514', '23505'].includes(String(error?.code || ''))) {
    return res.status(409).json({ code: 'COMMISSION_STATE_CONFLICT', error: '수당 규칙 또는 정산 원본이 현재 상태와 일치하지 않습니다.' });
  }
  logger.error?.('commission route failed:', error?.message || error);
  return res.status(500).json({ code: 'COMMISSION_FAILED', error: '수당 규칙 또는 산출 결과를 처리하지 못했습니다.' });
}

function registerPeakosCommissionRoutes({
  app,
  authMiddleware,
  pool,
  getName,
  getWorkspaceId = req => req?.workspace?.id,
  clock = () => new Date(),
  logger = console,
}) {
  if (!app || !pool || typeof pool.connect !== 'function' || typeof getName !== 'function') {
    throw new TypeError('app, pool, getName이 필요합니다.');
  }

  app.get('/api/peakos/commission-rules', authMiddleware, async (req, res) => {
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      if (!canReadRules(req)) routeFail(403, 'COMMISSION_RULE_READ_FORBIDDEN', '수당 규칙을 볼 권한이 없습니다.');
      const rows = await currentRuleVersions(pool, workspace);
      res.set('Cache-Control', 'no-store');
      return res.json({ rules: rows.map(ruleOut) });
    } catch (error) { return routeError(res, error, logger); }
  });

  app.post('/api/peakos/commission-rules', authMiddleware, async (req, res) => {
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      if (!canManageRules(req)) routeFail(403, 'COMMISSION_RULE_WRITE_FORBIDDEN', '수당 규칙을 만들 권한이 없습니다.');
      const draft = normalizeRuleDraft(req.body);
      const who = actor(req, getName);
      if (draft.scopeOwnerUid !== null) {
        const membership = await pool.query(
          `SELECT 1 FROM peakos_workspace_memberships
            WHERE workspace_id = $1 AND user_uid = $2 AND active = TRUE`,
          [workspace, draft.scopeOwnerUid],
        );
        if (!membership.rows.length) routeFail(409, 'COMMISSION_SCOPE_OWNER_NOT_ACTIVE', '선택한 영업자가 이 워크스페이스의 활성 구성원이 아닙니다.');
      }
      const now = clock();
      const inserted = await pool.query(RULE_INSERT_SQL, ruleInsertValues({
        workspace, id: crypto.randomUUID(), seriesId: crypto.randomUUID(), version: 1,
        supersedesId: null, status: 'DRAFT', source: draft, reason: draft.reason, actor: who, now,
      }));
      return res.status(201).json({ rule: ruleOut(inserted.rows[0]) });
    } catch (error) { return routeError(res, error, logger); }
  });

  app.post('/api/peakos/commission-rules/:seriesId/approve', authMiddleware, async (req, res) => {
    let client;
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      if (!canManageRules(req)) routeFail(403, 'COMMISSION_RULE_WRITE_FORBIDDEN', '수당 규칙을 승인할 권한이 없습니다.');
      exactBody(req.body, new Set(['expectedVersion', 'reason']));
      const seriesId = uuid(req.params.seriesId);
      const version = expectedVersion(req.body.expectedVersion);
      const reason = requiredReason(req.body.reason);
      const who = actor(req, getName);
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const latest = await latestSeriesVersion(client, workspace, seriesId, 'FOR UPDATE');
      if (Number(latest.version) !== version || latest.status !== 'DRAFT') {
        routeFail(409, 'COMMISSION_RULE_VERSION_CONFLICT', '최신 초안만 승인할 수 있습니다.');
      }
      const inserted = await client.query(RULE_INSERT_SQL, ruleInsertValues({
        workspace, id: crypto.randomUUID(), seriesId, version: version + 1,
        supersedesId: latest.id, status: 'APPROVED', source: latest, reason, actor: who, now: clock(),
      }));
      await client.query('COMMIT');
      return res.json({ rule: ruleOut(inserted.rows[0]) });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      return routeError(res, error, logger);
    } finally { client?.release(); }
  });

  app.post('/api/peakos/commission-rules/:seriesId/end', authMiddleware, async (req, res) => {
    let client;
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      if (!canManageRules(req)) routeFail(403, 'COMMISSION_RULE_WRITE_FORBIDDEN', '수당 규칙을 종료할 권한이 없습니다.');
      exactBody(req.body, new Set(['expectedVersion', 'effectiveTo', 'reason']));
      const seriesId = uuid(req.params.seriesId);
      const version = expectedVersion(req.body.expectedVersion);
      const effectiveTo = dateKey(req.body.effectiveTo, '적용 종료');
      const reason = requiredReason(req.body.reason);
      const who = actor(req, getName);
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const latest = await latestSeriesVersion(client, workspace, seriesId, 'FOR UPDATE');
      if (Number(latest.version) !== version || latest.status !== 'APPROVED') {
        routeFail(409, 'COMMISSION_RULE_VERSION_CONFLICT', '최신 승인 규칙만 종료할 수 있습니다.');
      }
      if (effectiveTo <= day(latest.effective_from)) {
        routeFail(400, 'COMMISSION_EFFECTIVE_RANGE_INVALID', '종료일은 적용 시작일보다 뒤여야 합니다.');
      }
      const source = { ...latest, effective_to: effectiveTo };
      const inserted = await client.query(RULE_INSERT_SQL, ruleInsertValues({
        workspace, id: crypto.randomUUID(), seriesId, version: version + 1,
        supersedesId: latest.id, status: 'ENDED', source, reason, actor: who, now: clock(),
      }));
      await client.query('COMMIT');
      return res.json({ rule: ruleOut(inserted.rows[0]) });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      return routeError(res, error, logger);
    } finally { client?.release(); }
  });

  app.post('/api/peakos/commission-calculations/:sourceId', authMiddleware, async (req, res) => {
    let client;
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      if (!canManageRules(req)) routeFail(403, 'COMMISSION_CALCULATION_WRITE_FORBIDDEN', '수당을 산출할 권한이 없습니다.');
      exactBody(req.body, new Set(['expectedSourceRowVersion']));
      const id = sourceId(req.params.sourceId);
      const version = expectedVersion(req.body.expectedSourceRowVersion);
      const who = actor(req, getName);
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const sourceResult = await client.query(
        `SELECT * FROM peakos_intake
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE`,
        [workspace, id],
      );
      const source = sourceResult.rows[0];
      if (!source) routeFail(404, 'COMMISSION_SOURCE_NOT_FOUND', '정산 원본 접수 행을 찾지 못했습니다.');
      if (Number(source.row_version) !== version) {
        routeFail(409, 'COMMISSION_SOURCE_VERSION_CONFLICT', '다른 작업자가 먼저 정산 원본을 변경했습니다.');
      }
      const vendorResult = await client.query(
        `SELECT item.batch_id, item.source_settled_row_version
           FROM peakos_vendor_settlement_items item
           JOIN peakos_vendor_settlement_batches batch
             ON batch.workspace_id = item.workspace_id AND batch.id = item.batch_id
          WHERE item.workspace_id = $1 AND item.source_intake_id = $2
            AND batch.status = 'COMPLETED'`,
        [workspace, id],
      );
      const vendorEvidence = vendorResult.rows[0] || null;
      const rules = (await currentRuleVersions(client, workspace))
        .filter(row => ['APPROVED', 'ENDED'].includes(row.status));
      const result = calculateCommission(source, rules, vendorEvidence);
      const fingerprint = calculationInputFingerprint(result, vendorEvidence);
      const now = clock();
      const inserted = await client.query(CALCULATION_INSERT_SQL, databaseCalculationValues({
        workspace, id: crypto.randomUUID(), inputFingerprint: fingerprint,
        result, vendorEvidence, who, now,
      }));
      const row = inserted.rows[0] || (await client.query(
        `SELECT * FROM peakos_commission_calculation_ledger
          WHERE workspace_id = $1 AND input_fingerprint = $2`,
        [workspace, fingerprint],
      )).rows[0];
      await client.query('COMMIT');
      return res.status(inserted.rows[0] ? 201 : 200).json({ calculation: calculationOut(row) });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      return routeError(res, error, logger);
    } finally { client?.release(); }
  });

  app.get('/api/peakos/commission-estimates', authMiddleware, async (req, res) => {
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      const ownUid = String(req.uid || '');
      const elevated = isOversight(req) || ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
      let requestedOwner = String(req.query?.ownerUid || '').trim();
      if (!elevated) requestedOwner = ownUid;
      if (requestedOwner && (requestedOwner.length > 256 || /[\u0000-\u001f\u007f]/u.test(requestedOwner))) {
        routeFail(400, 'COMMISSION_OWNER_INVALID', '영업자 계정을 확인해 주세요.');
      }
      if (!canReadCalculation(req, requestedOwner || ownUid)) {
        routeFail(403, 'COMMISSION_CALCULATION_READ_FORBIDDEN', '이 수당 예상 결과를 볼 권한이 없습니다.');
      }
      const range = estimateDateRange(req.query, clock());
      const params = [workspace, range.from, range.to];
      const ownerSql = requestedOwner ? `AND source.owner_uid = $${params.push(requestedOwner)}` : '';
      const sourceResult = await pool.query(
        `SELECT source.*, item.batch_id, item.source_settled_row_version
           FROM peakos_intake source
           LEFT JOIN peakos_vendor_settlement_items item
             ON item.workspace_id = source.workspace_id AND item.source_intake_id = source.id
          WHERE source.workspace_id = $1
            AND source.date BETWEEN $2::date AND $3::date
            ${ownerSql}
          ORDER BY source.date DESC, source.created_at DESC, source.id DESC
          LIMIT 501`,
        params,
      );
      const ruleRows = (await currentRuleVersions(pool, workspace))
        .filter(row => ['APPROVED', 'ENDED'].includes(row.status));
      const truncated = sourceResult.rows.length > 500;
      const masked = isOversight(req);
      const estimates = sourceResult.rows.slice(0, 500).map(row => {
        const vendorEvidence = row.batch_id == null ? null : {
          batch_id: row.batch_id,
          source_settled_row_version: row.source_settled_row_version,
        };
        return estimateOut(calculateCommission(row, ruleRows, vendorEvidence), { masked });
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ range, estimates, truncated });
    } catch (error) { return routeError(res, error, logger); }
  });

  app.get('/api/peakos/commission-calculations', authMiddleware, async (req, res) => {
    try {
      assertNotPreview(req);
      const workspace = workspaceId(req, getWorkspaceId);
      const ownUid = String(req.uid || '');
      const elevated = isOversight(req) || ['admin', 'manager'].includes(String(req?.workspace?.role || ''));
      let requestedOwner = String(req.query?.ownerUid || '').trim();
      if (!elevated) requestedOwner = ownUid;
      if (requestedOwner && (requestedOwner.length > 256 || /[\u0000-\u001f\u007f]/u.test(requestedOwner))) {
        routeFail(400, 'COMMISSION_OWNER_INVALID', '영업자 계정을 확인해 주세요.');
      }
      if (!canReadCalculation(req, requestedOwner || ownUid)) {
        routeFail(403, 'COMMISSION_CALCULATION_READ_FORBIDDEN', '이 수당 산출 결과를 볼 권한이 없습니다.');
      }
      const params = [workspace];
      const ownerSql = requestedOwner ? `AND source_owner_uid = $${params.push(requestedOwner)}` : '';
      const result = await pool.query(
        `SELECT * FROM peakos_commission_calculation_ledger
          WHERE workspace_id = $1 ${ownerSql}
          ORDER BY source_business_date DESC, calculated_at DESC, id DESC
          LIMIT 200`,
        params,
      );
      const masked = isOversight(req);
      res.set('Cache-Control', 'private, no-store');
      return res.json({ calculations: result.rows.map(row => calculationOut(row, {
        masked,
        self: !elevated,
      })) });
    } catch (error) { return routeError(res, error, logger); }
  });
}

module.exports = {
  CALCULATION_INSERT_SQL,
  CommissionRouteError,
  RULE_INSERT_SQL,
  calculationOut,
  currentRuleVersions,
  databaseCalculationValues,
  estimateDateRange,
  estimateOut,
  exactBody,
  registerPeakosCommissionRoutes,
  requestIsPreview,
  ruleInsertValues,
  ruleOut,
};
