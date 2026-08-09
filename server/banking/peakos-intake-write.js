'use strict';

const ACTION_FIELDS = Object.freeze({
  business: Object.freeze([
    'date', 'client', 'expectedPayer', 'a', 'b', 'c', 'unit', 'qty', 'sell',
    'expectedDepositAmount', 'memo', 'kind', 'refOf', 'supplier',
  ]),
  manager: Object.freeze(['manager']),
  payment: Object.freeze(['paidAmount', 'payer', 'paidDate', 'paidMemo']),
  // vendorBy is deliberately absent. The server records the authenticated
  // actor and never accepts an attribution supplied by the browser.
  vendor: Object.freeze(['vendorPaid', 'vendorPaidDate', 'vendorBank', 'vendorMemo']),
  cost: Object.freeze(['cost']),
});

const API_TO_DB = Object.freeze({
  date: 'date',
  client: 'client',
  expectedPayer: 'expected_payer',
  a: 'a',
  b: 'b',
  c: 'c',
  unit: 'unit',
  qty: 'qty',
  sell: 'sell',
  expectedDepositAmount: 'expected_deposit_amount',
  memo: 'memo',
  kind: 'kind',
  refOf: 'ref_of',
  supplier: 'supplier',
  manager: 'manager',
  paidAmount: 'paid_amount',
  payer: 'payer',
  paidDate: 'paid_date',
  paidMemo: 'paid_memo',
  vendorPaid: 'vendor_paid',
  vendorPaidDate: 'vendor_paid_date',
  vendorBank: 'vendor_bank',
  vendorMemo: 'vendor_memo',
  cost: 'cost',
});

const CREATE_FIELDS = new Set([
  'id', ...ACTION_FIELDS.business, 'manager', 'finalOnly', 'cost',
]);
const TEXT_LIMITS = Object.freeze({
  client: 200,
  expectedPayer: 120,
  a: 80,
  b: 80,
  c: 120,
  memo: 500,
  refOf: 80,
  supplier: 120,
  manager: 80,
  payer: 120,
  paidMemo: 500,
  vendorBank: 80,
  vendorBy: 80,
  vendorMemo: 500,
});
const NUMBER_FIELDS = new Set(['unit', 'qty', 'sell', 'expectedDepositAmount', 'paidAmount', 'cost']);
const DATE_FIELDS = new Set(['date', 'paidDate', 'vendorPaidDate']);
const KINDS = new Set(['normal', 'reserve', 'use', 'refund']);

class IntakeWriteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'IntakeWriteError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new IntakeWriteError(status, code, message);
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function isDateKey(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function finiteNumber(value, field, { nullable = false, minimum = null } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (nullable) return null;
    fail(400, 'INTAKE_NUMBER_REQUIRED', `${field} 값이 필요합니다.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) fail(400, 'INTAKE_NUMBER_INVALID', `${field} 값이 올바르지 않습니다.`);
  if (minimum !== null && number < minimum) {
    fail(400, 'INTAKE_NUMBER_OUT_OF_RANGE', `${field} 값이 허용 범위를 벗어났습니다.`);
  }
  return number;
}

function validateId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(id)) {
    fail(400, 'INTAKE_ID_INVALID', '접수 ID가 올바르지 않습니다.');
  }
  return id;
}

function rejectUnknownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'INTAKE_BODY_INVALID', `${label} 형식이 올바르지 않습니다.`);
  }
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail(400, 'INTAKE_FIELDS_NOT_ALLOWED', `${label}에 허용되지 않은 필드가 있습니다.`);
}

function normalizeField(field, value) {
  if (field === 'kind') {
    if (!KINDS.has(value)) fail(400, 'INTAKE_KIND_INVALID', '접수 구분이 올바르지 않습니다.');
    return value;
  }
  if (field === 'vendorPaid') {
    if (value !== true) fail(400, 'INTAKE_VENDOR_STATE_INVALID', '공급처 정산 상태가 올바르지 않습니다.');
    return true;
  }
  if (NUMBER_FIELDS.has(field)) {
    return finiteNumber(value, field, {
      nullable: field === 'expectedDepositAmount' || field === 'cost',
      minimum: field === 'paidAmount' ? 0.0000001 : (field === 'cost' ? 0 : null),
    });
  }
  if (DATE_FIELDS.has(field)) {
    const date = String(value || '');
    if (!isDateKey(date)) fail(400, 'INTAKE_DATE_INVALID', `${field} 날짜가 올바르지 않습니다.`);
    return date;
  }
  if (Object.prototype.hasOwnProperty.call(TEXT_LIMITS, field)) {
    return cleanText(value, TEXT_LIMITS[field]);
  }
  fail(400, 'INTAKE_FIELD_UNKNOWN', '알 수 없는 접수 필드입니다.');
}

function normalizeCreateRows(body, actor, capabilities = {}) {
  const inputRows = Array.isArray(body?.rows) ? body.rows : [body];
  if (!inputRows.length || inputRows.length > 500) {
    fail(400, 'INTAKE_CREATE_COUNT_INVALID', '한 번에 1~500건까지 등록할 수 있습니다.');
  }
  const ids = new Set();
  return inputRows.map(input => {
    rejectUnknownFields(input, CREATE_FIELDS, '신규 접수');
    const id = validateId(input.id);
    if (ids.has(id)) fail(409, 'INTAKE_CREATE_DUPLICATE_ID', '한 요청 안에 접수 ID가 중복됩니다.');
    ids.add(id);
    if (!isDateKey(input.date)) fail(400, 'INTAKE_DATE_INVALID', '접수 일자가 올바르지 않습니다.');
    const manager = cleanText(input.manager, TEXT_LIMITS.manager);
    if (manager && !capabilities.canManage) {
      fail(403, 'INTAKE_MANAGER_FORBIDDEN', '접수담당자 지정 권한이 없습니다.');
    }
    const finalOnly = input.finalOnly === true;
    if (finalOnly && !capabilities.canFinal) {
      fail(403, 'INTAKE_FINAL_ONLY_FORBIDDEN', '최종정산서 전용 접수 권한이 없습니다.');
    }
    if (Object.prototype.hasOwnProperty.call(input, 'cost') && input.cost !== null
        && input.cost !== '' && !capabilities.canCost) {
      fail(403, 'INTAKE_COST_FORBIDDEN', '회사 원가 입력 권한이 없습니다.');
    }
    const kind = input.kind === undefined ? 'normal' : normalizeField('kind', input.kind);
    const client = cleanText(input.client, TEXT_LIMITS.client);
    return {
      id,
      owner_uid: String(actor.uid || ''),
      owner_name: cleanText(actor.name, 120),
      date: String(input.date),
      client,
      expected_payer: cleanText(input.expectedPayer || client, TEXT_LIMITS.expectedPayer),
      expected_deposit_amount: Object.prototype.hasOwnProperty.call(input, 'expectedDepositAmount')
        ? normalizeField('expectedDepositAmount', input.expectedDepositAmount) : null,
      a: cleanText(input.a, TEXT_LIMITS.a),
      b: cleanText(input.b, TEXT_LIMITS.b),
      c: cleanText(input.c, TEXT_LIMITS.c),
      unit: input.unit === undefined || input.unit === '' ? 0 : normalizeField('unit', input.unit),
      qty: input.qty === undefined || input.qty === '' ? 0 : normalizeField('qty', input.qty),
      sell: input.sell === undefined || input.sell === '' ? 0 : normalizeField('sell', input.sell),
      cost: capabilities.canCost && Object.prototype.hasOwnProperty.call(input, 'cost')
        ? normalizeField('cost', input.cost) : null,
      memo: cleanText(input.memo, TEXT_LIMITS.memo),
      kind,
      ref_of: cleanText(input.refOf, TEXT_LIMITS.refOf),
      supplier: cleanText(input.supplier, TEXT_LIMITS.supplier),
      manager,
      final_only: finalOnly,
      paid: 'none',
      paid_amount: 0,
      payer: '',
      paid_date: '',
      paid_memo: '',
      paid_auto: false,
      vendor_paid: false,
      vendor_paid_amount: null,
      vendor_paid_date: '',
      vendor_bank: '',
      vendor_by: '',
      vendor_memo: '',
    };
  });
}

function normalizePatchRequest(body) {
  const action = String(body?.action || '');
  const allowedFields = ACTION_FIELDS[action];
  if (!allowedFields) fail(400, 'INTAKE_ACTION_INVALID', '접수 수정 종류가 올바르지 않습니다.');
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) {
    fail(400, 'INTAKE_PATCH_COUNT_INVALID', '한 번에 1~500건까지 수정할 수 있습니다.');
  }
  const allowed = new Set(allowedFields);
  const ids = new Set();
  return {
    action,
    rows: rows.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(400, 'INTAKE_PATCH_INVALID', '접수 수정 형식이 올바르지 않습니다.');
      }
      const id = validateId(item.id);
      if (ids.has(id)) fail(409, 'INTAKE_PATCH_DUPLICATE_ID', '한 요청 안에 접수 ID가 중복됩니다.');
      ids.add(id);
      const expectedRowVersion = Number(item.expectedRowVersion);
      if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
        fail(400, 'INTAKE_ROW_VERSION_REQUIRED', '최신 접수 버전이 필요합니다.');
      }
      rejectUnknownFields(item.changes, allowed, '접수 변경사항');
      const changes = Object.fromEntries(Object.entries(item.changes).map(([field, value]) => [
        field,
        normalizeField(field, value),
      ]));
      if (!Object.keys(changes).length) fail(400, 'INTAKE_PATCH_EMPTY', '바꿀 접수 내용이 없습니다.');
      if (action === 'payment') {
        const required = ['paidAmount', 'payer', 'paidDate', 'paidMemo'];
        if (required.some(field => !Object.prototype.hasOwnProperty.call(changes, field))) {
          fail(400, 'INTAKE_PAYMENT_FIELDS_REQUIRED', '입금 확인 정보를 모두 입력해 주세요.');
        }
        if (!Number.isSafeInteger(changes.paidAmount) || changes.paidAmount <= 0) {
          fail(400, 'INTAKE_PAYMENT_AMOUNT_INVALID', '입금액은 1원 이상의 정수여야 합니다.');
        }
        if (!changes.payer) {
          fail(400, 'INTAKE_PAYMENT_PAYER_REQUIRED', '실제 입금자명을 입력해 주세요.');
        }
        if (changes.paidMemo.length < 8) {
          fail(400, 'INTAKE_PAYMENT_MEMO_REQUIRED', '입금 사유를 8자 이상 입력해 주세요.');
        }
      }
      if (action === 'vendor') {
        const required = ['vendorPaid', 'vendorPaidDate', 'vendorBank', 'vendorMemo'];
        if (required.some(field => !Object.prototype.hasOwnProperty.call(changes, field))) {
          fail(400, 'INTAKE_VENDOR_FIELDS_REQUIRED', '공급처 정산 정보를 모두 입력해 주세요.');
        }
        if (!changes.vendorBank) {
          fail(400, 'INTAKE_VENDOR_BANK_REQUIRED', '지급 통장을 입력해 주세요.');
        }
        if (changes.vendorMemo.length < 8) {
          fail(400, 'INTAKE_VENDOR_MEMO_REQUIRED', '공급처 정산 사유를 8자 이상 입력해 주세요.');
        }
      }
      return { id, expectedRowVersion, changes };
    }),
  };
}

function actionAllowed(action, { sameOwner = false, canFinance = false, canManage = false, canCost = false } = {}) {
  if (action === 'business') return sameOwner;
  if (action === 'payment' || action === 'vendor') return canFinance;
  if (action === 'manager') return canManage;
  if (action === 'cost') return canCost;
  return false;
}

function paidState(expectedAmount, paidAmount) {
  const expected = Number(expectedAmount);
  const paid = Number(paidAmount);
  if (!Number.isSafeInteger(expected) || expected <= 0
      || !Number.isSafeInteger(paid) || paid <= 0) {
    fail(409, 'INTAKE_PAYMENT_NOT_ELIGIBLE', '양수 입금예정액이 있는 접수만 입금 확인할 수 있습니다.');
  }
  if (paid === expected) return 'paid';
  return paid < expected ? 'partial' : 'wrong';
}

function derivedStoredPaidState(expectedAmountValue, paidAmountValue, fallback = 'none') {
  const expected = Number(expectedAmountValue);
  const paid = Number(paidAmountValue);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(paid) || paid < 0) return fallback;
  if (paid === 0) return 'none';
  if (paid === expected) return 'paid';
  return paid < expected ? 'partial' : 'wrong';
}

function expectedAmount(row) {
  if (row.expected_deposit_amount !== null && row.expected_deposit_amount !== undefined) {
    return Number(row.expected_deposit_amount);
  }
  return (Number(row.sell) || 0) * (Number(row.qty) || 0);
}

function vendorAmount(row) {
  if (!['normal', 'use'].includes(String(row.kind || '')) || Number(row.qty) <= 0
      || row.cost === null || row.cost === undefined || Number(row.cost) < 0) {
    fail(409, 'INTAKE_VENDOR_NOT_ELIGIBLE', '확정 원가가 있는 양수 실행 건만 공급처 정산할 수 있습니다.');
  }
  const amount = Number(row.cost) * Number(row.qty);
  if (!Number.isFinite(amount) || amount <= 0) {
    fail(409, 'INTAKE_VENDOR_NOT_ELIGIBLE', '공급처 정산 금액이 올바르지 않습니다.');
  }
  return amount;
}

function databaseChanges(action, changes, row) {
  const mapped = Object.fromEntries(Object.entries(changes).map(([field, value]) => [API_TO_DB[field], value]));
  if (action === 'payment') {
    mapped.paid = paidState(expectedAmount(row), changes.paidAmount);
    mapped.paid_auto = false;
  }
  if (action === 'vendor') mapped.vendor_paid_amount = vendorAmount(row);
  if (action === 'business' && isFinancialBusinessChange(changes)) {
    const merged = { ...row, ...mapped };
    mapped.paid = derivedStoredPaidState(
      expectedAmount(merged),
      merged.paid_amount,
      String(row.paid || 'none'),
    );
  }
  return mapped;
}

function isFinancialBusinessChange(changes) {
  return ['qty', 'sell', 'expectedDepositAmount', 'kind']
    .some(field => Object.prototype.hasOwnProperty.call(changes, field));
}

module.exports = {
  ACTION_FIELDS,
  API_TO_DB,
  IntakeWriteError,
  actionAllowed,
  databaseChanges,
  derivedStoredPaidState,
  expectedAmount,
  isDateKey,
  isFinancialBusinessChange,
  normalizeCreateRows,
  normalizePatchRequest,
  paidState,
  vendorAmount,
};
