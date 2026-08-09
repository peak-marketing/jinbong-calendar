'use strict';

const crypto = require('node:crypto');
const {
  IntakeWriteError,
  actionAllowed,
  databaseChanges,
  expectedAmount,
  isDateKey,
  normalizeCreateRows,
  normalizePatchRequest,
} = require('./peakos-intake-write');
const { findCatalogPrice } = require('./peakos-price-catalog');

const PEAK_WORKSPACE_ID = 'ws_peak';
const WORKSPACE_ID_PATTERN = /^ws_[a-z0-9_]{1,60}$/;

const INTAKE_INSERT_COLUMNS = Object.freeze([
  'id', 'owner_uid', 'owner_name', 'date', 'client', 'expected_payer',
  'expected_deposit_amount', 'a', 'b', 'c', 'unit', 'qty', 'sell', 'cost',
  'memo', 'kind', 'ref_of', 'supplier', 'manager', 'final_only', 'paid',
  'paid_amount', 'payer', 'paid_date', 'paid_memo', 'paid_auto', 'vendor_paid',
  'vendor_paid_amount', 'vendor_paid_date', 'vendor_bank', 'vendor_by',
  'vendor_memo', 'workspace_id',
]);

const MONTHLY_CREATE_FIELDS = new Set([
  'id', 'kind', 'parentId', 'date', 'client', 'a', 'b', 'c', 'amount', 'qty',
  'period', 'memo',
]);
const MONTHLY_MUTABLE_FIELDS = Object.freeze([
  'date', 'client', 'a', 'b', 'c', 'amount', 'qty', 'period', 'memo',
]);
const MONTHLY_API_TO_DB = Object.freeze({
  date: 'date', client: 'client', a: 'a', b: 'b', c: 'c', amount: 'amount',
  qty: 'qty', period: 'period', memo: 'memo',
});
const RELATION_FIELDS = new Set([
  'client', 'memo', 'a', 'b', 'c', 'unit', 'supplier',
  'qty', 'sell', 'expectedDepositAmount', 'kind', 'refOf',
]);
const LEGACY_RELATION_BLOCK_FIELDS = new Set([
  'qty', 'sell', 'expectedDepositAmount', 'kind', 'refOf',
]);

class SettlementRouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SettlementRouteError';
    this.status = status;
    this.code = code;
  }
}

function routeFail(status, code, message) {
  throw new SettlementRouteError(status, code, message);
}

function validWorkspaceId(value) {
  const workspaceId = String(value || '').trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    routeFail(403, 'PEAKOS_WORKSPACE_REQUIRED', '선택한 워크스페이스를 확인할 수 없습니다.');
  }
  return workspaceId;
}

function selectedWorkspaceId(req, getWorkspaceId) {
  const workspaceId = validWorkspaceId(getWorkspaceId(req));
  if (req.workspace?.id && String(req.workspace.id) !== workspaceId) {
    routeFail(403, 'PEAKOS_WORKSPACE_CONTEXT_MISMATCH', '워크스페이스 요청 정보가 일치하지 않습니다.');
  }
  return workspaceId;
}

function legacyPeakWorkspaceSql(column, placeholder) {
  return `(${column} = ${placeholder} OR (${column} IS NULL AND ${placeholder} = '${PEAK_WORKSPACE_ID}'))`;
}

function isWorkspaceOversight(req) {
  return req.workspace?.headquartersOversight === true || req.workspace?.role === 'oversight';
}

function workspaceWriteAllowed(req, workspaceId) {
  return req.workspace?.id === workspaceId
    && !isWorkspaceOversight(req)
    && req.workspace?.permissions?.settlements === 'write';
}

function workspaceReadAllowed(req, workspaceId) {
  return req.workspace?.id === workspaceId
    && ['read', 'write'].includes(req.workspace?.permissions?.settlements);
}

function rejectWorkspaceWrite(res) {
  return res.status(403).json({
    code: 'PEAKOS_WORKSPACE_READ_ONLY',
    error: '이 워크스페이스에서는 정산 데이터를 수정할 수 없습니다.',
  });
}

function rejectUnassignedBranchMonthly(res) {
  return res.status(403).json({
    code: 'PEAKOS_BRANCH_MONTHLY_OWNER_REQUIRED',
    error: '지사 월별 전용 정산서는 담당자 정책이 정해진 뒤 사용할 수 있습니다.',
  });
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function validId(value, code = 'SETTLEMENT_ID_INVALID') {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(id)) routeFail(400, code, '정산 행 ID가 올바르지 않습니다.');
  return id;
}

function requiredVersion(value, code = 'ROW_VERSION_REQUIRED') {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    routeFail(400, code, '최신 행 버전이 필요합니다.');
  }
  return version;
}

function requestId(req) {
  const supplied = String(req.headers?.['x-request-id'] || '').trim();
  return /^[A-Za-z0-9:._-]{1,120}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function dateOut(value) {
  if (!(value instanceof Date)) return String(value || '').slice(0, 10);
  if (!Number.isFinite(value.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function intakeOut(row, { showCost = false, showVendor = false } = {}) {
  return {
    id: row.id,
    owner: row.owner_uid,
    ownerName: row.owner_name || '',
    rowVersion: Number(row.row_version) || 1,
    date: dateOut(row.date),
    client: row.client || '',
    expectedPayer: row.expected_payer || row.client || '',
    expectedDepositAmount: row.expected_deposit_amount === null || row.expected_deposit_amount === undefined
      ? null : Number(row.expected_deposit_amount),
    sourceGrossAmount: row.source_gross_amount === null || row.source_gross_amount === undefined
      ? null : Number(row.source_gross_amount),
    sourceExpectedDepositAmount: row.source_expected_deposit_amount === null
      || row.source_expected_deposit_amount === undefined
      ? null : Number(row.source_expected_deposit_amount),
    importedFromSettlementSheet: Boolean(row.source_document_id),
    bankMatchEligible: row.bank_match_eligible === true,
    bankMatchApprovedAt: row.bank_match_approved_at || null,
    a: row.a || '', b: row.b || '', c: row.c || '',
    unit: Number(row.unit) || 0,
    qty: Number(row.qty) || 0,
    sell: Number(row.sell) || 0,
    cost: showCost && row.cost !== null && row.cost !== undefined ? Number(row.cost) : null,
    memo: row.memo || '',
    kind: row.kind || 'normal',
    refOf: row.ref_of || '',
    supplier: row.supplier || '',
    manager: row.manager || '',
    finalOnly: row.final_only === true,
    paid: row.paid || 'none',
    paidAmount: Number(row.paid_amount) || 0,
    payer: row.payer || '',
    paidDate: row.paid_date || '',
    paidMemo: row.paid_memo || '',
    paidAuto: row.paid_auto === true,
    vendorPaid: row.vendor_paid === true,
    vendorPaidAmount: !showVendor || row.vendor_paid_amount === null || row.vendor_paid_amount === undefined
      ? null : Number(row.vendor_paid_amount),
    vendorPaidDate: showVendor ? (row.vendor_paid_date || '') : '',
    vendorBank: showVendor ? (row.vendor_bank || '') : '',
    vendorBy: showVendor ? (row.vendor_by || '') : '',
    vendorMemo: showVendor ? (row.vendor_memo || '') : '',
  };
}

function monthlyOut(row, { includeView = false } = {}) {
  return {
    ...(includeView ? { view: row.view, ownerName: row.owner_name || '' } : {}),
    id: row.id,
    rowVersion: Number(row.row_version) || 1,
    kind: row.kind,
    parentId: row.parent_id || '',
    date: dateOut(row.date),
    client: row.client || '',
    a: row.a || '', b: row.b || '', c: row.c || '',
    amount: Number(row.amount) || 0,
    qty: Number(row.qty) || 0,
    period: row.period || '',
    memo: row.memo || '',
    importedFromSettlementSheet: Boolean(row.source_document_id),
  };
}

function sendRouteError(res, error, logLabel, logger) {
  if (error instanceof SettlementRouteError || error instanceof IntakeWriteError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.code === '23505') {
    return res.status(409).json({ error: '이미 존재하거나 삭제된 행 ID입니다.', code: 'ROW_ID_CONFLICT' });
  }
  logger.error(`${logLabel}:`, error?.message || error);
  return res.status(500).json({ error: '정산 데이터를 저장하지 못했습니다.', code: 'SETTLEMENT_WRITE_FAILED' });
}

function assertNoUnknown(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    routeFail(400, 'MONTHLY_BODY_INVALID', `${label} 형식이 올바르지 않습니다.`);
  }
  if (Object.keys(object).some(key => !allowed.has(key))) {
    routeFail(400, 'MONTHLY_FIELDS_NOT_ALLOWED', `${label}에 허용되지 않은 필드가 있습니다.`);
  }
}

function finiteNumber(value, field, { positive = false, minimum = null, maximum = 1_000_000_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > maximum
      || (positive && number <= 0) || (minimum !== null && number < minimum)) {
    routeFail(400, 'MONTHLY_NUMBER_INVALID', `${field} 값이 올바르지 않습니다.`);
  }
  return number;
}

function normalizeMonthlyCreate(body, actor, view) {
  const rows = Array.isArray(body?.rows) ? body.rows : [body];
  if (!rows.length || rows.length > 500) {
    routeFail(400, 'MONTHLY_CREATE_COUNT_INVALID', '한 번에 1~500건까지 등록할 수 있습니다.');
  }
  const ids = new Set();
  return rows.map(input => {
    assertNoUnknown(input, MONTHLY_CREATE_FIELDS, '신규 월별 정산');
    const id = validId(input.id, 'MONTHLY_ID_INVALID');
    if (ids.has(id)) routeFail(409, 'MONTHLY_DUPLICATE_ID', '한 요청 안에 정산 행 ID가 중복됩니다.');
    ids.add(id);
    if (!isDateKey(input.date)) routeFail(400, 'MONTHLY_DATE_INVALID', '정산 일자가 올바르지 않습니다.');
    const kind = input.kind === 'run' ? 'run' : input.kind === 'sale' ? 'sale' : null;
    if (!kind) routeFail(400, 'MONTHLY_KIND_INVALID', '월별 정산 구분이 올바르지 않습니다.');
    const parentId = kind === 'run' ? validId(input.parentId, 'MONTHLY_PARENT_REQUIRED') : '';
    if (parentId === id) routeFail(400, 'MONTHLY_PARENT_INVALID', '실행 건은 자기 자신을 판매 건으로 연결할 수 없습니다.');
    return {
      id, view,
      owner_uid: String(actor.uid || ''), owner_name: cleanText(actor.name, 120),
      kind, parent_id: parentId, date: String(input.date),
      client: cleanText(input.client, 200), a: cleanText(input.a, 80),
      b: cleanText(input.b, 80), c: cleanText(input.c, 120),
      amount: finiteNumber(input.amount, '금액', { minimum: 0 }),
      qty: finiteNumber(input.qty, '수량', { positive: true, maximum: 1_000_000 }),
      period: cleanText(input.period, 120), memo: cleanText(input.memo, 500),
    };
  });
}

function normalizeMonthlyPatch(body) {
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) {
    routeFail(400, 'MONTHLY_PATCH_COUNT_INVALID', '한 번에 1~500건까지 수정할 수 있습니다.');
  }
  const ids = new Set();
  return rows.map(input => {
    assertNoUnknown(input, new Set(['id', 'expectedRowVersion', 'changes']), '월별 정산 수정');
    const id = validId(input.id, 'MONTHLY_ID_INVALID');
    if (ids.has(id)) routeFail(409, 'MONTHLY_DUPLICATE_ID', '한 요청 안에 정산 행 ID가 중복됩니다.');
    ids.add(id);
    const expectedRowVersion = requiredVersion(input.expectedRowVersion);
    assertNoUnknown(input.changes, new Set(MONTHLY_MUTABLE_FIELDS), '월별 정산 변경사항');
    const changes = {};
    for (const [field, value] of Object.entries(input.changes)) {
      if (field === 'date') {
        if (!isDateKey(value)) routeFail(400, 'MONTHLY_DATE_INVALID', '정산 일자가 올바르지 않습니다.');
        changes.date = String(value);
      } else if (field === 'amount') changes.amount = finiteNumber(value, '금액', { minimum: 0 });
      else if (field === 'qty') changes.qty = finiteNumber(value, '수량', { positive: true, maximum: 1_000_000 });
      else changes[field] = cleanText(value, field === 'client' ? 200 : field === 'memo' ? 500 : field === 'period' || field === 'c' ? 120 : 80);
    }
    if (!Object.keys(changes).length) routeFail(400, 'MONTHLY_PATCH_EMPTY', '바꿀 정산 내용이 없습니다.');
    return { id, expectedRowVersion, changes };
  });
}

async function auditIntake(
  client, row, action, actor, reqId, before = null, metadata = {},
  workspaceId = row.workspace_id || PEAK_WORKSPACE_ID,
) {
  await client.query(
    `INSERT INTO peakos_intake_audit_log
      (workspace_id, target_id, action, row_version, actor_uid, actor_name, request_id,
       before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
    [workspaceId, row.id, action, Number(row.row_version), actor.uid, actor.name, reqId,
      before ? JSON.stringify(before) : null, JSON.stringify(row), JSON.stringify(metadata)],
  );
}

async function auditMonthly(
  client, row, action, actor, reqId, before = null, metadata = {},
  workspaceId = row.workspace_id || PEAK_WORKSPACE_ID,
) {
  await client.query(
    `INSERT INTO peakos_monthly_audit_log
      (workspace_id, target_id, action, row_version, actor_uid, actor_name, request_id,
       before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
    [workspaceId, row.id, action, Number(row.row_version), actor.uid, actor.name, reqId,
      before ? JSON.stringify(before) : null, JSON.stringify(row), JSON.stringify(metadata)],
  );
}

async function applyCatalog(
  client, row,
  { allowUnknown = false, submittedCost = null, workspaceId = row.workspace_id || PEAK_WORKSPACE_ID } = {},
) {
  const catalog = await findCatalogPrice(client, { ...row, workspaceId });
  if (!catalog && !allowUnknown) {
    routeFail(409, 'INTAKE_CATALOG_REQUIRED', '현재 회사 단가표에 있는 상품만 새로 등록할 수 있습니다.');
  }
  if (submittedCost !== null && submittedCost !== undefined
      && (!Number.isSafeInteger(Number(submittedCost)) || Number(submittedCost) < 0
        || Number(submittedCost) > 1_000_000_000_000)) {
    routeFail(400, 'INTAKE_COST_INVALID', '원가는 0 이상의 안전한 정수로 입력해 주세요.');
  }
  if (!catalog) return { ...row, cost: submittedCost };
  const unit = catalog.unit === null || catalog.unit === undefined ? Number(row.unit) : Number(catalog.unit);
  if (!Number.isSafeInteger(unit) || unit <= 0 || unit > 1_000_000_000_000) {
    routeFail(400, 'INTAKE_UNIT_INVALID', '변동 단가 상품은 1원 이상의 정수 단가를 입력해 주세요.');
  }
  const catalogCost = catalog.cost === null || catalog.cost === undefined ? submittedCost : Number(catalog.cost);
  if (catalogCost !== null && catalogCost !== undefined
      && (!Number.isSafeInteger(catalogCost) || catalogCost < 0 || catalogCost > 1_000_000_000_000)) {
    routeFail(409, 'INTAKE_CATALOG_COST_INVALID', '회사 단가표의 원가가 안전한 원 단위 범위를 벗어났습니다.');
  }
  return {
    ...row,
    unit,
    cost: catalogCost,
  };
}

function validateNewIntakeShape(row) {
  if (!row.client || !row.a || !row.b || !row.c) {
    routeFail(400, 'INTAKE_REQUIRED_FIELDS', '업체명과 상품 대·중·소분류를 모두 입력해 주세요.');
  }
  if (!Number.isSafeInteger(Number(row.qty)) || Number(row.qty) === 0 || Math.abs(Number(row.qty)) > 1_000_000) {
    routeFail(400, 'INTAKE_QTY_INVALID', '신규 접수 수량은 0이 아닌 안전한 정수 범위로 입력해 주세요.');
  }
  if (['reserve', 'refund'].includes(row.kind) && Number(row.qty) < 1) {
    routeFail(400, 'INTAKE_QTY_INVALID', '예약최초건과 환불 수량은 1 이상이어야 합니다.');
  }
  for (const [field, value] of [['판매가', row.sell], ['입금예정액', row.expected_deposit_amount]]) {
    if (value !== null && value !== undefined
        && (!Number.isSafeInteger(Number(value)) || Math.abs(Number(value)) > 1_000_000_000_000)) {
      routeFail(400, 'INTAKE_MONEY_INVALID', `${field}은 원 단위 안전한 정수 범위로 입력해 주세요.`);
    }
  }
}

function validateBusinessMoneyChanges(changes) {
  for (const field of ['unit', 'qty', 'sell', 'expectedDepositAmount']) {
    if (!Object.prototype.hasOwnProperty.call(changes, field) || changes[field] === null) continue;
    const value = Number(changes[field]);
    const maximum = field === 'qty' ? 1_000_000 : 1_000_000_000_000;
    if (!Number.isSafeInteger(value) || Math.abs(value) > maximum || (field === 'qty' && value === 0)) {
      routeFail(400, 'INTAKE_MONEY_INVALID', '단가·수량·판매가·입금예정액은 안전한 정수 범위로 입력해 주세요.');
    }
  }
}

function sameContext(left, right) {
  return String(left.owner_uid) === String(right.owner_uid)
    && Boolean(left.final_only) === Boolean(right.final_only);
}

async function validateRelationship(
  client, candidate,
  {
    current = null,
    changedFields = [],
    workspaceId = candidate.workspace_id || current?.workspace_id || PEAK_WORKSPACE_ID,
  } = {},
) {
  if (!['use', 'refund'].includes(candidate.kind)) {
    if (candidate.ref_of) routeFail(409, 'INTAKE_RELATION_NOT_ALLOWED', '일반·예약최초건에는 원접수 연결키를 둘 수 없습니다.');
    return candidate;
  }
  const relationChanged = !current || changedFields.some(field => RELATION_FIELDS.has(field));
  if (!candidate.ref_of) {
    const blockedLegacyChange = changedFields.some(field => LEGACY_RELATION_BLOCK_FIELDS.has(field));
    if (current && ['use', 'refund'].includes(current.kind) && !current.ref_of && !blockedLegacyChange) return candidate;
    routeFail(409, 'INTAKE_RELATION_REQUIRED', candidate.kind === 'use'
      ? '예약 사용 건에는 입금 완료된 예약최초건 연결이 필요합니다.'
      : '환불 건에는 원접수 연결이 필요합니다.');
  }
  if (!relationChanged) return candidate;
  const parentResult = await client.query(
    `SELECT * FROM peakos_intake
      WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
      FOR UPDATE`,
    [candidate.ref_of, workspaceId],
  );
  const parent = parentResult.rows[0];
  if (!parent || parent.id === candidate.id || !sameContext(candidate, parent)) {
    routeFail(409, 'INTAKE_RELATION_CONTEXT_INVALID', '같은 소유자·정산 구역의 원접수만 연결할 수 있습니다.');
  }
  const siblingsResult = await client.query(
    `SELECT id, kind, qty, expected_deposit_amount, sell
       FROM peakos_intake
      WHERE ref_of = $1 AND id <> $2 AND kind = $3
        AND ${legacyPeakWorkspaceSql('workspace_id', '$4')}
      ORDER BY id
      FOR UPDATE`,
    [parent.id, candidate.id, candidate.kind, workspaceId],
  );
  let siblingQty = siblingsResult.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const qty = Number(candidate.qty || 0);
  if (candidate.kind === 'use') {
    if (parent.kind !== 'reserve' || parent.paid !== 'paid' || Number(parent.qty) <= 0) {
      routeFail(409, 'INTAKE_RESERVE_NOT_USABLE', '입금이 정확히 확인된 예약최초건만 사용할 수 있습니다.');
    }
    const siblingIds = siblingsResult.rows.map(row => row.id);
    let refundedQty = 0;
    let refundedAmount = 0;
    if (siblingIds.length) {
      const refunds = await client.query(
        `SELECT id, qty, expected_deposit_amount, sell
           FROM peakos_intake
          WHERE kind = 'refund' AND ref_of = ANY($1::text[])
            AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          ORDER BY id FOR UPDATE`,
        [siblingIds, workspaceId],
      );
      refundedQty = refunds.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
      refundedAmount = refunds.rows.reduce((sum, row) => sum + Number(
        row.expected_deposit_amount ?? (Number(row.sell) * Number(row.qty)),
      ), 0);
    }
    siblingQty -= refundedQty;
    const totalQty = siblingQty + qty;
    if (totalQty < 0 || totalQty > Number(parent.qty)) {
      routeFail(409, 'INTAKE_RESERVE_LIMIT_EXCEEDED', '예약 사용 수량이 예약 잔여 범위를 벗어났습니다.');
    }
    const expectedPerUnit = Math.abs(expectedAmount(parent)) / Math.abs(Number(parent.qty));
    const canonicalExpected = Math.round(expectedPerUnit * Math.abs(qty)) * (qty < 0 ? -1 : 1);
    const usedAmount = siblingsResult.rows.reduce((sum, row) => sum + Number(
      row.expected_deposit_amount ?? (Number(row.sell) * Number(row.qty)),
    ), 0) - refundedAmount + canonicalExpected;
    if (usedAmount < 0 || usedAmount > Number(parent.paid_amount)) {
      routeFail(409, 'INTAKE_RESERVE_AMOUNT_EXCEEDED', '예약 사용 금액이 확인된 예약금 잔액을 벗어났습니다.');
    }
    return {
      ...candidate,
      client: parent.client,
      memo: parent.memo,
      a: parent.a,
      b: parent.b,
      c: parent.c,
      unit: parent.unit,
      sell: parent.sell,
      // 예약최초건은 아직 실행되지 않아 원가·공급처가 비어 있을 수 있다.
      // 실제 use의 원가는 create 시점 catalog에서, 공급처는 실행 시점
      // 기본값에서 정하며 이후 수정에서는 현재 확정값을 보존한다.
      cost: candidate.cost,
      supplier: current ? current.supplier : candidate.supplier,
      expected_deposit_amount: canonicalExpected,
    };
  }
  if (!['normal', 'use'].includes(parent.kind) || qty <= 0 || Number(parent.qty) <= 0) {
    routeFail(409, 'INTAKE_REFUND_TARGET_INVALID', '양수 원접수 또는 예약 사용 건만 환불할 수 있습니다.');
  }
  if (siblingQty + qty > Number(parent.qty)) {
    routeFail(409, 'INTAKE_REFUND_LIMIT_EXCEEDED', '환불 수량이 원접수의 환불 가능 수량을 넘었습니다.');
  }
  const canonicalExpected = Math.round(Math.abs(expectedAmount(parent)) / Number(parent.qty) * qty);
  return {
    ...candidate,
    client: parent.client,
    a: parent.a,
    b: parent.b,
    c: parent.c,
    unit: parent.unit,
    sell: parent.sell,
    cost: parent.cost,
    supplier: parent.supplier,
    expected_deposit_amount: canonicalExpected,
  };
}

function actorFrom(req, getName) {
  return { uid: String(req.uid || ''), name: cleanText(getName(req), 120) };
}

async function resolvePreviewOwnerUid(pool, owner, workspaceId = PEAK_WORKSPACE_ID) {
  const selectedWorkspace = validWorkspaceId(workspaceId);
  // 표시이름이 중복돼도 이미 서버 원장에 귀속된 UID가 정확히 하나라면 그
  // immutable UID를 우선한다. 이름만 같은 빈 중복 계정 때문에 실제 정산서가
  // 사라져 보이지 않게 하되, 서로 다른 UID에 원장이 있으면 계속 fail-closed한다.
  const ledgerOwners = await pool.query(
    `WITH ledger_owners AS (
       SELECT owner_uid FROM peakos_intake
        WHERE owner_name = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
       UNION
       SELECT owner_uid FROM peakos_monthly
        WHERE owner_name = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
     )
     SELECT users.uid
       FROM ledger_owners
       JOIN users ON users.uid = ledger_owners.owner_uid
      WHERE users.name = $1
        AND users.approved = TRUE
        AND COALESCE(users.is_active,TRUE) = TRUE
      ORDER BY users.uid
      LIMIT 2`,
    [owner, selectedWorkspace],
  );
  if (ledgerOwners.rows.length === 1) return String(ledgerOwners.rows[0].uid || '');
  if (ledgerOwners.rows.length > 1) {
    routeFail(409, 'INTAKE_PREVIEW_OWNER_AMBIGUOUS', '서로 다른 계정에 정산자료가 있어 미리보기를 열 수 없습니다.');
  }
  const activeOwners = await pool.query(
    `SELECT uid FROM users
      WHERE name = $1 AND approved = TRUE AND COALESCE(is_active,TRUE) = TRUE
        AND EXISTS (
          SELECT 1 FROM peakos_workspace_memberships membership
           WHERE membership.workspace_id = $2
             AND membership.user_uid = users.uid
             AND membership.active = TRUE
             AND membership.role <> 'oversight'
        )
      ORDER BY uid LIMIT 2`,
    [owner, selectedWorkspace],
  );
  if (!activeOwners.rows.length) routeFail(404, 'INTAKE_PREVIEW_OWNER_NOT_FOUND', '미리보기 대상 계정을 찾지 못했습니다.');
  if (activeOwners.rows.length !== 1) {
    routeFail(409, 'INTAKE_PREVIEW_OWNER_AMBIGUOUS', '동일 표시이름 계정이 있어 미리보기를 열 수 없습니다.');
  }
  return String(activeOwners.rows[0].uid || '');
}

function registerPeakosSettlementRoutes({
  app, authMiddleware, pool, monthlyOwners, approvedActive, getName,
  canSeeAll, canReadOwnerUid, canManageMonthly, canSeeMonthly,
  canSeeFinalExecution, canReviewFinance, canManageBankEligibility,
  autoReconciliationEnabled, getWorkspaceId = req => req.workspace?.id,
  logger = console,
}) {
  if (!app || !pool) throw new TypeError('app과 pool이 필요합니다.');

  function workspaceForRoute(req, res, { write = false } = {}) {
    try {
      const workspaceId = selectedWorkspaceId(req, getWorkspaceId);
      if (!workspaceReadAllowed(req, workspaceId)) {
        res.status(403).json({
          code: 'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
          error: '이 워크스페이스에서 정산 데이터를 볼 수 없습니다.',
        });
        return null;
      }
      if (write && !workspaceWriteAllowed(req, workspaceId)) {
        rejectWorkspaceWrite(res);
        return null;
      }
      return workspaceId;
    } catch (error) {
      sendRouteError(res, error, 'peakos workspace context error', logger);
      return null;
    }
  }

  app.get('/api/peakos/intake', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ error: '승인된 활성 계정만 접수를 볼 수 있습니다.' });
    const workspaceId = workspaceForRoute(req, res);
    if (!workspaceId) return undefined;
    try {
      const owner = String(req.query.owner || '').trim();
      let ownerUid = '';
      if (owner) {
        ownerUid = await resolvePreviewOwnerUid(pool, owner, workspaceId);
        if (!canReadOwnerUid(req, ownerUid) && !isWorkspaceOversight(req)) {
          return res.status(403).json({ error: '이 계정의 접수는 볼 수 없습니다.' });
        }
      }
      const all = req.query.scope === 'all';
      const canViewAll = canSeeAll(req) || isWorkspaceOversight(req);
      if (all && !canViewAll) return res.status(403).json({ error: '전체 접수는 지정된 인원만 볼 수 있습니다.' });
      const result = ownerUid
        ? await pool.query(
          `SELECT * FROM peakos_intake
            WHERE owner_uid = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            ORDER BY date DESC, created_at DESC`,
          [ownerUid, workspaceId],
        )
        : all
          ? await pool.query(
            `SELECT * FROM peakos_intake
              WHERE ${legacyPeakWorkspaceSql('workspace_id', '$1')}
              ORDER BY date DESC, created_at DESC`,
            [workspaceId],
          )
          : await pool.query(
            `SELECT * FROM peakos_intake
              WHERE owner_uid = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
              ORDER BY date DESC, created_at DESC`,
            [req.uid, workspaceId],
          );
      return res.json(result.rows.map(row => intakeOut(row, {
        showCost: canViewAll, showVendor: canReviewFinance(req) || isWorkspaceOversight(req),
      })));
    } catch (error) {
      return sendRouteError(res, error, 'peakos intake read error', logger);
    }
  });

  app.post('/api/peakos/intake', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ error: '승인된 활성 계정만 접수를 저장할 수 있습니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    const actor = actorFrom(req, getName);
    let rows;
    try {
      rows = normalizeCreateRows(req.body, actor, {
        canManage: canSeeAll(req), canFinal: canSeeAll(req), canCost: canSeeAll(req),
      });
    } catch (error) {
      return sendRouteError(res, error, 'peakos intake create validation error', logger);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-intake-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_intake IN ROW EXCLUSIVE MODE');
      const ids = rows.map(row => row.id).sort();
      const [existing, tombstones] = await Promise.all([
        client.query(
          `SELECT id FROM peakos_intake
            WHERE id = ANY($1::text[]) AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            ORDER BY id FOR UPDATE`,
          [ids, workspaceId],
        ),
        client.query(
          `SELECT target_id FROM peakos_intake_tombstones
            WHERE target_id = ANY($1::text[]) AND workspace_id = $2
            ORDER BY target_id FOR UPDATE`,
          [ids, workspaceId],
        ),
      ]);
      if (existing.rows.length || tombstones.rows.length) {
        routeFail(409, 'INTAKE_CREATE_ID_CONFLICT', '이미 존재하거나 삭제된 접수 ID는 다시 등록할 수 없습니다.');
      }
      const prepared = [];
      for (const row of rows) {
        const workspaceRow = { ...row, workspace_id: workspaceId };
        validateNewIntakeShape(workspaceRow);
        const submittedCost = row.cost;
        let related;
        if (row.kind === 'use') {
          const canonicalRelationship = await validateRelationship(client, workspaceRow, { workspaceId });
          const executionPrice = await applyCatalog(client, canonicalRelationship, { submittedCost, workspaceId });
          related = {
            ...canonicalRelationship,
            // 판매 단가는 예약 snapshot, 실행 원가는 현재 catalog 기준이다.
            unit: canonicalRelationship.unit,
            cost: executionPrice.cost,
          };
        } else if (row.kind === 'refund') {
          related = await validateRelationship(client, workspaceRow, { workspaceId });
        } else {
          const catalogued = await applyCatalog(client, workspaceRow, { submittedCost, workspaceId });
          related = await validateRelationship(client, catalogued, { workspaceId });
        }
        const values = INTAKE_INSERT_COLUMNS.map(column => related[column]);
        const holders = values.map((_, index) => `$${index + 1}`).join(',');
        const inserted = await client.query(
          `INSERT INTO peakos_intake (${INTAKE_INSERT_COLUMNS.join(',')})
           VALUES (${holders}) RETURNING *`,
          values,
        );
        prepared.push(inserted.rows[0]);
      }
      const reqId = requestId(req);
      for (const row of prepared) await auditIntake(client, row, 'CREATE', actor, reqId, null, {}, workspaceId);
      await client.query('COMMIT');
      return res.status(201).json({ rows: prepared.map(row => intakeOut(row, {
        showCost: canSeeAll(req), showVendor: canReviewFinance(req),
      })) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos intake create error', logger);
    } finally {
      client.release();
    }
  });

  app.patch('/api/peakos/intake', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ error: '승인된 활성 계정만 접수를 수정할 수 있습니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    let patch;
    try { patch = normalizePatchRequest(req.body); }
    catch (error) { return sendRouteError(res, error, 'peakos intake patch validation error', logger); }
    const actor = actorFrom(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-intake-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_intake IN ROW EXCLUSIVE MODE');
      const ids = patch.rows.map(row => row.id).sort();
      const locked = await client.query(
        `SELECT * FROM peakos_intake
          WHERE id = ANY($1::text[]) AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          ORDER BY id FOR UPDATE`,
        [ids, workspaceId],
      );
      if (locked.rows.length !== ids.length) routeFail(404, 'INTAKE_NOT_FOUND', '수정할 접수를 찾지 못했습니다.');
      const byId = new Map(locked.rows.map(row => [row.id, row]));
      for (const item of patch.rows) {
        const row = byId.get(item.id);
        if (Number(row.row_version) !== item.expectedRowVersion) {
          routeFail(409, 'INTAKE_VERSION_CONFLICT', '다른 작업자가 먼저 수정한 접수입니다.');
        }
        if (!actionAllowed(patch.action, {
          sameOwner: row.owner_uid === req.uid,
          canFinance: canReviewFinance(req),
          canManage: canSeeAll(req),
          canCost: canSeeAll(req),
        })) routeFail(403, 'INTAKE_ACTION_FORBIDDEN', '이 접수 수정 권한이 없습니다.');
      }
      if (['business', 'payment'].includes(patch.action)) {
        const blocked = locked.rows.some(row => row.bank_match_eligible || row.paid_auto);
        const allocations = await client.query(
          `SELECT intake_id FROM peakos_bank_allocations
            WHERE intake_id = ANY($1::text[]) AND status = 'ACTIVE'
              AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            FOR UPDATE`,
          [ids, workspaceId],
        );
        if (blocked || allocations.rows.length) {
          routeFail(409, 'INTAKE_BANK_LOCKED', '통장 입금확인과 연결된 접수는 해당 연결을 해제한 뒤 수정할 수 있습니다.');
        }
      }
      const updatedRows = [];
      const reqId = requestId(req);
      for (const item of patch.rows) {
        const before = byId.get(item.id);
        if (patch.action === 'business') validateBusinessMoneyChanges(item.changes);
        if (patch.action === 'cost' && item.changes.cost !== null
            && (!Number.isSafeInteger(Number(item.changes.cost)) || Number(item.changes.cost) < 0
              || Number(item.changes.cost) > 1_000_000_000_000)) {
          routeFail(400, 'INTAKE_COST_INVALID', '원가는 0 이상의 안전한 정수로 입력해 주세요.');
        }
        let mapped = databaseChanges(patch.action, item.changes, before);
        const graphSensitive = patch.action === 'business'
          && ['kind','refOf','qty','sell','expectedDepositAmount','client','memo','a','b','c','unit','supplier']
            .some(field => Object.prototype.hasOwnProperty.call(item.changes, field));
        if (graphSensitive || patch.action === 'cost'
            || (patch.action === 'payment' && before.kind === 'reserve')) {
          const children = await client.query(
            `SELECT id FROM peakos_intake
              WHERE ref_of = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
              ORDER BY id FOR UPDATE`,
            [before.id, workspaceId],
          );
          if (children.rows.length) {
            routeFail(409, 'INTAKE_RELATION_PARENT_LOCKED', '연결된 사용·환불 건이 있는 원접수의 금액·관계 기준은 바꿀 수 없습니다.');
          }
        }
        if (patch.action === 'business') {
          const financeBasisFields = ['a','b','c','unit','qty','sell','expectedDepositAmount','kind','refOf','supplier'];
          if ((Number(before.paid_amount || 0) !== 0 || String(before.paid || 'none') !== 'none')
              && financeBasisFields.some(field => Object.prototype.hasOwnProperty.call(item.changes, field))) {
            routeFail(409, 'INTAKE_PAYMENT_BASIS_LOCKED', '입금이 확인된 행의 상품·금액·공급처 기준은 재무 교정 전에는 바꿀 수 없습니다.');
          }
          if (before.vendor_paid
              && financeBasisFields.some(field => Object.prototype.hasOwnProperty.call(item.changes, field))) {
            routeFail(409, 'INTAKE_VENDOR_LOCKED', '공급처 지급이 끝난 행의 금액 기준은 바꿀 수 없습니다.');
          }
          const classificationChanged = ['a', 'b', 'c'].some(key => Object.prototype.hasOwnProperty.call(mapped, key));
          if (classificationChanged || Object.prototype.hasOwnProperty.call(mapped, 'unit')) {
            const candidateForCatalog = { ...before, ...mapped };
            if (!['use', 'refund'].includes(candidateForCatalog.kind)) {
              const catalogued = await applyCatalog(client, candidateForCatalog, {
                allowUnknown: !classificationChanged,
                submittedCost: before.cost,
                workspaceId,
              });
              mapped.cost = catalogued.cost;
              mapped.unit = catalogued.unit;
            }
          }
        }
        if (patch.action === 'cost' && before.vendor_paid) {
          routeFail(409, 'INTAKE_VENDOR_LOCKED', '공급처 지급이 끝난 행의 원가는 바꿀 수 없습니다.');
        }
        if (patch.action === 'cost' && before.kind === 'refund') {
          routeFail(409, 'INTAKE_REFUND_COST_IMMUTABLE', '환불 행의 원가는 원접수 snapshot으로 보존됩니다.');
        }
        if (patch.action === 'payment' && (!['normal', 'reserve'].includes(before.kind) || expectedAmount(before) <= 0)) {
          routeFail(409, 'INTAKE_PAYMENT_NOT_ELIGIBLE', '양수 일반·예약최초건만 수동 입금 확인할 수 있습니다.');
        }
        if (patch.action === 'vendor') {
          if (before.vendor_paid) routeFail(409, 'INTAKE_VENDOR_ALREADY_PAID', '이미 공급처 지급이 완료된 행입니다.');
          mapped.vendor_by = actor.name;
        }
        const candidate = { ...before, ...mapped };
        if (patch.action === 'business') {
          const related = await validateRelationship(client, candidate, {
            current: before, changedFields: Object.keys(item.changes), workspaceId,
          });
          for (const column of ['client','memo','a','b','c','unit','sell','cost','supplier','expected_deposit_amount']) {
            if (!Object.is(related[column], candidate[column])) mapped[column] = related[column];
          }
        }
        const columns = Object.keys(mapped);
        const values = columns.map(column => mapped[column]);
        const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(',');
        const idPlaceholder = `$${values.length + 1}`;
        const workspacePlaceholder = `$${values.length + 2}`;
        const result = await client.query(
          `UPDATE peakos_intake
              SET ${assignments}, workspace_id = COALESCE(workspace_id, ${workspacePlaceholder}),
                  row_version = row_version + 1, updated_at = NOW()
            WHERE id = ${idPlaceholder}
              AND ${legacyPeakWorkspaceSql('workspace_id', workspacePlaceholder)}
          RETURNING *`,
          [...values, item.id, workspaceId],
        );
        const after = result.rows[0];
        if (!after) routeFail(404, 'INTAKE_NOT_FOUND', '수정할 접수를 찾지 못했습니다.');
        updatedRows.push(after);
        await auditIntake(client, after, `PATCH_${patch.action.toUpperCase()}`, actor, reqId, before, {
          changedFields: Object.keys(item.changes),
        }, workspaceId);
      }
      await client.query('COMMIT');
      return res.json({ rows: updatedRows.map(row => intakeOut(row, {
        showCost: canSeeAll(req), showVendor: canReviewFinance(req),
      })) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos intake patch error', logger);
    } finally {
      client.release();
    }
  });

  app.delete('/api/peakos/intake/:id', authMiddleware, async (req, res) => {
    if (!approvedActive(req)) return res.status(403).json({ error: '승인된 활성 계정만 접수를 지울 수 있습니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    let id;
    let expectedRowVersion;
    try {
      id = validId(req.params.id, 'INTAKE_ID_INVALID');
      expectedRowVersion = requiredVersion(req.body?.expectedRowVersion, 'INTAKE_ROW_VERSION_REQUIRED');
    } catch (error) { return sendRouteError(res, error, 'peakos intake delete validation error', logger); }
    const actor = actorFrom(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-intake-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_intake IN ROW EXCLUSIVE MODE');
      const result = await client.query(
        `SELECT * FROM peakos_intake
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          FOR UPDATE`,
        [id, workspaceId],
      );
      const row = result.rows[0];
      if (!row || row.owner_uid !== req.uid) routeFail(404, 'INTAKE_NOT_FOUND', '내 접수에서 찾지 못했습니다.');
      if (Number(row.row_version) !== expectedRowVersion) routeFail(409, 'INTAKE_VERSION_CONFLICT', '다른 작업자가 먼저 수정한 접수입니다.');
      if (row.vendor_paid || Number(row.paid_amount || 0) !== 0 || String(row.paid || 'none') !== 'none') {
        routeFail(409, 'INTAKE_FINANCE_CONFIRMED', '입금 또는 공급처 지급이 확정된 접수는 역분개 처리 전 삭제할 수 없습니다.');
      }
      const allocation = await client.query(
        `SELECT 1 FROM peakos_bank_allocations
          WHERE intake_id = $1 AND status = 'ACTIVE'
            AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          LIMIT 1 FOR UPDATE`,
        [id, workspaceId],
      );
      if (row.bank_match_eligible || row.paid_auto || allocation.rows.length) {
        routeFail(409, 'INTAKE_BANK_LOCKED', '통장 입금확인과 연결된 접수는 해당 연결을 해제한 뒤 삭제할 수 없습니다.');
      }
      const children = await client.query(
        `SELECT 1 FROM peakos_intake
          WHERE ref_of = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          LIMIT 1 FOR UPDATE`,
        [id, workspaceId],
      );
      if (children.rows.length) routeFail(409, 'INTAKE_RELATION_PARENT', '연결된 사용·환불 건을 먼저 정리해 주세요.');
      const reason = '사용자 요청으로 접수 행 삭제';
      await client.query(
        `INSERT INTO peakos_intake_tombstones
          (workspace_id,target_id,row_version,deleted_by_uid,deleted_by_name,delete_reason,last_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [workspaceId, id, Number(row.row_version), actor.uid, actor.name, reason, JSON.stringify(row)],
      );
      await client.query(
        `DELETE FROM peakos_intake
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}`,
        [id, workspaceId],
      );
      await auditIntake(
        client, { ...row, row_version: Number(row.row_version) }, 'DELETE', actor,
        requestId(req), row, { reason }, workspaceId,
      );
      await client.query('COMMIT');
      return res.json({ deleted: id, rowVersion: Number(row.row_version) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos intake delete error', logger);
    } finally { client.release(); }
  });

  app.put('/api/peakos/intake/:id/bank-match-eligibility', authMiddleware, async (req, res) => {
    if (!approvedActive(req) || !canManageBankEligibility(req)) return res.status(403).json({ error: '자동 입금확인 대상 확정 권한이 없습니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    if (!autoReconciliationEnabled) return res.status(409).json({ error: 'IBK 공식 거래번호 연동 전까지 자동 입금확인은 안전상 보류되어 있습니다.' });
    let id;
    let expectedRowVersion;
    try {
      id = validId(req.params.id, 'INTAKE_ID_INVALID');
      expectedRowVersion = requiredVersion(req.body?.expectedRowVersion, 'INTAKE_ROW_VERSION_REQUIRED');
      if (typeof req.body?.eligible !== 'boolean') routeFail(400, 'INTAKE_ELIGIBILITY_INVALID', 'eligible 값은 true 또는 false여야 합니다.');
    } catch (error) { return sendRouteError(res, error, 'peakos eligibility validation error', logger); }
    const reason = cleanText(req.body.reason, 500);
    if (reason.length < 5) return res.status(400).json({ error: '확정 또는 해제 사유를 5자 이상 입력해 주세요.' });
    const actor = actorFrom(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-intake-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_intake IN ROW EXCLUSIVE MODE');
      const result = await client.query(
        `SELECT * FROM peakos_intake
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          FOR UPDATE`,
        [id, workspaceId],
      );
      const row = result.rows[0];
      if (!row) routeFail(404, 'INTAKE_NOT_FOUND', '접수를 찾지 못했습니다.');
      if (Number(row.row_version) !== expectedRowVersion) routeFail(409, 'INTAKE_VERSION_CONFLICT', '다른 작업자가 먼저 수정한 접수입니다.');
      const allocation = await client.query(
        `SELECT 1 FROM peakos_bank_allocations
          WHERE intake_id = $1 AND status = 'ACTIVE'
            AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          LIMIT 1 FOR UPDATE`,
        [id, workspaceId],
      );
      if (allocation.rows.length || row.paid_auto) routeFail(409, 'INTAKE_BANK_LOCKED', '이미 통장 입금과 연결된 접수의 확정 상태는 바꿀 수 없습니다.');
      if (req.body.eligible) {
        const owner = await client.query(
          `SELECT 1 FROM users
            WHERE uid = $1 AND approved = TRUE AND COALESCE(is_active,TRUE) = TRUE
              AND EXISTS (
                SELECT 1 FROM peakos_workspace_memberships membership
                 WHERE membership.workspace_id = $2
                   AND membership.user_uid = users.uid
                   AND membership.active = TRUE
                   AND membership.role <> 'oversight'
              )`,
          [row.owner_uid, workspaceId],
        );
        const remaining = expectedAmount(row) - Number(row.paid_amount || 0);
        if (!owner.rows.length || !['normal', 'reserve'].includes(row.kind)
            || !String(row.expected_payer || row.client || '').trim()
            || !Number.isSafeInteger(remaining) || remaining <= 0) {
          routeFail(409, 'INTAKE_ELIGIBILITY_NOT_ALLOWED', '활성 영업자·예상 입금자명·정확한 미입금액이 있는 접수만 확정할 수 있습니다.');
        }
      }
      const updated = await client.query(
        `UPDATE peakos_intake
            SET bank_match_eligible = $2,
                bank_match_approved_by_uid = CASE WHEN $2 THEN $3 ELSE NULL END,
                bank_match_approved_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                workspace_id = COALESCE(workspace_id, $4),
                row_version = row_version + 1, updated_at = NOW()
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$4')}
          RETURNING *`,
        [id, req.body.eligible, actor.uid, workspaceId],
      );
      const after = updated.rows[0];
      if (!after) routeFail(404, 'INTAKE_NOT_FOUND', '접수를 찾지 못했습니다.');
      await auditIntake(
        client, after,
        req.body.eligible ? 'BANK_MATCH_ELIGIBILITY_GRANTED' : 'BANK_MATCH_ELIGIBILITY_REVOKED',
        actor, requestId(req), row, { reason }, workspaceId,
      );
      await client.query(
        `INSERT INTO peakos_bank_audit_log
          (workspace_id,action,entity_type,entity_id,actor_uid,actor_name,reason,metadata)
         VALUES ($1,$2,'INTAKE',$3,$4,$5,$6,$7::jsonb)`,
        [workspaceId, req.body.eligible ? 'BANK_MATCH_ELIGIBILITY_GRANTED' : 'BANK_MATCH_ELIGIBILITY_REVOKED',
          id, actor.uid, actor.name, reason, JSON.stringify({ eligible: req.body.eligible, rowVersion: Number(after.row_version) })],
      );
      await client.query('COMMIT');
      return res.json(intakeOut(after, {
        showCost: canSeeAll(req), showVendor: canReviewFinance(req),
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos eligibility error', logger);
    } finally { client.release(); }
  });

  app.get('/api/peakos/final-execution', authMiddleware, async (req, res) => {
    const workspaceId = workspaceForRoute(req, res);
    if (!workspaceId) return undefined;
    if (!canSeeFinalExecution(req) && !isWorkspaceOversight(req)) {
      return res.status(403).json({ error: '최종실행정산서 열람 권한이 없습니다.' });
    }
    try {
      const result = await pool.query(
        `SELECT * FROM peakos_monthly
          WHERE view = ANY($1::text[])
            AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          ORDER BY date DESC, view, created_at, id`,
        [Object.keys(monthlyOwners), workspaceId],
      );
      res.set('Cache-Control', 'no-store');
      return res.json({ rows: result.rows.map(row => monthlyOut(row, { includeView: true })) });
    } catch (error) { return sendRouteError(res, error, 'peakos final execution read error', logger); }
  });

  app.get('/api/peakos/monthly/:view', authMiddleware, async (req, res) => {
    const view = req.params.view;
    if (!monthlyOwners[view]) return res.status(404).json({ error: '없는 화면입니다.' });
    const workspaceId = workspaceForRoute(req, res);
    if (!workspaceId) return undefined;
    if (workspaceId !== PEAK_WORKSPACE_ID && !isWorkspaceOversight(req)) {
      return rejectUnassignedBranchMonthly(res);
    }
    try {
      const previewOwner = String(req.query.owner || '').trim();
      const all = req.query.scope === 'all';
      let ownerUid = String(req.uid || '');
      if (previewOwner) {
        // 계정 미리보기는 해당 전용 원장의 실제 소유자만 지정할 수 있다.
        // 화면 이름을 믿지 않고 원장에 귀속된 immutable UID를 다시 해석한 뒤,
        // 계정 미리보기 권한도 서버에서 별도로 확인한다.
        if (previewOwner !== monthlyOwners[view]) {
          return res.status(403).json({ error: '이 계정의 전용 정산서가 아닙니다.' });
        }
        ownerUid = await resolvePreviewOwnerUid(pool, previewOwner, workspaceId);
        if (!canReadOwnerUid(req, ownerUid) && !isWorkspaceOversight(req)) {
          return res.status(403).json({ error: '이 계정의 정산서는 볼 수 없습니다.' });
        }
      } else if (all) {
        if (!canSeeAll(req) && !isWorkspaceOversight(req)) {
          return res.status(403).json({ error: '전체 정산서는 지정된 인원만 볼 수 있습니다.' });
        }
      } else if (!canSeeMonthly(req, view) && !isWorkspaceOversight(req)) {
        return res.status(403).json({ error: '열람 권한이 없습니다.' });
      }
      const result = all
        ? await pool.query(
          `SELECT * FROM peakos_monthly
            WHERE view = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            ORDER BY created_at,id`,
          [view, workspaceId],
        )
        : await pool.query(
          `SELECT * FROM peakos_monthly
            WHERE view = $1 AND owner_uid = $2
              AND ${legacyPeakWorkspaceSql('workspace_id', '$3')}
            ORDER BY created_at,id`,
          [view, ownerUid, workspaceId],
        );
      res.set('Cache-Control', 'no-store');
      return res.json(result.rows.map(row => monthlyOut(row)));
    } catch (error) { return sendRouteError(res, error, 'peakos monthly read error', logger); }
  });

  app.post('/api/peakos/monthly/:view', authMiddleware, async (req, res) => {
    const view = req.params.view;
    if (!monthlyOwners[view]) return res.status(404).json({ error: '없는 화면입니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    if (workspaceId !== PEAK_WORKSPACE_ID && !isWorkspaceOversight(req)) {
      return rejectUnassignedBranchMonthly(res);
    }
    if (!canManageMonthly(req, view)) return res.status(403).json({ error: '본인 정산서만 수정할 수 있습니다.' });
    const actor = actorFrom(req, getName);
    let rows;
    try { rows = normalizeMonthlyCreate(req.body, actor, view); }
    catch (error) { return sendRouteError(res, error, 'peakos monthly create validation error', logger); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-monthly-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_monthly IN ROW EXCLUSIVE MODE');
      const ids = rows.map(row => row.id).sort();
      const [existing, tombstones] = await Promise.all([
        client.query(
          `SELECT id FROM peakos_monthly
            WHERE id = ANY($1::text[]) AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            ORDER BY id FOR UPDATE`,
          [ids, workspaceId],
        ),
        client.query(
          `SELECT target_id FROM peakos_monthly_tombstones
            WHERE target_id = ANY($1::text[]) AND workspace_id = $2
            ORDER BY target_id FOR UPDATE`,
          [ids, workspaceId],
        ),
      ]);
      if (existing.rows.length || tombstones.rows.length) routeFail(409, 'MONTHLY_CREATE_ID_CONFLICT', '이미 존재하거나 삭제된 월별 정산 ID는 다시 등록할 수 없습니다.');
      const inserted = [];
      const reqId = requestId(req);
      for (const row of [...rows].sort((left, right) => (left.kind === 'sale' ? -1 : 1) - (right.kind === 'sale' ? -1 : 1))) {
        if (row.kind === 'run') {
          const parent = await client.query(
            `SELECT 1 FROM peakos_monthly
              WHERE id = $1 AND view = $2 AND owner_uid = $3 AND kind = 'sale'
                AND ${legacyPeakWorkspaceSql('workspace_id', '$4')}
              FOR SHARE`,
            [row.parent_id, view, row.owner_uid, workspaceId],
          );
          if (!parent.rows.length) routeFail(409, 'MONTHLY_PARENT_NOT_FOUND', '같은 정산서의 판매 건에만 실행 건을 연결할 수 있습니다.');
        }
        const values = [row.id,row.view,row.owner_uid,row.owner_name,row.kind,row.parent_id,row.date,row.client,row.a,row.b,row.c,row.amount,row.qty,row.period,row.memo,workspaceId];
        const result = await client.query(
          `INSERT INTO peakos_monthly
            (id,view,owner_uid,owner_name,kind,parent_id,date,client,a,b,c,amount,qty,period,memo,workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          values,
        );
        inserted.push(result.rows[0]);
        await auditMonthly(client, result.rows[0], 'CREATE', actor, reqId, null, {}, workspaceId);
      }
      await client.query('COMMIT');
      const byId = new Map(inserted.map(row => [row.id, row]));
      return res.status(201).json({ rows: rows.map(row => monthlyOut(byId.get(row.id))) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos monthly create error', logger);
    } finally { client.release(); }
  });

  app.patch('/api/peakos/monthly/:view', authMiddleware, async (req, res) => {
    const view = req.params.view;
    if (!monthlyOwners[view]) return res.status(404).json({ error: '없는 화면입니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    if (workspaceId !== PEAK_WORKSPACE_ID && !isWorkspaceOversight(req)) {
      return rejectUnassignedBranchMonthly(res);
    }
    if (!canManageMonthly(req, view)) return res.status(403).json({ error: '본인 정산서만 수정할 수 있습니다.' });
    let rows;
    try { rows = normalizeMonthlyPatch(req.body); }
    catch (error) { return sendRouteError(res, error, 'peakos monthly patch validation error', logger); }
    const actor = actorFrom(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-monthly-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_monthly IN ROW EXCLUSIVE MODE');
      const ids = rows.map(row => row.id).sort();
      const locked = await client.query(
        `SELECT * FROM peakos_monthly
          WHERE id = ANY($1::text[]) AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          ORDER BY id FOR UPDATE`,
        [ids, workspaceId],
      );
      if (locked.rows.length !== ids.length || locked.rows.some(row => row.view !== view)) routeFail(404, 'MONTHLY_NOT_FOUND', '수정할 월별 정산 행을 찾지 못했습니다.');
      const byId = new Map(locked.rows.map(row => [row.id, row]));
      for (const item of rows) {
        if (Number(byId.get(item.id).row_version) !== item.expectedRowVersion) routeFail(409, 'MONTHLY_VERSION_CONFLICT', '다른 작업자가 먼저 수정한 월별 정산 행입니다.');
      }
      const updated = [];
      const reqId = requestId(req);
      for (const item of rows) {
        const before = byId.get(item.id);
        const mapped = Object.fromEntries(Object.entries(item.changes).map(([key, value]) => [MONTHLY_API_TO_DB[key], value]));
        const columns = Object.keys(mapped);
        const values = columns.map(column => mapped[column]);
        const idPlaceholder = `$${values.length + 1}`;
        const workspacePlaceholder = `$${values.length + 2}`;
        const result = await client.query(
          `UPDATE peakos_monthly SET ${columns.map((column,index) => `${column} = $${index + 1}`).join(',')},
                  workspace_id = COALESCE(workspace_id, ${workspacePlaceholder}),
                  row_version = row_version + 1
            WHERE id = ${idPlaceholder}
              AND ${legacyPeakWorkspaceSql('workspace_id', workspacePlaceholder)}
            RETURNING *`,
          [...values, item.id, workspaceId],
        );
        if (!result.rows[0]) routeFail(404, 'MONTHLY_NOT_FOUND', '수정할 월별 정산 행을 찾지 못했습니다.');
        updated.push(result.rows[0]);
        await auditMonthly(
          client, result.rows[0], 'PATCH', actor, reqId, before,
          { changedFields: Object.keys(item.changes) }, workspaceId,
        );
      }
      await client.query('COMMIT');
      return res.json({ rows: updated.map(row => monthlyOut(row)) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos monthly patch error', logger);
    } finally { client.release(); }
  });

  app.delete('/api/peakos/monthly/:view/:id', authMiddleware, async (req, res) => {
    const view = req.params.view;
    if (!monthlyOwners[view]) return res.status(404).json({ error: '없는 화면입니다.' });
    const workspaceId = workspaceForRoute(req, res, { write: true });
    if (!workspaceId) return undefined;
    if (workspaceId !== PEAK_WORKSPACE_ID && !isWorkspaceOversight(req)) {
      return rejectUnassignedBranchMonthly(res);
    }
    if (!canManageMonthly(req, view)) return res.status(403).json({ error: '본인 정산서만 수정할 수 있습니다.' });
    let id;
    let expectedRowVersion;
    try {
      id = validId(req.params.id, 'MONTHLY_ID_INVALID');
      expectedRowVersion = requiredVersion(req.body?.expectedRowVersion);
    } catch (error) { return sendRouteError(res, error, 'peakos monthly delete validation error', logger); }
    const actor = actorFrom(req, getName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`peakos-monthly-api-mutation-v1:${workspaceId}`]);
      await client.query('LOCK TABLE peakos_monthly IN ROW EXCLUSIVE MODE');
      const result = await client.query(
        `SELECT * FROM peakos_monthly
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
          FOR UPDATE`,
        [id, workspaceId],
      );
      const row = result.rows[0];
      if (!row || row.view !== view) routeFail(404, 'MONTHLY_NOT_FOUND', '월별 정산 행을 찾지 못했습니다.');
      if (Number(row.row_version) !== expectedRowVersion) routeFail(409, 'MONTHLY_VERSION_CONFLICT', '다른 작업자가 먼저 수정한 월별 정산 행입니다.');
      if (row.kind === 'sale') {
        const children = await client.query(
          `SELECT 1 FROM peakos_monthly
            WHERE parent_id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}
            LIMIT 1 FOR UPDATE`,
          [id, workspaceId],
        );
        if (children.rows.length) routeFail(409, 'MONTHLY_HAS_CHILDREN', '연결된 실행 건을 먼저 삭제해 주세요.');
      }
      const reason = '사용자 요청으로 월별 정산 행 삭제';
      await client.query(
        `INSERT INTO peakos_monthly_tombstones
          (workspace_id,target_id,row_version,deleted_by_uid,deleted_by_name,delete_reason,last_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [workspaceId, id, Number(row.row_version), actor.uid, actor.name, reason, JSON.stringify(row)],
      );
      await client.query(
        `DELETE FROM peakos_monthly
          WHERE id = $1 AND ${legacyPeakWorkspaceSql('workspace_id', '$2')}`,
        [id, workspaceId],
      );
      await auditMonthly(client, row, 'DELETE', actor, requestId(req), row, { reason }, workspaceId);
      await client.query('COMMIT');
      return res.json({ deleted: id, rowVersion: Number(row.row_version) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return sendRouteError(res, error, 'peakos monthly delete error', logger);
    } finally { client.release(); }
  });
}

module.exports = {
  MONTHLY_MUTABLE_FIELDS,
  SettlementRouteError,
  intakeOut,
  monthlyOut,
  normalizeMonthlyCreate,
  normalizeMonthlyPatch,
  registerPeakosSettlementRoutes,
  resolvePreviewOwnerUid,
  validateRelationship,
};
