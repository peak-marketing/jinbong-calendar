'use strict';

const crypto = require('node:crypto');
const { createSalesPiiCrypto } = require('./peakos-sales-leads-crypto');
const {
  SALES_CALL_DISPOSITIONS,
  SALES_LEAD_CHANNELS,
  SALES_LEAD_SOURCES,
  SALES_LEAD_STATUSES,
  SalesLeadHttpError,
  assertSalesWrite,
  createSalesLeadContext,
  normalizeDuration,
  normalizeEnum,
  normalizeExpectedVersion,
  normalizePhone,
  normalizeStrictObject,
  normalizeText,
  normalizeTimestamp,
  normalizeUid,
  normalizeUuid,
} = require('./peakos-sales-leads-policy');

const SALES_BASE_PATH = '/api/peakos/sales-leads';

function fail(status, code, message) {
  throw new SalesLeadHttpError(status, code, message);
}

function sendError(res, error) {
  let status = Number(error?.status || error?.statusCode) || 500;
  let code = String(error?.code || 'SALES_INTERNAL_ERROR');
  let message = error?.message || '영업 DB를 처리하지 못했습니다.';
  if (error?.code === '23505' && /peakos_sales_leads_active_phone_unique/.test(String(error.constraint || error.message))) {
    status = 409;
    code = 'SALES_PHONE_DUPLICATE';
    message = '이 워크스페이스에 같은 전화번호의 활성 리드가 이미 있습니다.';
  }
  if (status >= 500) message = '영업 DB를 처리하지 못했습니다.';
  return res.status(status).json({ code, error: message });
}

function safeLeadState(row) {
  return {
    ownerUid: String(row.owner_uid),
    companyName: String(row.company_name),
    channel: String(row.channel),
    source: String(row.source),
    status: String(row.status),
    nextFollowupAt: row.next_followup_at || null,
    lastContactAt: row.last_contact_at || null,
    archived: !!row.archived_at,
  };
}

function maskedPhone(last4) {
  return `***-****-${String(last4 || '').slice(-4)}`;
}

function mapLead(row, context, piiCrypto, { maskPii = false } = {}) {
  const redacted = context.isOversight === true || maskPii;
  const contact = redacted
    ? {
      contactName: null,
      phone: null,
      phoneMasked: maskedPhone(row.phone_last4),
      address: null,
      memo: null,
      redacted: true,
    }
    : { ...piiCrypto.decryptContact(row), phoneMasked: maskedPhone(row.phone_last4), redacted: false };
  return {
    id: String(row.id),
    companyName: row.company_name,
    owner: { uid: row.owner_uid, name: row.owner_name_snapshot },
    contact,
    channel: row.channel,
    source: row.source,
    status: row.status,
    nextFollowupAt: row.next_followup_at || null,
    lastContactAt: row.last_contact_at || null,
    version: Number(row.version),
    archived: !!row.archived_at,
    archivedAt: row.archived_at || null,
    createdBy: { uid: row.created_by_uid, name: row.created_by_name_snapshot },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCall(row, context, piiCrypto) {
  const redacted = context.isOversight === true;
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    actor: { uid: row.actor_uid, name: row.actor_name_snapshot },
    disposition: row.disposition,
    occurredAt: row.occurred_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    note: redacted ? null : piiCrypto.decryptCallNote(row),
    noteRedacted: redacted,
    nextFollowupAt: row.next_followup_at || null,
    createdAt: row.created_at,
  };
}

async function listEligibleWorkspaceOwners(db, context, { ownerUid, lock = false } = {}) {
  const requestedUid = ownerUid === undefined
    ? null
    : normalizeUid(ownerUid, '영업 담당자');
  if (lock && requestedUid) {
    // Match the restriction service's user -> membership lock order. Separate
    // statements make acquisition order deterministic and avoid a joined
    // row-lock plan taking the same rows in the opposite order.
    await db.query(
      'SELECT uid FROM users WHERE uid = $1 FOR SHARE',
      [requestedUid],
    );
    await db.query(
      `SELECT user_uid
         FROM peakos_workspace_memberships
        WHERE workspace_id = $1 AND user_uid = $2
        FOR SHARE`,
      [context.workspaceId, requestedUid],
    );
    await db.query(
      'SELECT id FROM peakos_workspaces WHERE id = $1 FOR SHARE',
      [context.workspaceId],
    );
  }
  const result = await db.query(
    `SELECT users.uid, users.name
       FROM users
       JOIN peakos_workspace_memberships membership
         ON membership.workspace_id = $1
        AND membership.user_uid = users.uid
        AND membership.active = TRUE
        AND membership.role <> 'oversight'
       JOIN peakos_workspaces workspace
         ON workspace.id = membership.workspace_id
        AND workspace.active = TRUE
       LEFT JOIN groups user_group ON user_group.id = users.group_id
      WHERE ($2::text IS NULL OR users.uid = $2)
        AND users.approved = TRUE
        AND COALESCE(users.is_active, TRUE) = TRUE
        AND COALESCE(users.chat_only, FALSE) = FALSE
        AND COALESCE(users.external_calendar_only, FALSE) = FALSE
        AND membership.permissions->>'sales' = 'write'
        AND (membership.role IN ('admin', 'manager') OR user_group.group_type = 'sales')
        AND ($3::boolean OR users.uid = $4)
      ORDER BY users.name, users.uid`,
    [
      context.workspaceId,
      requestedUid,
      context.scope === 'workspace',
      context.uid,
    ],
  );
  return result.rows.map(row => ({
    uid: String(row.uid),
    name: String(row.name || '사용자').trim().slice(0, 160) || '사용자',
  }));
}

async function resolveWorkspaceOwner(db, context, ownerUid) {
  const uid = normalizeUid(ownerUid || context.uid, '영업 담당자');
  if (!context.isManager && uid !== context.uid) {
    fail(403, 'SALES_OWNER_FORBIDDEN', '일반 구성원은 자신의 리드만 등록하거나 변경할 수 있습니다.');
  }
  // Always revalidate even a self-assignment. The authenticated request may
  // have been admitted just before an administrator restricted this account.
  // FOR SHARE conflicts with the restriction service's FOR UPDATE locks on
  // both rows, so an in-flight assignment observes one canonical state.
  const owners = await listEligibleWorkspaceOwners(db, context, { ownerUid: uid, lock: true });
  if (!owners[0]) {
    fail(400, 'SALES_OWNER_INVALID', '선택한 영업 담당자는 현재 워크스페이스의 영업 구성원 또는 조직 관리자가 아닙니다.');
  }
  return owners[0];
}

async function loadLead(db, context, leadId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT * FROM peakos_sales_leads
      WHERE workspace_id = $1
        AND id = $2
        AND ($3::boolean OR owner_uid = $4)
      ${lock ? 'FOR UPDATE' : ''}`,
    [context.workspaceId, leadId, context.scope === 'workspace', context.uid],
  );
  if (!result.rows[0]) fail(404, 'SALES_LEAD_NOT_FOUND', '영업 리드를 찾을 수 없습니다.');
  return result.rows[0];
}

function assertMutableLead(row, expectedVersion) {
  if (row.archived_at) fail(409, 'SALES_LEAD_ARCHIVED', '보관된 리드는 변경할 수 없습니다.');
  if (Number(row.version) !== expectedVersion) {
    fail(409, 'SALES_VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.');
  }
}

async function recordHistory(db, context, leadId, action, version, beforeState, afterState) {
  await db.query(
    `INSERT INTO peakos_sales_lead_history
       (workspace_id, lead_id, action, actor_uid, actor_name_snapshot,
        entity_version, before_state, after_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [
      context.workspaceId, leadId, action, context.uid, context.name, version,
      JSON.stringify(beforeState || {}), JSON.stringify(afterState || {}),
    ],
  );
}

function normalizedContact(body, existing = {}) {
  return {
    contactName: body.contactName === undefined
      ? String(existing.contactName || '')
      : normalizeText(body.contactName, { field: '담당자명', required: false, max: 160 }),
    phone: body.phone === undefined ? normalizePhone(String(existing.phone || '')) : normalizePhone(body.phone),
    address: body.address === undefined
      ? String(existing.address || '')
      : normalizeText(body.address, { field: '주소', required: false, max: 1000 }),
    memo: body.memo === undefined
      ? String(existing.memo || '')
      : normalizeText(body.memo, { field: '메모', required: false, max: 20000 }),
  };
}

function normalizePositiveInt(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    fail(400, 'SALES_PAGE_INVALID', '페이지 범위가 올바르지 않습니다.');
  }
  return parsed;
}

function registerPeakosSalesLeadRoutes({
  app,
  pool,
  readMiddlewares = [],
  writeMiddlewares = [],
  encryptionSecret,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('app이 필요합니다.');
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool.query/pool.connect가 필요합니다.');
  }
  const piiCrypto = createSalesPiiCrypto(encryptionSecret);

  app.get(`${SALES_BASE_PATH}/owners`, ...readMiddlewares, async (req, res) => {
    try {
      const context = createSalesLeadContext(req);
      if (context.preview) {
        return res.json({ readOnly: true, owners: [] });
      }
      const owners = await listEligibleWorkspaceOwners(pool, context);
      return res.json({ readOnly: context.readOnly, owners });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(`${SALES_BASE_PATH}/summary`, ...readMiddlewares, async (req, res) => {
    try {
      const context = createSalesLeadContext(req);
      if (context.preview) {
        return res.json({ readOnly: true, piiAccess: 'masked', total: 0, statuses: {}, followUps: { overdue: 0, today: 0 } });
      }
      const result = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'new')::int AS new_count,
                COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted_count,
                COUNT(*) FILTER (WHERE status = 'follow_up')::int AS follow_up_count,
                COUNT(*) FILTER (WHERE status = 'won')::int AS won_count,
                COUNT(*) FILTER (WHERE status = 'lost')::int AS lost_count,
                COUNT(*) FILTER (WHERE status = 'do_not_call')::int AS do_not_call_count,
                COUNT(*) FILTER (
                  WHERE next_followup_at < date_trunc('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
                )::int AS overdue_count,
                COUNT(*) FILTER (
                  WHERE (next_followup_at AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date
                )::int AS today_count
           FROM peakos_sales_leads
          WHERE workspace_id = $1 AND archived_at IS NULL
            AND ($2::boolean OR owner_uid = $3)`,
        [context.workspaceId, context.scope === 'workspace', context.uid],
      );
      const row = result.rows[0] || {};
      return res.json({
        readOnly: context.readOnly,
        piiAccess: context.isOversight ? 'masked' : 'full',
        total: Number(row.total || 0),
        statuses: {
          new: Number(row.new_count || 0), contacted: Number(row.contacted_count || 0),
          follow_up: Number(row.follow_up_count || 0), won: Number(row.won_count || 0),
          lost: Number(row.lost_count || 0), do_not_call: Number(row.do_not_call_count || 0),
        },
        followUps: { overdue: Number(row.overdue_count || 0), today: Number(row.today_count || 0) },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(SALES_BASE_PATH, ...readMiddlewares, async (req, res) => {
    try {
      const context = createSalesLeadContext(req);
      if (context.preview) {
        return res.json({ readOnly: true, preview: true, piiAccess: 'masked', leads: [], total: 0, limit: 50, offset: 0 });
      }
      const status = req.query.status
        ? normalizeEnum(req.query.status, SALES_LEAD_STATUSES, '영업 상태') : null;
      const ownerUid = req.query.ownerUid ? normalizeUid(req.query.ownerUid, '영업 담당자') : null;
      if (context.scope === 'own' && ownerUid && ownerUid !== context.uid) {
        fail(403, 'SALES_OWNER_FORBIDDEN', '일반 구성원은 자신의 리드만 볼 수 있습니다.');
      }
      const includeArchived = /^(?:1|true|yes)$/i.test(String(req.query.includeArchived || ''));
      const search = req.query.q === undefined
        ? null : normalizeText(String(req.query.q), { field: '검색어', required: false, max: 160 }) || null;
      // Collection search is deliberately company-name-only for every role.
      // Full phone numbers must never be placed in a URL query because reverse
      // proxies and access-log/APM systems commonly retain request URLs.
      const limit = normalizePositiveInt(req.query.limit, 50, 100) || 50;
      const offset = normalizePositiveInt(req.query.offset, 0, 100000);
      const result = await pool.query(
        `SELECT lead.*, COUNT(*) OVER()::int AS total_count
           FROM peakos_sales_leads lead
          WHERE lead.workspace_id = $1
            AND ($2::boolean OR lead.owner_uid = $3)
            AND ($4::boolean OR lead.archived_at IS NULL)
            AND ($5::text IS NULL OR lead.status = $5)
            AND ($6::text IS NULL OR lead.owner_uid = $6)
            AND ($7::text IS NULL OR lead.company_name ILIKE '%' || $7 || '%')
          ORDER BY lead.archived_at NULLS FIRST,
                   lead.next_followup_at ASC NULLS LAST,
                   lead.updated_at DESC, lead.id
          LIMIT $8 OFFSET $9`,
        [
          context.workspaceId, context.scope === 'workspace', context.uid, includeArchived,
          status, ownerUid, search, limit, offset,
        ],
      );
      return res.json({
        readOnly: context.readOnly,
        // Collection reads intentionally use the last-four projection instead
        // of decrypting every row. Direct users get full PII only from the
        // owner-scoped detail endpoint; oversight remains masked everywhere.
        piiAccess: 'masked',
        detailPiiAccess: context.isOversight ? 'masked' : 'full',
        leads: result.rows.map(row => mapLead(row, context, piiCrypto, { maskPii: true })),
        total: Number(result.rows[0]?.total_count || 0),
        limit,
        offset,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(SALES_BASE_PATH, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createSalesLeadContext(req);
      assertSalesWrite(context);
      normalizeStrictObject(req.body, [
        'companyName', 'contactName', 'phone', 'address', 'memo', 'channel',
        'source', 'status', 'nextFollowupAt', 'ownerUid',
      ], '영업 리드');
      const companyName = normalizeText(req.body.companyName, { field: '업체명', max: 240 });
      const contact = normalizedContact(req.body);
      const channel = normalizeEnum(req.body.channel, SALES_LEAD_CHANNELS, '상담 유형', { defaultValue: 'phone' });
      const source = normalizeEnum(req.body.source, SALES_LEAD_SOURCES, '유입 경로', { defaultValue: 'manual' });
      const status = normalizeEnum(req.body.status, SALES_LEAD_STATUSES, '영업 상태', { defaultValue: 'new' });
      const nextFollowupAt = normalizeTimestamp(req.body.nextFollowupAt, { field: '후속 연락일' });
      const id = crypto.randomUUID();
      const encrypted = piiCrypto.encryptContact(contact, { workspaceId: context.workspaceId, leadId: id });
      const fingerprint = piiCrypto.phoneFingerprint(contact.phone, context.workspaceId);

      client = await pool.connect();
      await client.query('BEGIN');
      const owner = await resolveWorkspaceOwner(client, context, req.body.ownerUid);
      const inserted = await client.query(
        `INSERT INTO peakos_sales_leads
           (workspace_id, id, owner_uid, owner_name_snapshot, company_name,
            contact_ciphertext, contact_nonce, contact_auth_tag, contact_encryption_version,
            phone_fingerprint, phone_last4, channel, source, status, next_followup_at,
            created_by_uid, created_by_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          context.workspaceId, id, owner.uid, owner.name, companyName,
          encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.encryptionVersion,
          fingerprint, contact.phone.slice(-4), channel, source, status, nextFollowupAt || null,
          context.uid, context.name,
        ],
      );
      const row = inserted.rows[0];
      await recordHistory(client, context, id, 'created', 1, {}, safeLeadState(row));
      await client.query('COMMIT');
      return res.status(201).json({ lead: mapLead(row, context, piiCrypto) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.get(`${SALES_BASE_PATH}/:id`, ...readMiddlewares, async (req, res) => {
    try {
      const context = createSalesLeadContext(req);
      if (context.preview) fail(403, 'SALES_PREVIEW_DATA_HIDDEN', '계정 미리보기에서는 영업 리드 상세를 볼 수 없습니다.');
      const id = normalizeUuid(req.params.id, '영업 리드 ID');
      const lead = await loadLead(pool, context, id);
      const calls = await pool.query(
        `SELECT * FROM peakos_sales_call_logs
          WHERE workspace_id = $1 AND lead_id = $2
          ORDER BY occurred_at DESC, id DESC
          LIMIT 200`,
        [context.workspaceId, id],
      );
      return res.json({
        readOnly: context.readOnly,
        piiAccess: context.isOversight ? 'masked' : 'full',
        lead: mapLead(lead, context, piiCrypto),
        calls: calls.rows.map(row => mapCall(row, context, piiCrypto)),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.patch(`${SALES_BASE_PATH}/:id`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createSalesLeadContext(req);
      assertSalesWrite(context);
      const id = normalizeUuid(req.params.id, '영업 리드 ID');
      normalizeStrictObject(req.body, [
        'companyName', 'contactName', 'phone', 'address', 'memo', 'channel', 'source',
        'status', 'nextFollowupAt', 'ownerUid', 'expectedVersion',
      ], '영업 리드 수정');
      const expectedVersion = normalizeExpectedVersion(req.body.expectedVersion);
      if (Object.keys(req.body).length === 1) fail(400, 'SALES_BODY_EMPTY', '변경할 영업 리드 내용을 입력해 주세요.');

      client = await pool.connect();
      await client.query('BEGIN');
      const current = await loadLead(client, context, id, { lock: true });
      assertMutableLead(current, expectedVersion);
      const existingContact = piiCrypto.decryptContact(current);
      const contact = normalizedContact(req.body, existingContact);
      const owner = req.body.ownerUid === undefined
        ? { uid: current.owner_uid, name: current.owner_name_snapshot }
        : await resolveWorkspaceOwner(client, context, req.body.ownerUid);
      const encrypted = piiCrypto.encryptContact(contact, { workspaceId: context.workspaceId, leadId: id });
      const companyName = req.body.companyName === undefined
        ? current.company_name : normalizeText(req.body.companyName, { field: '업체명', max: 240 });
      const channel = req.body.channel === undefined
        ? current.channel : normalizeEnum(req.body.channel, SALES_LEAD_CHANNELS, '상담 유형');
      const source = req.body.source === undefined
        ? current.source : normalizeEnum(req.body.source, SALES_LEAD_SOURCES, '유입 경로');
      const status = req.body.status === undefined
        ? current.status : normalizeEnum(req.body.status, SALES_LEAD_STATUSES, '영업 상태');
      const nextFollowupAt = req.body.nextFollowupAt === undefined
        ? current.next_followup_at : normalizeTimestamp(req.body.nextFollowupAt, { field: '후속 연락일' });
      const updated = await client.query(
        `UPDATE peakos_sales_leads
            SET owner_uid = $3, owner_name_snapshot = $4, company_name = $5,
                contact_ciphertext = $6, contact_nonce = $7, contact_auth_tag = $8,
                contact_encryption_version = $9, phone_fingerprint = $10, phone_last4 = $11,
                channel = $12, source = $13, status = $14, next_followup_at = $15,
                version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND version = $16
          RETURNING *`,
        [
          context.workspaceId, id, owner.uid, owner.name, companyName,
          encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.encryptionVersion,
          piiCrypto.phoneFingerprint(contact.phone, context.workspaceId), contact.phone.slice(-4),
          channel, source, status, nextFollowupAt, expectedVersion,
        ],
      );
      if (!updated.rows[0]) fail(409, 'SALES_VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.');
      await recordHistory(
        client, context, id, 'updated', expectedVersion + 1,
        safeLeadState(current), safeLeadState(updated.rows[0]),
      );
      await client.query('COMMIT');
      return res.json({ lead: mapLead(updated.rows[0], context, piiCrypto) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.post(`${SALES_BASE_PATH}/:id/calls`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createSalesLeadContext(req);
      assertSalesWrite(context);
      const leadId = normalizeUuid(req.params.id, '영업 리드 ID');
      normalizeStrictObject(req.body, [
        'disposition', 'occurredAt', 'durationSeconds', 'note', 'nextFollowupAt',
        'leadStatus', 'expectedVersion',
      ], '통화 기록');
      const expectedVersion = normalizeExpectedVersion(req.body.expectedVersion);
      const disposition = normalizeEnum(req.body.disposition, SALES_CALL_DISPOSITIONS, '통화 결과');
      const occurredAt = req.body.occurredAt === undefined
        ? new Date().toISOString()
        : normalizeTimestamp(req.body.occurredAt, { field: '통화 일시', required: true, allowNull: false });
      // A call log records an interaction that already happened. Keep a small
      // clock-skew allowance, but use nextFollowupAt for every future action.
      if (Date.parse(occurredAt) > Date.now() + (5 * 60 * 1000)) {
        fail(400, 'SALES_CALL_TIME_FUTURE', '통화 일시는 현재보다 미래일 수 없습니다.');
      }
      const durationSeconds = normalizeDuration(req.body.durationSeconds);
      const note = normalizeText(req.body.note, { field: '통화 메모', required: false, max: 20000 });
      const nextFollowupAt = normalizeTimestamp(req.body.nextFollowupAt, { field: '후속 연락일' });
      const leadStatus = req.body.leadStatus === undefined
        ? undefined : normalizeEnum(req.body.leadStatus, SALES_LEAD_STATUSES, '영업 상태');
      const callId = crypto.randomUUID();
      const encryptedNote = piiCrypto.encryptCallNote(note, {
        workspaceId: context.workspaceId, leadId, callId,
      });

      client = await pool.connect();
      await client.query('BEGIN');
      const current = await loadLead(client, context, leadId, { lock: true });
      assertMutableLead(current, expectedVersion);
      const insertedCall = await client.query(
        `INSERT INTO peakos_sales_call_logs
           (workspace_id, id, lead_id, actor_uid, actor_name_snapshot, disposition,
            occurred_at, duration_seconds, note_ciphertext, note_nonce, note_auth_tag,
            note_encryption_version, next_followup_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          context.workspaceId, callId, leadId, context.uid, context.name, disposition,
          occurredAt, durationSeconds, encryptedNote.ciphertext, encryptedNote.nonce,
          encryptedNote.authTag, encryptedNote.encryptionVersion, nextFollowupAt || null,
        ],
      );
      const updated = await client.query(
        `UPDATE peakos_sales_leads
            SET status = COALESCE($3, status),
                next_followup_at = CASE WHEN $4::boolean THEN $5 ELSE next_followup_at END,
                last_contact_at = CASE
                  WHEN last_contact_at IS NULL OR $6::timestamptz > last_contact_at
                    THEN $6::timestamptz
                  ELSE last_contact_at
                END,
                version = version + 1,
                updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND version = $7
          RETURNING *`,
        [
          context.workspaceId, leadId, leadStatus || null,
          req.body.nextFollowupAt !== undefined, nextFollowupAt, occurredAt, expectedVersion,
        ],
      );
      if (!updated.rows[0]) fail(409, 'SALES_VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.');
      await recordHistory(
        client, context, leadId, 'call_logged', expectedVersion + 1,
        safeLeadState(current), safeLeadState(updated.rows[0]),
      );
      await client.query('COMMIT');
      return res.status(201).json({
        lead: mapLead(updated.rows[0], context, piiCrypto),
        call: mapCall(insertedCall.rows[0], context, piiCrypto),
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  app.post(`${SALES_BASE_PATH}/:id/archive`, ...writeMiddlewares, async (req, res) => {
    let client;
    try {
      const context = createSalesLeadContext(req);
      assertSalesWrite(context);
      const id = normalizeUuid(req.params.id, '영업 리드 ID');
      normalizeStrictObject(req.body, ['expectedVersion'], '영업 리드 보관');
      const expectedVersion = normalizeExpectedVersion(req.body.expectedVersion);
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await loadLead(client, context, id, { lock: true });
      assertMutableLead(current, expectedVersion);
      const updated = await client.query(
        `UPDATE peakos_sales_leads
            SET archived_at = NOW(), archived_by_uid = $3, archived_by_name_snapshot = $4,
                version = version + 1, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND version = $5
          RETURNING *`,
        [context.workspaceId, id, context.uid, context.name, expectedVersion],
      );
      if (!updated.rows[0]) fail(409, 'SALES_VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.');
      await recordHistory(
        client, context, id, 'archived', expectedVersion + 1,
        safeLeadState(current), safeLeadState(updated.rows[0]),
      );
      await client.query('COMMIT');
      return res.json({ archived: true, lead: mapLead(updated.rows[0], context, piiCrypto) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return sendError(res, error);
    } finally {
      client?.release();
    }
  });

  return Object.freeze({ piiCrypto });
}

module.exports = {
  SALES_BASE_PATH,
  listEligibleWorkspaceOwners,
  loadLead,
  mapCall,
  mapLead,
  maskedPhone,
  recordHistory,
  registerPeakosSalesLeadRoutes,
  resolveWorkspaceOwner,
  safeLeadState,
  sendError,
};
