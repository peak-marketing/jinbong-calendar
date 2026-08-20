process.env.TZ = 'Asia/Seoul';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  ensurePeakosBankInfrastructure,
  registerPeakosBanking,
} = require('./banking/peakos-banking');
const { ensurePeakosCoreInfrastructure } = require('./banking/peakos-core');
const {
  ensurePeakosBankReconciliationInfrastructure,
  reconcileAccountTransactions,
} = require('./banking/peakos-bank-reconciliation');
const {
  ensurePeakosCreditRequestInfrastructure,
  reconcileCreditRequests,
  registerPeakosCreditRequests,
} = require('./banking/peakos-credit-requests');
const {
  ensurePeakosFinanceRequestInfrastructure,
  registerPeakosFinanceRequests,
} = require('./banking/peakos-finance-requests');
const {
  ensurePeakosTaxInvoiceEvidenceInfrastructure,
} = require('./banking/peakos-tax-invoice-evidence-infrastructure');
const {
  registerPeakosTaxInvoiceEvidenceRoutes,
} = require('./banking/peakos-tax-invoice-evidence-routes');
const {
  createIbkQuickCollector,
  IBK_ACCOUNT_IDS,
} = require('./banking/collectors/ibk-quick-collector');
const { POLICY: PEAKOS_ACCESS_POLICY, createPeakosAccess } = require('./banking/peakos-access');
const { AUTO_MATCH_MAX_AGE_DAYS } = require('./banking/peakos-auto-match-policy');
const {
  createEmailMailerFromEnv,
  ensureOsEmailAuthInfrastructure,
  registerOsEmailAuth,
} = require('./auth/peakos-os-email-auth');
const { registerPeakosCompanyDocuments } = require('./auth/peakos-company-documents');
const {
  createPeakosWorkspaceDocumentService,
} = require('./workspaces/peakos-workspace-documents');
const { ensureSettlementImportInfrastructure } = require('./imports/settlement-database');
const {
  ensurePeakosPriceCatalog,
  priceKey: peakosPriceKey,
} = require('./banking/peakos-price-catalog');
const {
  registerPeakosSettlementRoutes,
} = require('./banking/peakos-settlement-routes');
const {
  ensureSettlementCompletionInfrastructure,
} = require('./settlements/peakos-settlement-completion-infrastructure');
const {
  registerPeakosSettlementCompletionRoutes,
} = require('./settlements/peakos-settlement-completion-routes');
const {
  ensurePeakosVendorReconciliationInfrastructure,
} = require('./settlements/peakos-vendor-reconciliation-infrastructure');
const {
  registerPeakosVendorReconciliationRoutes,
} = require('./settlements/peakos-vendor-reconciliation-routes');
const {
  ensurePeakosCommissionInfrastructure,
} = require('./settlements/peakos-commission-infrastructure');
const {
  registerPeakosCommissionRoutes,
} = require('./settlements/peakos-commission-routes');
const {
  createPeakosCollaborationGateway,
  isPeakosCollaborationAuthenticated,
} = require('./collaboration/peakos-collaboration-routes');
const {
  createPeakosEventVisibilityGuard,
  ensurePeakosEventVisibilityInfrastructure,
  eventHiddenPredicate,
  isPeakosEventVisibilityRequest,
  registerPeakosEventVisibilityRoutes,
} = require('./collaboration/peakos-event-visibility');
const {
  ensurePeakosEventChecklistDirectiveInfrastructure,
  registerPeakosEventChecklistDirectiveRoutes,
} = require('./collaboration/peakos-event-checklist-directives');
const {
  internalCalendarRuleEventSql,
} = require('./collaboration/peakos-event-checklist-policy');
const {
  authorizeEventReorder,
  normalizeChatMessageId,
  normalizeEventReorderItems,
} = require('./collaboration/peakos-collaboration-policy');
const {
  ensureEventTimeRangeInfrastructure,
  resolveEventTimeRangeUpdate,
  validateEventTimeRange,
} = require('./collaboration/event-time-range');
const {
  projectTaskCreationDecision,
  projectTaskCreationReviewer,
  projectTaskPatchDecision,
  projectTaskReviewDecision,
  taskAssignmentPatchChanges,
} = require('./collaboration/project-workflow-policy');
const {
  ensurePeakosNewProjectInfrastructure,
  registerPeakosNewProjectRoutes,
} = require('./collaboration/peakos-new-project-routes');
const {
  ensurePeakosTodoInfrastructure,
} = require('./todos/peakos-todo-infrastructure');
const {
  registerPeakosTodoRoutes,
} = require('./todos/peakos-todo-routes');
const { registerPeakosDevExpenseRoutes } = require('./expenses/peakos-dev-expense-routes');
const { registerPeakosIdeaRoutes } = require('./ideas/peakos-idea-routes');
const {
  PEAK_WORKSPACE_ID,
  createPeakosWorkspaceService,
  ensurePeakosWorkspaceInfrastructure,
  registerPeakosWorkspaceRoutes,
  workspacePublicAttachmentMutation,
} = require('./workspaces/peakos-workspaces');
const {
  ensurePeakosSalesLeadInfrastructure,
} = require('./sales/peakos-sales-leads-infrastructure');
const {
  registerPeakosSalesLeadRoutes,
} = require('./sales/peakos-sales-leads-routes');
const {
  calculatePlatformMonthlyAggregateDigest,
  ensurePeakosPlatformSettlementInfrastructure,
  importPlatformMonthlyAggregateSnapshot,
  registerPeakosPlatformMonthlySettlementRoutes,
} = require('./platform/peakos-platform-monthly-settlement');
const {
  createPlatformSettlementSyncService,
} = require('./platform/peakos-platform-connectors');
const {
  createPlatformSettlementSyncRuntime,
} = require('./platform/peakos-platform-sync-runtime');
const {
  ensurePeakosAttendanceInfrastructure,
} = require('./attendance/peakos-attendance-infrastructure');
const {
  createLegacyAttendanceHandlers,
  createPeakosAttendanceService,
  registerPeakosAttendanceRoutes,
} = require('./attendance/peakos-attendance-routes');
const {
  ensurePeakosCompanyResourceInfrastructure,
} = require('./company-resources/peakos-company-resources-infrastructure');
const {
  registerPeakosCompanyResourceRoutes,
} = require('./company-resources/peakos-company-resources-routes');

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const cron = require('node-cron');
const backgroundJobsEnabled = process.env.ENABLE_BACKGROUND_JOBS !== 'false';
const pushNotificationsEnabled = process.env.ENABLE_PUSH_NOTIFICATIONS !== 'false';

function scheduleCron(...args) {
  if (!backgroundJobsEnabled) return null;
  return cron.schedule(...args);
}

async function sendFirebaseMessage(message) {
  if (!pushNotificationsEnabled) return null;
  return admin.messaging().send(message);
}

const app = express();
let peakosOsEmailAuth = null;
// Nginx is the only production proxy. Trusting only the loopback hop lets
// Express derive the real client IP without trusting a forged left-most XFF.
app.set('trust proxy', 'loopback');
app.use(cors());
// Raise JSON limit a bit so debug log batches (max 500 entries × small
// JSON args) never get rejected. Normal requests are well under this.
app.use(express.json({ limit: '512kb' }));

// ── Client-side debug log collector ──────────────────────────────
// When users browse with ?debug=1 or calendarDebug=1 in localStorage,
// the page batches dlog() entries and POSTs them here so the server
// maintainers can tail a single file to see what each user session is
// actually doing in the SPA. Safe to leave enabled — entries are only
// written when clients actively opt in.
const DEBUG_LOG_PATH = path.join(__dirname, 'debug-client.log');
const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
function appendDebugClientLog(line) {
  fs.stat(DEBUG_LOG_PATH, (err, stat) => {
    if (stat && stat.size > DEBUG_LOG_MAX_BYTES) {
      // Rotate: keep the previous file as .1 so we don't silently lose
      // history, but cap at a single rotation to stay bounded.
      try { fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + '.1'); } catch (_) {}
    }
    fs.appendFile(DEBUG_LOG_PATH, line, () => {});
  });
}
app.post('/api/_debug/client-log', async (req, res) => {
  try {
    // Auth is optional: the page enables debug before the user may even
    // be signed in. Still try to attach a uid when the bearer token is
    // present so lines are attributable.
    let uid = 'anon';
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const decoded = await verifyFirebaseToken(token);
        uid = decoded.uid;
      } catch (_) { /* keep uid=anon */ }
    }
    const { entries, session, ua, url } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) return res.json({ ok: true, skipped: true });
    const ts = new Date().toISOString();
    const header = `--- ${ts} uid=${uid} session=${session || '-'} url=${(url || '').slice(0, 200)}\n`;
    const body = entries
      .map(e => {
        const args = (e.args || []).map(a => { try { return JSON.stringify(a); } catch (_) { return String(a); } }).join(' ');
        return `  +${e.t}s  ${e.tag}  ${args}`;
      })
      .join('\n');
    appendDebugClientLog(header + body + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

function normalizeFcmData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function buildWebPushMessage(title, body, data = {}) {
  const normalizedData = normalizeFcmData(data);
  const tag = normalizedData.tag || normalizedData.roomId || normalizedData.kind || 'peakmarketing';

  return {
    notification: { title, body },
    data: { ...normalizedData, title, body },
    webpush: {
      headers: {
        Urgency: 'high',
        TTL: '2419200'
      },
      fcmOptions: {
        link: normalizedData.link || '/'
      },
      notification: {
        title,
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        renotify: true,
        requireInteraction: true,
        timestamp: Date.now(),
        actions: [
          { action: 'open', title: '열기' }
        ]
      }
    }
  };
}

function isInvalidFcmTokenError(error) {
  const code = error?.code || '';
  if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
    return true;
  }
  return code === 'messaging/invalid-argument' && /registration token/i.test(String(error?.message || ''));
}

// FCM 푸시 전송 헬퍼
async function sendPushToUser(userUid, title, body, data) {
  try {
    if (!(await isNotificationEnabled(userUid, data?.kind))) return;
    const tokens = await pool.query('SELECT token FROM fcm_tokens WHERE user_uid = $1', [userUid]);
    if (!tokens.rows.length) return;
    const message = buildWebPushMessage(title, body, data);
    for (const row of tokens.rows) {
      try {
        await sendFirebaseMessage({ ...message, token: row.token });
      } catch(e) {
        if (isInvalidFcmTokenError(e)) {
          await pool.query('DELETE FROM fcm_tokens WHERE token = $1', [row.token]);
        } else {
          console.error('FCM send token error:', e.code || e.message);
        }
      }
    }
  } catch(e) { console.error('FCM send error:', e.message); }
}

async function sendPushToAll(title, body, excludeUid, data = {}) {
  try {
    let q = `SELECT DISTINCT ft.user_uid, ft.token
             FROM fcm_tokens ft
             JOIN users u ON u.uid = ft.user_uid
             WHERE u.approved = true
               AND COALESCE(u.is_active, true) = true`;
    const params = [];
    if (excludeUid) { q += ' AND ft.user_uid != $1'; params.push(excludeUid); }
    const tokens = await pool.query(q, params);
    if (!tokens.rows.length) return;
    const message = buildWebPushMessage(title, body, data);
    for (const row of tokens.rows) {
      try {
        await sendFirebaseMessage({ ...message, token: row.token });
      } catch(e) {
        if (isInvalidFcmTokenError(e)) {
          await pool.query('DELETE FROM fcm_tokens WHERE token = $1', [row.token]);
        } else {
          console.error('FCM broadcast token error:', e.code || e.message);
        }
      }
    }
  } catch(e) { console.error('FCM broadcast error:', e.message); }
}

// 이미지 업로드 설정
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

function decodeMultipartFilename(filename) {
  const original = String(filename || '');
  if (!original) return '';
  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return original;
    const roundTrip = Buffer.from(decoded, 'utf8').toString('latin1');
    return roundTrip === original ? decoded : original;
  } catch (err) {
    return original;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const decodedName = decodeMultipartFilename(file.originalname);
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(decodedName || file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
  cb(null, allowed.test(path.extname(file.originalname)));
}});
const uploadJpgPng = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const extAllowed = /\.(jpg|jpeg|png)$/i.test(path.extname(file.originalname));
  const mimeAllowed = /^image\/(jpe?g|png)$/i.test(file.mimetype || '');
  cb(null, extAllowed && mimeAllowed);
}});
const uploadFile = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const pool = new Pool({
  user: process.env.PGUSER || 'calendar_user',
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'calendar_db',
});
const peakosAttendanceService = createPeakosAttendanceService({ pool });
const legacyAttendanceHandlers = createLegacyAttendanceHandlers({
  service: peakosAttendanceService,
  logger: console,
});
let peakosPlatformSettlementSyncRuntime = null;
const peakosWorkspaceService = createPeakosWorkspaceService({ pool });
const peakosWorkspaceDocumentService = createPeakosWorkspaceDocumentService({
  pool,
  root: process.env.PEAKOS_WORKSPACE_DOCUMENT_ROOT || undefined,
  logger: console,
});

function requestWorkspaceId(req) {
  return peakosWorkspaceService.workspaceId(req);
}

function requestPolicyPath(req) {
  const base = String(req?.baseUrl || '').split('?')[0].replace(/\/$/, '');
  const pathname = String(req?.path || '').split('?')[0] || '/';
  if (!base || pathname === base || pathname.startsWith(`${base}/`)) return pathname;
  return `${base}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}

function collaborationAreaForPath(pathname) {
  const value = String(pathname || '');
  if (/^\/api\/peakos\/todos(?:\/|$)/.test(value)) return 'calendar';
  if (/^\/api\/(?:events|event-types|todo-cats)(?:\/|$)/.test(value)) return 'calendar';
  if (/^\/api\/(?:chat|chat-rooms|chat-room-groups)(?:\/|$)/.test(value)) return 'chat';
  if (/^\/api\/(?:projects|new-projects)(?:\/|$)/.test(value) || value === '/api/users/all-approved') return 'projects';
  return null;
}

function workspacePermissionAllowsRequest(req, area) {
  const permission = req.workspace?.permissions?.[area] || 'none';
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
  if (mutation) return permission === 'write' && req.workspace?.headquartersOversight !== true;
  return permission === 'read' || permission === 'write';
}

function rejectWorkspacePublicAttachment(req, res) {
  if (req.workspace?.id === PEAK_WORKSPACE_ID || !workspacePublicAttachmentMutation(req)) return false;
  res.set('Cache-Control', 'private, no-store');
  res.vary('X-PeakOS-Workspace');
  res.vary('Authorization');
  res.status(403).json({
    code: 'WORKSPACE_PRIVATE_STORAGE_REQUIRED',
    error: '지사 첨부파일은 전용 비공개 저장소 연결 후 업로드할 수 있습니다.',
  });
  return true;
}

function isNonPeakWorkspaceSafePath(pathname) {
  const value = String(pathname || '');
  return collaborationAreaForPath(value) !== null
    || /^\/api\/peakos(?:\/|$)/.test(value)
    || /^\/api\/os-auth(?:\/|$)/.test(value)
    || /^\/api\/os\/workspaces(?:\/|$)/.test(value)
    || /^\/api\/users\/(?:me|register)(?:\/|$)/.test(value)
    || /^\/api\/fcm(?:\/|$)/.test(value)
    || /^\/api\/_debug(?:\/|$)/.test(value);
}

function normalizeReportAmountValue(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits || '0';
}

function normalizeReportEntryValue(value, isAmount) {
  if (isAmount) return normalizeReportAmountValue(value);
  return value == null ? '' : String(value);
}

async function isNotificationEnabled(userUid, kind) {
  const result = await pool.query(
    `SELECT approved, is_active, notify_chat, notify_overdue_morning, notify_today_evening
     FROM users WHERE uid = $1`,
    [userUid]
  );
  const user = result.rows[0];
  if (!user || !user.approved || user.is_active === false) return false;

  if (!kind || kind === 'notice') return true;
  if (kind === 'event-reminder') return getEventReminderPreference(userUid);

  if (kind === 'chat' || kind === 'chat-mention') return user.notify_chat !== false;
  if (kind === 'overdue-morning') return user.notify_overdue_morning !== false;
  if (kind === 'today-evening') return user.notify_today_evening !== false;
  return true;
}

const EVENT_REMINDER_CONFIG = {
  '30m': { minutes: 30, label: '30분 전' },
  '1h': { minutes: 60, label: '1시간 전' },
  '2h': { minutes: 120, label: '2시간 전' },
  '1d': { minutes: 1440, label: '하루 전' }
};
const EVENT_REMINDER_LOOKBACK_MS = 5 * 60 * 1000;
let lastEventReminderSweepAt = null;
let hasEventReminderPrefsTable = false;
let hasEventReminderDeliveryTable = false;

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftLocalDate(baseDate, days) {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + days);
  return next;
}

function getEventReminderConfig(value) {
  return EVENT_REMINDER_CONFIG[value] || null;
}

function normalizeEventTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length === 5 ? `${text}:00` : text;
}

function getEventStartAt(date, time) {
  if (!date || !time) return null;
  const startAt = new Date(`${date}T${normalizeEventTime(time)}+09:00`);
  return Number.isNaN(startAt.getTime()) ? null : startAt;
}

function formatEventReminderDateTime(date) {
  return date.toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildEventReminderBody(event, config, startAt) {
  const suffix = event.type === 'todo'
    ? '할 일 확인 시간입니다.'
    : event.type === 'meeting'
      ? '미팅이 시작됩니다.'
      : '일정이 시작됩니다.';
  return `${config.label} 알림입니다. ${suffix} ${formatEventReminderDateTime(startAt)}`;
}

async function getEventReminderPreference(userUid) {
  if (!hasEventReminderPrefsTable) return true;
  try {
    const result = await pool.query('SELECT enabled FROM user_event_reminder_prefs WHERE user_uid = $1', [userUid]);
    return result.rows[0]?.enabled !== false;
  } catch (err) {
    console.error('Event reminder preference load failed:', err.message);
    return true;
  }
}

async function attachEventReminderPreference(user) {
  if (!user) return user;
  return {
    ...user,
    notify_event_reminder: await getEventReminderPreference(user.uid)
  };
}

async function ensureReminderInfrastructure() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_event_reminder_prefs (
        user_uid TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    hasEventReminderPrefsTable = true;
  } catch (err) {
    console.error('Event reminder prefs table unavailable:', err.message);
  }

  try {
    // events.id is TEXT (UUID string) throughout the schema, but this
    // table was originally declared with INTEGER, causing every
    // per-minute cron sweep to blow up with "invalid input syntax for
    // type integer" once an event reminder came due. Existing prod
    // DB has already been ALTER'd; the TEXT definition below is for
    // fresh deployments.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_reminder_deliveries (
        id SERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        user_uid TEXT NOT NULL,
        reminder_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_id, user_uid, reminder_at)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_event_reminder_deliveries_lookup ON event_reminder_deliveries (event_id, user_uid, reminder_at)');
    hasEventReminderDeliveryTable = true;
  } catch (err) {
    console.error('Event reminder delivery table unavailable:', err.message);
  }
}

async function ensureChatPerformanceIndexes() {
  // The chat/chat_room_members/chat_read_status tables are owned by
  // the superuser, not by the app role, so this CREATE INDEX runs on
  // every boot only to fail with "must be owner of table chat". The
  // indexes now exist (applied manually by a DBA) so we first check
  // pg_indexes and skip the DDL entirely if they're already there.
  // Only fall through to the CREATE when something is actually
  // missing, and then only log if that too fails.
  const required = [
    { name: 'idx_chat_room_created_desc', ddl: 'CREATE INDEX idx_chat_room_created_desc ON chat (room_id, created_at DESC, id DESC)' },
    { name: 'idx_chat_room_members_user_room', ddl: 'CREATE INDEX idx_chat_room_members_user_room ON chat_room_members (user_id, room_id)' },
    { name: 'idx_chat_read_status_user_room', ddl: 'CREATE INDEX idx_chat_read_status_user_room ON chat_read_status (user_id, room_id, last_read_at)' },
  ];
  let existing = new Set();
  try {
    const r = await pool.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])',
      [required.map(i => i.name)]
    );
    existing = new Set(r.rows.map(row => row.indexname));
  } catch (err) {
    console.error('Chat performance index probe failed:', err.message);
    return;
  }
  for (const idx of required) {
    if (existing.has(idx.name)) continue;
    try {
      await pool.query(idx.ddl);
    } catch (err) {
      console.error(`Chat performance index ${idx.name} could not be created (needs DBA):`, err.message);
    }
  }
}

async function ensureChatRoomGroupInfrastructure() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_room_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#007AFF',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        deleted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_room_group_links (
        room_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES chat_room_groups(id) ON DELETE CASCADE,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_room_groups_alive ON chat_room_groups (deleted, sort_order, created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_room_group_links_group ON chat_room_group_links (group_id)');
  } catch (err) {
    console.error('Chat room group infrastructure unavailable:', err.message);
  }
}

async function ensureServiceRequestInfrastructure() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_requests (
        id TEXT PRIMARY KEY,
        product_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'requested',
        priority TEXT NOT NULL DEFAULT 'normal',
        requester_uid TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        requester_photo TEXT DEFAULT '',
        assignee_uid TEXT,
        assignee_name TEXT,
        manager_note TEXT DEFAULT '',
        deleted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_request_managers (
        user_uid TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
	    `);
    await pool.query("ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb");
    await pool.query('CREATE INDEX IF NOT EXISTS idx_service_requests_status_created ON service_requests (status, created_at DESC) WHERE deleted = false');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_service_requests_requester ON service_requests (requester_uid, created_at DESC) WHERE deleted = false');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_service_requests_assignee ON service_requests (assignee_uid, created_at DESC) WHERE deleted = false');
  } catch (err) {
    console.error('Service request infrastructure unavailable:', err.message);
  }
}

async function ensureIdeaInfrastructure() {
  try {
    const existing = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ideas' AND column_name = 'attachments'`
    );
    if (!existing.rows.length) {
      await pool.query("ALTER TABLE ideas ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb");
    }
  } catch (err) {
    console.error('Idea infrastructure unavailable:', err.message);
  }
}

async function ensureExternalCalendarInfrastructure() {
  try {
    const existing = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'external_calendar_only'`
    );
    if (!existing.rows.length) {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS external_calendar_only BOOLEAN NOT NULL DEFAULT false");
    }
  } catch (err) {
    console.error('External calendar infrastructure unavailable:', err.message);
  }
}

async function ensureProjectInfrastructure() {
  try {
    const coreTables = await pool.query(
      "SELECT to_regclass('public.projects') AS projects, to_regclass('public.project_members') AS project_members"
    );
    if (!coreTables.rows[0]?.projects) {
      await pool.query(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          owner_id TEXT NOT NULL,
          chat_room_id TEXT,
          status TEXT DEFAULT 'active',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    }
    if (!coreTables.rows[0]?.project_members) {
      await pool.query(`
        CREATE TABLE project_members (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_details (
        project_id TEXT PRIMARY KEY,
        owner_name TEXT NOT NULL DEFAULT '',
        deadline TEXT NOT NULL DEFAULT '',
        deleted BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        assignee_uid TEXT,
        assignee_name TEXT,
        assignment_mode TEXT NOT NULL DEFAULT 'single',
        status TEXT NOT NULL DEFAULT 'todo',
        due_date TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE project_tasks
      ADD COLUMN IF NOT EXISTS assignment_mode TEXT NOT NULL DEFAULT 'single'
    `);
    await pool.query(`
      ALTER TABLE project_tasks
      ADD COLUMN IF NOT EXISTS role_label TEXT NOT NULL DEFAULT ''
    `);
    await pool.query(`
      ALTER TABLE project_tasks
        ADD COLUMN IF NOT EXISTS assigned_by_uid TEXT,
        ADD COLUMN IF NOT EXISTS assigned_by_name TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS reviewer_uid TEXT,
        ADD COLUMN IF NOT EXISTS reviewer_name TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1
    `);
    await pool.query(`
      UPDATE project_tasks pt
      SET assigned_by_uid = COALESCE(pt.assigned_by_uid, pt.created_by, p.owner_id),
          assigned_by_name = CASE
            WHEN pt.assigned_by_name <> '' THEN pt.assigned_by_name
            ELSE COALESCE((SELECT name FROM users WHERE uid = COALESCE(pt.created_by, p.owner_id)), '')
          END,
          reviewer_uid = COALESCE(pt.reviewer_uid, p.owner_id),
          reviewer_name = CASE
            WHEN pt.reviewer_name <> '' THEN pt.reviewer_name
            ELSE COALESCE((SELECT name FROM users WHERE uid = p.owner_id), '')
          END,
          review_requested_at = CASE
            WHEN pt.status = 'review' THEN COALESCE(pt.review_requested_at, pt.updated_at)
            ELSE pt.review_requested_at
          END,
          reviewed_at = CASE
            WHEN pt.status = 'done' THEN COALESCE(pt.reviewed_at, pt.updated_at)
            ELSE pt.reviewed_at
          END
      FROM projects p
      WHERE p.id = pt.project_id
        AND (
          pt.assigned_by_uid IS NULL
          OR pt.assigned_by_name = ''
          OR pt.reviewer_uid IS NULL
          OR pt.reviewer_name = ''
          OR (pt.status = 'review' AND pt.review_requested_at IS NULL)
          OR (pt.status = 'done' AND pt.reviewed_at IS NULL)
        )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_task_workflow_events (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_uid TEXT NOT NULL,
        actor_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        from_status TEXT NOT NULL DEFAULT '',
        to_status TEXT NOT NULL DEFAULT '',
        due_date_snapshot TEXT NOT NULL DEFAULT '',
        workflow_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_task_assignees (
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_uid TEXT NOT NULL,
        user_name TEXT NOT NULL DEFAULT '',
        completed BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMPTZ,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (task_id, user_uid)
      )
    `);
    await pool.query(`
      INSERT INTO project_task_assignees
        (task_id, project_id, user_uid, user_name, completed, completed_at)
      SELECT
        id,
        project_id,
        assignee_uid,
        COALESCE(assignee_name, ''),
        status = 'done',
        CASE WHEN status = 'done' THEN updated_at ELSE NULL END
      FROM project_tasks
      WHERE assignee_uid IS NOT NULL
      ON CONFLICT (task_id, user_uid) DO UPDATE
      SET user_name = EXCLUDED.user_name
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_updates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status_snapshot TEXT NOT NULL DEFAULT '',
        author_uid TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_photo TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        author_uid TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_photo TEXT DEFAULT '',
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        deleted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_task_comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        author_uid TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_photo TEXT DEFAULT '',
        deleted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_project_details_alive_updated ON project_details (deleted, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id, sort_order, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_project_task_assignees_project ON project_task_assignees (project_id, task_id)',
      'CREATE INDEX IF NOT EXISTS idx_project_updates_project ON project_updates (project_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_project_comments_project ON project_comments (project_id, created_at DESC) WHERE deleted = false',
      'CREATE INDEX IF NOT EXISTS idx_project_task_comments_task ON project_task_comments (project_id, task_id, created_at) WHERE deleted = false',
      'CREATE INDEX IF NOT EXISTS idx_project_task_workflow_events_task ON project_task_workflow_events (project_id, task_id, created_at DESC)'
    ];
    for (const ddl of indexes) {
      try {
        await pool.query(ddl);
      } catch (err) {
        console.error('Project index unavailable:', err.message);
      }
    }
  } catch (err) {
    console.error('Project infrastructure unavailable:', err.message);
  }
}

async function canManageServiceRequests(req) {
  if (req.userDoc?.role === 'admin') return true;
  const result = await pool.query('SELECT 1 FROM service_request_managers WHERE user_uid = $1', [req.uid]);
  return !!result.rows[0];
}

function normalizeServiceRequestStatus(value) {
  return ['requested', 'reviewing', 'working', 'done', 'rejected'].includes(value) ? value : null;
}

function normalizeServiceRequestPriority(value) {
  return ['low', 'normal', 'high', 'urgent'].includes(value) ? value : 'normal';
}

function normalizeProjectStatus(value) {
  return ['planning', 'active', 'review', 'done', 'hold', 'archived'].includes(value) ? value : 'active';
}

function normalizeProjectTaskStatus(value) {
  return ['todo', 'doing', 'review', 'done', 'hold'].includes(value) ? value : 'todo';
}

function projectTaskStatusLabel(value) {
  return {
    todo: '대기',
    doing: '진행중',
    review: '검토요청',
    done: '완료',
    hold: '보류'
  }[value] || '상태 변경';
}

function isProjectDateKey(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

async function recordProjectTaskWorkflowEvent(db, {
  projectId,
  taskId,
  action,
  actorUid,
  actorName,
  note = '',
  fromStatus = '',
  toStatus = '',
  dueDate = '',
  workflowVersion,
}) {
  await db.query(
    `INSERT INTO project_task_workflow_events
     (project_id, task_id, action, actor_uid, actor_name, note, from_status, to_status, due_date_snapshot, workflow_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      projectId,
      taskId,
      action,
      actorUid,
      String(actorName || '').slice(0, 160),
      String(note || '').slice(0, 5000),
      fromStatus,
      toStatus,
      dueDate,
      workflowVersion,
    ]
  );
}

async function touchProjectWithDb(db, projectId) {
  await db.query(
    `INSERT INTO project_details (project_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (project_id) DO UPDATE SET updated_at = NOW()`,
    [projectId]
  );
}

async function canAccessProject(req, projectId) {
  if (!projectId || !req.userDoc?.approved || !req.workspace) return false;
  const canSeeAllInWorkspace = req.userDoc.role === 'admin' || req.workspace.headquartersOversight === true;
  const result = await pool.query(
    `SELECT 1 FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       AND ($5::boolean OR p.owner_id = $2 OR EXISTS (
         SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2
       ))`,
    [projectId, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID, canSeeAllInWorkspace]
  );
  return !!result.rows[0];
}

async function canManageProject(req, projectId) {
  if (!projectId || !req.userDoc?.approved || !req.workspace || req.workspace.headquartersOversight) return false;
  const result = await pool.query(
    `SELECT 1 FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       AND ($5::boolean OR p.owner_id = $2)`,
    [projectId, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID, req.userDoc.role === 'admin']
  );
  return !!result.rows[0];
}

async function canDirectProjectTasks(req, projectId) {
  if (!projectId || !req.userDoc?.approved || !req.workspace || req.workspace.headquartersOversight) return false;
  const isAdmin = req.userDoc.role === 'admin';
  const isWorkspaceManager = req.userDoc.role === 'manager';
  const result = await pool.query(
    `SELECT 1 FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       AND (
         $5::boolean
         OR p.owner_id = $2
         OR ($6::boolean AND EXISTS (
           SELECT 1
           FROM project_members pm
           JOIN peakos_workspace_memberships pwm
             ON pwm.user_uid = pm.user_id
            AND pwm.workspace_id = COALESCE(p.workspace_id, $4)
            AND pwm.active = TRUE
            AND pwm.role <> 'oversight'
           WHERE pm.project_id = p.id AND pm.user_id = $2
         ))
       )`,
    [projectId, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID, isAdmin, isWorkspaceManager]
  );
  return !!result.rows[0];
}

function canReviewProjectTask(req, task) {
  if (!task || !req.userDoc?.approved || !req.workspace || req.workspace.headquartersOversight) return false;
  return req.userDoc.role === 'admin'
    || String(task.owner_id || task.project_owner_uid || '') === String(req.uid || '')
    || String(task.reviewer_uid || '') === String(req.uid || '');
}

async function resolveProjectTaskAssignees(db, projectId, assignmentMode, assigneeUid = '') {
  if (assignmentMode === 'all') {
    const members = await db.query(
      `SELECT u.uid, u.name
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN users u ON u.uid = pm.user_id
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = pm.user_id
        AND pwm.workspace_id = COALESCE(p.workspace_id, $2)
        AND pwm.active = TRUE
        AND pwm.role <> 'oversight'
       WHERE pm.project_id = $1
         AND u.approved = true
         AND COALESCE(u.is_active, true) = true
       ORDER BY u.name`,
      [projectId, PEAK_WORKSPACE_ID]
    );
    return members.rows;
  }
  if (!assigneeUid) return [];
  const member = await db.query(
    `SELECT u.uid, u.name
     FROM project_members pm
     JOIN projects p ON p.id = pm.project_id
     JOIN users u ON u.uid = pm.user_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = pm.user_id
      AND pwm.workspace_id = COALESCE(p.workspace_id, $3)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE pm.project_id = $1 AND pm.user_id = $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [projectId, assigneeUid, PEAK_WORKSPACE_ID]
  );
  if (!member.rows[0]) {
    throw Object.assign(new Error('담당자는 프로젝트 멤버여야 합니다'), { statusCode: 400 });
  }
  return member.rows;
}

async function syncProjectTaskAssignees(db, projectId, taskId, assignees) {
  const userIds = assignees.map(assignee => assignee.uid);
  if (userIds.length) {
    await db.query(
      `DELETE FROM project_task_assignees
       WHERE project_id = $1 AND task_id = $2
         AND NOT (user_uid = ANY($3::text[]))`,
      [projectId, taskId, userIds]
    );
  } else {
    await db.query(
      'DELETE FROM project_task_assignees WHERE project_id = $1 AND task_id = $2',
      [projectId, taskId]
    );
  }
  for (const assignee of assignees) {
    await db.query(
      `INSERT INTO project_task_assignees
       (task_id, project_id, user_uid, user_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (task_id, user_uid) DO UPDATE
       SET user_name = EXCLUDED.user_name`,
      [taskId, projectId, assignee.uid, assignee.name || '사용자']
    );
  }
}

async function touchProject(projectId) {
  if (!projectId) return;
  await pool.query(
    `INSERT INTO project_details (project_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (project_id) DO UPDATE SET updated_at = NOW()`,
    [projectId]
  );
}

async function createProjectMeetingEvent(projectId, req, meeting = {}) {
  const title = String(meeting.title || '').trim().slice(0, 180);
  const date = String(meeting.date || '').trim().slice(0, 10);
  const time = String(meeting.time || '').trim().slice(0, 8);
  const memo = String(meeting.memo || '').trim().slice(0, 5000);
  const endDate = String(meeting.endDate || meeting.end_date || '').trim().slice(0, 10);
  if (!title) throw Object.assign(new Error('회의명을 입력하세요'), { statusCode: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('회의 날짜를 선택하세요'), { statusCode: 400 });

  const project = await pool.query(
    `SELECT p.name
     FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.workspace_id = $2 OR (p.workspace_id IS NULL AND $2 = $3))`,
    [projectId, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  if (!project.rows[0]) throw Object.assign(new Error('Project not found'), { statusCode: 404 });

  const event = await pool.query(
    `INSERT INTO events (workspace_id, type, title, date, time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date, sort_order, project_id)
     VALUES ($1,'meeting',$2,$3,$4,'',$5,NULL,NULL,'team',$6,$7,NULL,NULL,$8,0,$9)
     RETURNING *`,
    [requestWorkspaceId(req), title, date, time || '', memo || `${project.rows[0].name} 프로젝트 회의`, req.uid, req.userName, endDate || null, projectId]
  );

  const members = await pool.query(
    `SELECT pm.user_id
     FROM project_members pm
     JOIN projects workspace_project ON workspace_project.id = pm.project_id
     JOIN users u ON u.uid = pm.user_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = pm.user_id
      AND pwm.workspace_id = COALESCE(workspace_project.workspace_id, $2)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE pm.project_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [projectId, PEAK_WORKSPACE_ID]
  );
  for (const member of members.rows) {
    if (!member.user_id || member.user_id === req.uid) continue;
    await pool.query(
      'INSERT INTO event_shares (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [event.rows[0].id, member.user_id]
    );
  }
  await touchProject(projectId);
  await notifyProjectMembers(
    projectId,
    req.uid,
    '프로젝트 회의일정',
    `${project.rows[0].name} · ${title} (${date}${time ? ' ' + time : ''})`,
    { eventId: event.rows[0].id, link: `/?page=calendar&tab=month&date=${date}&eventId=${event.rows[0].id}` }
  );
  return event.rows[0];
}

async function notifyProjectMembers(projectId, actorUid, title, body, data = {}) {
  try {
    const requestedTargets = Array.isArray(data.targetUids)
      ? [...new Set(data.targetUids.map(uid => String(uid || '').trim()).filter(Boolean))]
      : null;
    const { targetUids: _targetUids, ...pushData } = data;
    const targets = await pool.query(
      `SELECT DISTINCT target.uid
       FROM (
         SELECT pm.user_id AS uid FROM project_members pm WHERE pm.project_id = $1
         UNION
         SELECT p.owner_id AS uid FROM projects p WHERE p.id = $1
       ) target
       JOIN users u ON u.uid = target.uid
       JOIN projects workspace_project ON workspace_project.id = $1
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = target.uid
        AND pwm.workspace_id = COALESCE(workspace_project.workspace_id, $3)
        AND pwm.active = TRUE
        AND pwm.role <> 'oversight'
       WHERE target.uid IS NOT NULL
         AND target.uid != $2
         AND u.approved = true
         AND u.is_active != false
         AND ($4::text[] IS NULL OR target.uid = ANY($4::text[]))`,
      [projectId, actorUid || '', PEAK_WORKSPACE_ID, requestedTargets?.length ? requestedTargets : null]
    );
    await Promise.all(targets.rows.map(row => sendPushToUser(
      row.uid,
      title,
      body,
      {
        kind: 'project',
        projectId,
        link: `/?page=project&projectId=${projectId}`,
        ...pushData
      }
    )));
  } catch (err) {
    console.error('Project notification failed:', err.message);
  }
}

async function notifyServiceRequestManagers(request, actorUid) {
  try {
    const targets = await pool.query(
      `SELECT DISTINCT uid FROM users
       WHERE approved = true
         AND is_active != false
         AND (
           role = 'admin'
           OR uid IN (SELECT user_uid FROM service_request_managers)
         )
         AND uid != $1`,
      [actorUid || '']
    );
    await Promise.all(targets.rows.map(row => sendPushToUser(
      row.uid,
      '새 개발수정요청',
      `${request.product_name || '서비스'} · ${request.title}`,
      { kind: 'service-request', requestId: request.id, link: '/?page=request' }
    )));
  } catch (err) {
    console.error('Service request manager notification failed:', err.message);
  }
}

async function notifyServiceRequestRequester(request, title, body) {
  try {
    if (!request.requester_uid) return;
    await sendPushToUser(request.requester_uid, title, body, {
      kind: 'service-request',
      requestId: request.id,
      link: '/?page=request'
    });
  } catch (err) {
    console.error('Service request requester notification failed:', err.message);
  }
}

async function processEventReminderSweep() {
  if (!hasEventReminderDeliveryTable) return 0;

  const now = new Date();
  const fallbackWindowStart = new Date(now.getTime() - EVENT_REMINDER_LOOKBACK_MS);
  const windowStart = lastEventReminderSweepAt
    ? new Date(Math.max(lastEventReminderSweepAt.getTime() - 15000, fallbackWindowStart.getTime()))
    : fallbackWindowStart;

  const rangeStart = formatLocalDate(shiftLocalDate(now, -1));
  const rangeEnd = formatLocalDate(shiftLocalDate(now, 2));
  const candidates = await pool.query(
    `SELECT id, workspace_id, title, type, date, time, reminder, owner_id, owner_name, done
     FROM events
     WHERE deleted = false
       AND COALESCE(reminder, '') <> ''
       AND COALESCE(time, '') <> ''
       AND date BETWEEN $1 AND $2`,
    [rangeStart, rangeEnd]
  );

  if (!candidates.rows.length) {
    lastEventReminderSweepAt = now;
    return 0;
  }

  const eventIds = candidates.rows.map(row => row.id);
  const shareMap = new Map();
  const shares = await pool.query(
    'SELECT event_id, user_id FROM event_shares WHERE event_id = ANY($1)',
    [eventIds]
  );
  for (const row of shares.rows) {
    const existing = shareMap.get(row.event_id) || [];
    existing.push(row.user_id);
    shareMap.set(row.event_id, existing);
  }

  let sentCount = 0;
  for (const event of candidates.rows) {
    if (event.done === true) continue;

    const config = getEventReminderConfig(event.reminder);
    if (!config) continue;

    const startAt = getEventStartAt(event.date, event.time);
    if (!startAt) continue;

    const reminderAt = new Date(startAt.getTime() - (config.minutes * 60 * 1000));
    if (reminderAt < windowStart || reminderAt > now) continue;

    const candidateRecipients = [...new Set([event.owner_id, ...(shareMap.get(event.id) || [])].filter(Boolean))];
    const eligibleRecipients = await pool.query(
      `SELECT user_uid
         FROM peakos_workspace_memberships
        WHERE workspace_id = $1
          AND user_uid = ANY($2::text[])
          AND active = TRUE
          AND role <> 'oversight'`,
      [event.workspace_id || PEAK_WORKSPACE_ID, candidateRecipients],
    );
    for (const userUid of eligibleRecipients.rows.map(row => row.user_uid)) {
      if (!userUid) continue;
      const inserted = await pool.query(
        `INSERT INTO event_reminder_deliveries (event_id, user_uid, reminder_at)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [event.id, userUid, reminderAt.toISOString()]
      );
      if (!inserted.rowCount) continue;

      await sendPushToUser(userUid, `⏰ ${event.title}`, buildEventReminderBody(event, config, startAt), {
        kind: 'event-reminder',
        link: `/?page=calendar&tab=month&date=${event.date}`,
        tag: `event-reminder-${event.id}-${event.reminder}`,
        page: 'calendar',
        tab: 'month',
        date: event.date,
        eventId: event.id
      });
      sentCount += 1;
    }
  }

  if (sentCount) console.log(`[CRON] 일정 리마인더 ${sentCount}건 전송`);
  lastEventReminderSweepAt = now;
  return sentCount;
}

// ── Firebase ID Token 검증 (Google 공개 키 사용) ─────────────
const jwksClient = jwksRsa({
  jwksUri: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  cache: true,
  cacheMaxAge: 86400000,
});

function getKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyFirebaseToken(idToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(idToken, getKey, {
      algorithms: ['RS256'],
      issuer: 'https://securetoken.google.com/peakmarketing-3f3a3',
      audience: 'peakmarketing-3f3a3',
    }, (err, decoded) => {
      if (err) return reject(err);
      resolve({
        uid: decoded.user_id || decoded.sub,
        email: decoded.email,
        name: decoded.name || decoded.email,
        picture: decoded.picture || ''
      });
    });
  });
}

// ── 인증 미들웨어 ──────────────────────────────────────────
async function authMiddleware(req, res, next) {
  // The protected collaboration gateway already verified the exact same
  // Firebase token and loaded req.userDoc before rewriting to a legacy route.
  // Do not repeat the remote-key verification and users query in that case.
  if (isPeakosCollaborationAuthenticated(req)) {
    if (rejectWorkspacePublicAttachment(req, res)) return undefined;
    return next();
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = await verifyFirebaseToken(token);
    req.uid = decoded.uid;
    req.userName = decoded.name || decoded.email;
    req.userEmail = decoded.email;
    req.userPhoto = decoded.picture || '';
    const userRes = await pool.query(
      `SELECT u.*, g.name AS group_name, g.group_type, g.show_sales_report
         FROM users u
         LEFT JOIN groups g ON g.id = u.group_id
        WHERE u.uid = $1`,
      [req.uid],
    );
    req.userDoc = userRes.rows[0] || null;
    const policyPath = requestPolicyPath(req);
    // Hard server-side enforcement of restricted account modes. The
    // client hides disallowed routes, but direct API calls must be
    // blocked here too.
    if (req.userDoc?.chat_only && !req.userDoc?.external_calendar_only && !isChatOnlyAllowedPath(policyPath)) {
      return res.status(403).json({ error: 'This account is restricted to chat' });
    }
    if (req.userDoc?.external_calendar_only && !isExternalCalendarAllowedPath(policyPath)) {
      return res.status(403).json({ error: 'This account is restricted to calendar and chat' });
    }
    // Attach the authenticated user's default direct workspace to legacy
    // Paragon routes, or resolve the explicit OS header. An untrusted header
    // is never accepted without an active membership row.
    await peakosWorkspaceService.attachRequestWorkspace(req, { required: false });
    if (rejectWorkspacePublicAttachment(req, res)) return undefined;
    const collaborationArea = collaborationAreaForPath(policyPath);
    if (collaborationArea && (!req.workspace || !workspacePermissionAllowsRequest(req, collaborationArea))) {
      return res.status(403).json({
        code: req.workspace?.headquartersOversight ? 'PEAKOS_WORKSPACE_READ_ONLY' : 'PEAKOS_WORKSPACE_AREA_FORBIDDEN',
        error: '이 워크스페이스에서 해당 협업 기능을 사용할 수 없습니다.',
      });
    }
    if (req.workspace?.id !== PEAK_WORKSPACE_ID && !isNonPeakWorkspaceSafePath(policyPath)) {
      return res.status(403).json({
        code: 'PEAKOS_WORKSPACE_SURFACE_NOT_MIGRATED',
        error: '이 기능은 워크스페이스 격리 적용 후 사용할 수 있습니다.',
      });
    }
    if (req.workspace && (collaborationArea || req.workspaceSelectedByHeader)) {
      res.set('Cache-Control', 'private, no-store');
      res.vary('X-PeakOS-Workspace');
      res.vary('Authorization');
    }
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    if (err?.statusCode && err?.code?.startsWith('PEAKOS_')) {
      return res.status(err.statusCode).json({ code: err.code, error: err.message });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Whitelist of API paths a chat_only user is allowed to hit. Anything
// else the server rejects with 403. The whitelist covers: the chat
// feature itself, identity/registration, push notification plumbing
// (so notifications still work), and the client debug log uploader.
function isChatOnlyAllowedPath(pathname) {
  return /^\/api\/chat-rooms($|\/)/.test(pathname)
    || /^\/api\/chat($|\/)/.test(pathname)
    || /^\/api\/peakos\/collaboration\/(?:chat|chat-rooms|chat-room-groups)(?:$|\/)/.test(pathname)
    || /^\/api\/peakos\/collaboration\/users\/all-approved$/.test(pathname)
    // Restricted accounts still enter PEAK OS through the same email
    // second-factor endpoints before using their allowed collaboration tabs.
    || /^\/api\/os-auth($|\/)/.test(pathname)
    || /^\/api\/os\/workspaces($|\/)/.test(pathname)
    || /^\/api\/users\/me$/.test(pathname)
    || /^\/api\/users\/register$/.test(pathname)
    || /^\/api\/users\/me\/notification-settings$/.test(pathname)
    || /^\/api\/users\/all-approved$/.test(pathname)
    || /^\/api\/fcm($|\/)/.test(pathname)
	    || /^\/api\/_debug($|\/)/.test(pathname);
}

function isExternalCalendarAllowedPath(pathname) {
  return isChatOnlyAllowedPath(pathname)
    || /^\/api\/events($|\/)/.test(pathname)
    || /^\/api\/peakos\/collaboration\/(?:events|event-types|todo-cats)(?:$|\/)/.test(pathname);
}

function isExternalCalendarUser(req) {
  return !!req.userDoc?.external_calendar_only;
}

const INTERNAL_CALENDAR_RULE_EVENT_SQL = internalCalendarRuleEventSql('e');

async function canAccessEvent(req, eventId, { requireOwner = false } = {}) {
  if (!eventId || !req.workspace) return false;
  const result = await pool.query(
    `SELECT e.owner_id,
            e.scope,
            owner_user.group_id AS owner_group_id,
            ${INTERNAL_CALENDAR_RULE_EVENT_SQL} AS is_internal_rule,
            EXISTS (SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $2) AS is_shared
     FROM events e
     LEFT JOIN users owner_user ON owner_user.uid = e.owner_id
     WHERE e.id = $1 AND e.deleted = false
       AND (e.workspace_id = $3 OR (e.workspace_id IS NULL AND $3 = $4))
       ${eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 3 })}`,
    [eventId, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  const event = result.rows[0];
  if (!event) return false;
  if (isExternalCalendarUser(req) && event.is_internal_rule) return false;
  if (event.owner_id === req.uid) return true;
  if (req.userDoc?.role === 'admin') return true;
  if (requireOwner) return false;
  if (req.userDoc?.role === 'manager'
      && event.scope === 'team'
      && event.owner_group_id
      && event.owner_group_id === req.userDoc.group_id) return true;
  return !!event.is_shared;
}

// PEAK OS collaboration requests use a reviewed, fail-closed alias surface.
// The gateway verifies Firebase + the OS email session, rejects preview writes,
// then rewrites to the canonical legacy path. The route below is therefore the
// same handler and the same calendar_db transaction used by Paragon itself.
app.use(createPeakosCollaborationGateway({
  authMiddleware,
  getRequireOsSession: () => peakosOsEmailAuth?.requireOsSession,
  getRequireWorkspace: ({ req, target }) => {
    const suffix = String(target?.suffix || '');
    const area = suffix.startsWith('/chat-') ? 'chat'
      : (suffix.startsWith('/projects') || suffix.startsWith('/new-projects')) ? 'projects'
        : suffix.startsWith('/users/') ? 'projects'
          : 'calendar';
    const action = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
      ? 'read'
      : 'write';
    return peakosWorkspaceService.requireWorkspace({ area, action, requireHeader: true });
  },
}));

// OS-only calendar visibility is evaluated after the protected gateway has
// authenticated and marked the rewritten request. Canonical Paragon requests
// never carry that marker, so they never consult or mutate the OS hide table.
app.use(createPeakosEventVisibilityGuard({
  pool,
  workspaceIdForRequest: requestWorkspaceId,
}));
registerPeakosEventVisibilityRoutes({
  app,
  authMiddleware,
  pool,
  workspaceIdForRequest: requestWorkspaceId,
  peakWorkspaceId: PEAK_WORKSPACE_ID,
});

// The protected OS alias has already authenticated Firebase + email session
// and attached the selected workspace before it reaches these overrides.
// Canonical Paragon requests carry no collaboration marker and deliberately
// fall through to the unchanged legacy checklist handlers below.
registerPeakosEventChecklistDirectiveRoutes({
  app,
  pool,
  workspaceIdForRequest: requestWorkspaceId,
  peakWorkspaceId: PEAK_WORKSPACE_ID,
  eventHiddenPredicate,
  canAccessEvent,
  notifyUser: sendPushToUser,
  isOsRequest: isPeakosEventVisibilityRequest,
});

// ── Users ──────────────────────────────────────────────────
app.post('/api/users/register', authMiddleware, async (req, res) => {
  try {
    const { uid, userEmail, userName, userPhoto } = req;
    let user = req.userDoc;
    if (!user) {
      // 첫 유저면 자동 admin 승인
      const countRes = await pool.query('SELECT COUNT(*) FROM users WHERE approved = true');
      const isFirst = parseInt(countRes.rows[0].count) === 0;
      const result = await pool.query(
        `INSERT INTO users (uid, email, name, photo_url, approved, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (uid) DO UPDATE SET email=$2, name=$3, photo_url=$4
         RETURNING *`,
        [uid, userEmail, userName, userPhoto, isFirst, isFirst ? 'admin' : 'member']
      );
      user = result.rows[0];
    }
    // 그룹 정보 포함
    if (user.group_id) {
      const grp = await pool.query('SELECT * FROM groups WHERE id = $1', [user.group_id]);
      if (grp.rows[0]) { user.group_name = grp.rows[0].name; user.group_type = grp.rows[0].group_type; user.show_sales_report = grp.rows[0].show_sales_report; }
    }
    res.json(await attachEventReminderPreference(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/me', authMiddleware, async (req, res) => {
  if (!req.userDoc) return res.status(404).json({ error: 'User not found' });
  const user = await attachEventReminderPreference(req.userDoc);
  res.json({
    ...user,
    peakos_special_settlement_views: peakosOwnedMonthlyViews(req),
    peakos_can_view_final_execution: peakosCanSeeFinalExecution(req),
    peakos_can_view_finance_operations: peakosCanSeeFinanceOperations(req),
    peakos_can_preview_accounts: peakosCanPreviewAccounts(req),
    peakos_can_read_bank: peakosBankCanRead(req),
    peakos_can_view_bank_balances: peakosBankCanViewBalances(req),
    peakos_can_review_finance: peakosCanReviewFinance(req),
    peakos_can_view_tax_purchase: peakosCanSeeTaxPurchase(req),
  });
});

app.put('/api/users/me/notification-settings', authMiddleware, async (req, res) => {
  try {
    const { notifyChat, notifyEventReminder, notifyOverdueMorning, notifyTodayEvening } = req.body;
    const result = await pool.query(
      `UPDATE users
       SET notify_chat = COALESCE($1, notify_chat),
           notify_overdue_morning = COALESCE($2, notify_overdue_morning),
           notify_today_evening = COALESCE($3, notify_today_evening)
       WHERE uid = $4
       RETURNING *`,
      [notifyChat, notifyOverdueMorning, notifyTodayEvening, req.uid]
    );
    if (hasEventReminderPrefsTable && typeof notifyEventReminder === 'boolean') {
      await pool.query(
        `INSERT INTO user_event_reminder_prefs (user_uid, enabled, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_uid)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [req.uid, notifyEventReminder]
      );
    }
    res.json(await attachEventReminderPreference(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/pending', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await pool.query(
    'SELECT * FROM users WHERE approved = false AND COALESCE(is_active, true) = true ORDER BY created_at'
  );
  res.json(result.rows);
});

app.get('/api/users/approved', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await pool.query('SELECT * FROM users WHERE approved = true OR is_active = false');
  res.json(result.rows);
});

app.post('/api/users/:uid/approve', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  // Optional body lets the admin pick a role, group, and chat_only
  // flag in the same click instead of having to jump through three
  // separate UI dialogs. All fields are optional so legacy callers
  // that POST an empty body keep working.
  const { role, groupId, chatOnly, workspaceSlug } = req.body || {};
  const sets = ['approved = true', 'is_active = true'];
  const params = [req.params.uid];
  if (role && ['member','manager'].includes(role)) {
    sets.push(`role = $${params.length + 1}`);
    params.push(role);
  }
  if (groupId !== undefined) {
    sets.push(`group_id = $${params.length + 1}`);
    params.push(groupId || null);
  }
  const membershipClient = await pool.connect();
  try {
    await membershipClient.query('BEGIN');
    await membershipClient.query(`UPDATE users SET ${sets.join(', ')} WHERE uid = $1`, params);
    const membership = await peakosWorkspaceService.syncUserDefaultMembership({
      actorUid: req.uid,
      targetUid: req.params.uid,
      groupId,
      workspaceSlug,
      role,
      client: membershipClient,
    });
    if (typeof chatOnly === 'boolean') {
      await peakosWorkspaceService.setUserRestrictionMode({
        actorUid: req.uid,
        targetUid: req.params.uid,
        mode: 'chat_only',
        enabled: chatOnly,
        client: membershipClient,
      });
    }
    await peakosWorkspaceService.setUserMembershipsActive({
      actorUid: req.uid,
      targetUid: req.params.uid,
      active: true,
      client: membershipClient,
    });
    await membershipClient.query('COMMIT');
    res.json({ ok: true, workspace: membership });
  } catch (err) {
    await membershipClient.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  } finally {
    membershipClient.release();
  }
});

app.post('/api/users/:uid/cancel-approval', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await pool.query(
    `UPDATE users
     SET approved = false, is_active = false
     WHERE uid = $1 AND approved = false
     RETURNING uid`,
    [req.params.uid]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Pending user not found' });
  await pool.query('DELETE FROM fcm_tokens WHERE user_uid = $1', [req.params.uid]);
  res.json({ ok: true });
});

// ── Events ─────────────────────────────────────────────────
app.get('/api/events', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const t0 = Date.now();
  try {
    // Optional date-range scoping. `events.date` is stored as a TEXT
    // column in YYYY-MM-DD format, which sorts correctly lexically
    // so we can compare with bound text params directly. Callers
    // that pass `from`/`to` shrink the typical manager payload from
    // ~50k rows (all alive team events) down to a current-month-ish
    // window of a few hundred. Backwards-compatible: omitting the
    // params falls back to the full query.
    const fromParam = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from : null;
    const toParam = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to : null;
    if (!req.workspace) return res.status(403).json({ code: 'PEAKOS_WORKSPACE_REQUIRED', error: 'Workspace required' });
    const params = [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID];
    const dateClauses = [];
    if (fromParam) { params.push(fromParam); dateClauses.push(`e.date >= $${params.length}`); }
    if (toParam) { params.push(toParam); dateClauses.push(`e.date <= $${params.length}`); }
    const dateWhere = dateClauses.length ? ' AND ' + dateClauses.join(' AND ') : '';

	    const isAdminRequest = req.userDoc.role === 'admin';
	    const isManagerRequest = req.userDoc.role === 'manager';
	    let scopeWhere = `(e.owner_id = $1 OR es.user_id = $1)`;
	    if (isAdminRequest) {
	      scopeWhere = `(e.owner_id = $1 OR es.user_id = $1 OR e.scope = 'team')`;
	    } else if (isManagerRequest) {
	      params.push(req.userDoc.group_id || null);
	      scopeWhere = `(e.owner_id = $1 OR es.user_id = $1 OR (e.scope = 'team' AND event_owner.group_id = $${params.length}))`;
	    }
	    const externalRuleWhere = isExternalCalendarUser(req)
	      ? ` AND NOT ${INTERNAL_CALENDAR_RULE_EVENT_SQL}`
	      : '';
	    const sharedDoneWhere = isAdminRequest
	      ? ''
	      : ` AND NOT (e.scope = 'team' AND e.done = true AND e.owner_id <> $1)`;

	    const result = await pool.query(
	      `SELECT e.*, BOOL_OR(es.user_id = $1) AS is_shared FROM events e
	       LEFT JOIN event_shares es ON e.id = es.event_id
	       LEFT JOIN users event_owner ON event_owner.uid = e.owner_id
	       LEFT JOIN projects ep ON ep.id = e.project_id
	       LEFT JOIN project_details epd ON epd.project_id = ep.id
	       WHERE e.deleted = false
	         AND (e.workspace_id = $2 OR (e.workspace_id IS NULL AND $2 = $3))
	         AND (e.project_id IS NULL OR (COALESCE(epd.deleted, false) = false AND ep.status IS DISTINCT FROM 'archived'))
	         AND ${scopeWhere}${dateWhere}${externalRuleWhere}${sharedDoneWhere}
	         ${eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 2 })}
	       GROUP BY e.id
	       ORDER BY e.created_at DESC`,
      params
    );
    // Temporary diagnostic: log how many rows each manager/admin request
    // actually returns, so we can verify the client-side date scope is
    // reaching the server in production. Removing once confirmed.
    console.log(`[events-get] uid=${req.uid} role=${req.userDoc.role || 'user'} from=${fromParam||'-'} to=${toParam||'-'} rows=${result.rows.length} ms=${Date.now()-t0}`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getNextTodoSortOrder(date, todoCat, scope, ownerId, workspaceId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
     FROM events
     WHERE deleted = false
       AND type = 'todo'
       AND date = $1
       AND scope = $2
       AND (($3::text IS NULL AND todo_cat IS NULL) OR todo_cat = $3)
       AND ($2 <> 'personal' OR owner_id = $4)
       AND (workspace_id = $5 OR (workspace_id IS NULL AND $5 = $6))`,
    [date, scope || 'personal', todoCat || null, ownerId || null, workspaceId, PEAK_WORKSPACE_ID]
  );
  return parseInt(result.rows[0]?.next || '0', 10);
}

function normalizeEventChecklistTitles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(title => String(title || '').trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 100);
}

function buildRepeatDates(startDate, repeatType, repeatEnd) {
  if (!repeatType) return [];
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(repeatType)) {
    throw Object.assign(new Error('지원하지 않는 반복 방식입니다.'), { statusCode: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(repeatEnd || '')) {
    throw Object.assign(new Error('반복 시작일과 종료일을 확인하세요.'), { statusCode: 400 });
  }
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${repeatEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw Object.assign(new Error('반복 종료일은 시작일 이후여야 합니다.'), { statusCode: 400 });
  }
  const maxEnd = new Date(start);
  maxEnd.setUTCFullYear(maxEnd.getUTCFullYear() + 2);
  if (end > maxEnd) {
    throw Object.assign(new Error('반복 일정은 최대 2년까지만 등록할 수 있습니다.'), { statusCode: 400 });
  }

  const dates = [];
  const cursor = new Date(start);
  while (true) {
    if (repeatType === 'daily' || repeatType === 'weekdays') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (repeatType === 'weekly') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    if (cursor > end) break;
    if (repeatType === 'weekdays' && (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6)) continue;
    dates.push(cursor.toISOString().slice(0, 10));
    if (dates.length > 750) {
      throw Object.assign(new Error('반복 일정은 최대 750회까지만 등록할 수 있습니다.'), { statusCode: 400 });
    }
  }
  return dates;
}

app.post('/api/events', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { type, title, date, time, endTime, url, memo, todoCat, reminder, scope, repeatType, repeatEnd, shareWith, endDate, checklist } = req.body;
  const resolvedScope = scope || 'personal';
  const checklistTitles = normalizeEventChecklistTitles(checklist);
  const requestedShareIds = Array.from(new Set((Array.isArray(shareWith) ? shareWith : [])
    .map(uid => String(uid || '').trim())
    .filter(uid => uid && uid !== req.uid)));
  let client;
  try {
    if (!String(title || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: '제목과 날짜를 확인하세요.' });
    }
    if (isExternalCalendarUser(req) && resolvedScope === 'team') {
      return res.status(403).json({ error: '외부 캘린더 계정은 개인 일정만 등록할 수 있습니다' });
    }
    const normalizedRange = validateEventTimeRange(time, endTime);
    const repeatDates = buildRepeatDates(date, repeatType, repeatEnd);
    let validShareIds = [];
    if (resolvedScope === 'team' && requestedShareIds.length) {
      validShareIds = await peakosWorkspaceService.assertUsersInWorkspace(
        requestedShareIds,
        requestWorkspaceId(req),
      );
    }

    const sortOrder = type === 'todo'
      ? await getNextTodoSortOrder(date, todoCat, resolvedScope, req.uid, requestWorkspaceId(req))
      : 0;
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO events (workspace_id, type, title, date, time, end_time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [requestWorkspaceId(req), type, title, date, normalizedRange.startTime, normalizedRange.endTime, url||'', memo||'', todoCat||null, reminder||null, resolvedScope, req.uid, req.userName, repeatType||null, repeatEnd||null, endDate||null, sortOrder]
    );
    const parent = result.rows[0];
    const eventIds = [parent.id];
    if (repeatDates.length) {
      await client.query('UPDATE events SET repeat_parent_id = $1 WHERE id = $1', [parent.id]);
      const children = await client.query(
        `INSERT INTO events
           (workspace_id,type,title,date,time,end_time,url,memo,todo_cat,reminder,scope,owner_id,owner_name,repeat_type,repeat_end,repeat_parent_id,end_date,sort_order)
         SELECT $1,$2,$3,repeat_date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0
         FROM unnest($17::text[]) AS repeat_dates(repeat_date)
         RETURNING id`,
        [requestWorkspaceId(req), type, title, normalizedRange.startTime, normalizedRange.endTime, url||'', memo||'', todoCat||null, reminder||null, resolvedScope,
          req.uid, req.userName, repeatType, repeatEnd, parent.id, endDate||null, repeatDates]
      );
      eventIds.push(...children.rows.map(row => row.id));
    }

    if (checklistTitles.length) {
      await client.query(
        `INSERT INTO event_checklist (event_id, title, sort_order)
         SELECT event_id, item.title, item.ordinality - 1
         FROM unnest($1::text[]) AS event_ids(event_id)
         CROSS JOIN unnest($2::text[]) WITH ORDINALITY AS item(title, ordinality)`,
        [eventIds, checklistTitles]
      );
    }

    if (resolvedScope === 'team' && validShareIds.length) {
      await client.query(
        `INSERT INTO event_shares (event_id, user_id)
         SELECT event_id, user_id
         FROM unnest($1::text[]) AS event_ids(event_id)
         CROSS JOIN unnest($2::text[]) AS user_ids(user_id)
         ON CONFLICT DO NOTHING`,
        [eventIds, validShareIds]
      );
    }

    await client.query('COMMIT');
    for (const uid of validShareIds) {
      sendPushToUser(uid, '📅 팀 일정 공유', `${req.userName}: ${title} (${date})`, {
        kind: 'event-share',
        link: `/?page=calendar&tab=month&date=${date}&eventId=${parent.id}`,
        tag: `event-share-${parent.id}`,
        page: 'calendar',
        eventId: parent.id,
        date
      });
    }
    res.json({ ...parent, repeat_count: repeatDates.length, checklist_count: checklistTitles.length });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

async function syncProjectStatus(projectId) {
  if (!projectId) return;
  const summary = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE deleted = false) AS total,
            COUNT(*) FILTER (WHERE deleted = false AND done = true) AS completed
     FROM events
     WHERE project_id = $1`,
    [projectId]
  );
  const total = parseInt(summary.rows[0]?.total || '0', 10);
  const completed = parseInt(summary.rows[0]?.completed || '0', 10);
  const nextStatus = total > 0 && total === completed ? 'done' : 'active';
  await pool.query(
    'UPDATE projects SET status = $2 WHERE id = $1 AND status IS DISTINCT FROM $2',
    [projectId, nextStatus]
  );
}

async function syncProjectStatusForEvent(eventId) {
  if (!eventId) return;
  const result = await pool.query('SELECT project_id FROM events WHERE id = $1', [eventId]);
  const projectId = result.rows[0]?.project_id;
  if (projectId) await syncProjectStatus(projectId);
}

async function syncChecklistDrivenEventState(eventId) {
  if (!eventId) return;
  const summary = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE done = true) AS completed
     FROM event_checklist
     WHERE event_id = $1`,
    [eventId]
  );
  const total = parseInt(summary.rows[0]?.total || '0', 10);
  const completed = parseInt(summary.rows[0]?.completed || '0', 10);
  let kanbanStatus = 'todo';
  let done = false;
  if (total > 0 && total === completed) {
    kanbanStatus = 'done';
    done = true;
  } else if (completed > 0) {
    kanbanStatus = 'in_progress';
  }
  await pool.query(
    'UPDATE events SET done = $2, kanban_status = $3 WHERE id = $1',
    [eventId, done, kanbanStatus]
  );
  await syncProjectStatusForEvent(eventId);
}

async function normalizeChecklistSortOrders(eventId) {
  const result = await pool.query(
    `SELECT id
     FROM event_checklist
     WHERE event_id = $1
     ORDER BY done DESC, sort_order ASC, created_at ASC, id ASC`,
    [eventId]
  );
  for (let index = 0; index < result.rows.length; index++) {
    await pool.query(
      'UPDATE event_checklist SET sort_order = $1 WHERE id = $2 AND sort_order IS DISTINCT FROM $1',
      [index, result.rows[index].id]
    );
  }
}

async function getEventRowById(eventId) {
  if (!eventId) return null;
  const result = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  return result.rows[0] || null;
}

app.put('/api/events/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { type, title, date, time, endTime, url, memo, todoCat, reminder, scope, done, deleted, kanbanStatus, kanbanOrder, endDate, shareWith } = req.body;
  const shouldSyncShares = Array.isArray(shareWith) || scope === 'personal';
  const requestedShareIds = Array.from(new Set((Array.isArray(shareWith) ? shareWith : [])
    .map(uid => String(uid || '').trim())
    .filter(uid => uid && uid !== req.uid)));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const ev = await client.query(
      `SELECT * FROM events
        WHERE id = $1
          AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
        FOR UPDATE`,
      [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
    );
    if (!ev.rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) {
      throw Object.assign(new Error('Not owner'), { statusCode: 403 });
    }
    const resolvedScope = scope || ev.rows[0].scope || 'personal';
    if (isExternalCalendarUser(req) && resolvedScope === 'team') {
      throw Object.assign(new Error('외부 캘린더 계정은 개인 일정만 등록할 수 있습니다'), { statusCode: 403 });
    }

    const {
      startTime: normalizedTime,
      endTime: normalizedEndTime,
    } = resolveEventTimeRangeUpdate({
      existingStartTime: ev.rows[0].time,
      existingEndTime: ev.rows[0].end_time,
      requestedStartTime: time,
      requestedEndTime: endTime,
      legacyRequest: !isPeakosCollaborationAuthenticated(req),
    });

    let validShareIds = [];
    if (shouldSyncShares && resolvedScope === 'team' && requestedShareIds.length) {
      validShareIds = await peakosWorkspaceService.assertUsersInWorkspace(
        requestedShareIds,
        requestWorkspaceId(req),
      );
    }
    const oldShares = shouldSyncShares
      ? await client.query('SELECT user_id FROM event_shares WHERE event_id = $1', [req.params.id])
      : { rows: [] };
    const oldShareIds = new Set(oldShares.rows.map(row => row.user_id));

    const result = await client.query(
      `UPDATE events SET type=COALESCE($1,type), title=COALESCE($2,title), date=COALESCE($3,date),
       time=COALESCE($4,time), end_time=COALESCE($5,end_time), url=COALESCE($6,url), memo=COALESCE($7,memo),
       todo_cat=COALESCE($8,todo_cat), reminder=COALESCE($9,reminder), scope=COALESCE($10,scope),
       done=COALESCE($11,done), deleted=COALESCE($12,deleted),
       kanban_status=COALESCE($13,kanban_status), kanban_order=COALESCE($14,kanban_order),
       end_date=COALESCE($15,end_date)
       WHERE id=$16 RETURNING *`,
      [type, title, date, normalizedTime, normalizedEndTime, url, memo, todoCat, reminder, scope, done, deleted, kanbanStatus, kanbanOrder, endDate, req.params.id]
    );
    if (shouldSyncShares) {
      await client.query('DELETE FROM event_shares WHERE event_id = $1', [req.params.id]);
      if (resolvedScope === 'team' && validShareIds.length) {
        await client.query(
          `INSERT INTO event_shares (event_id, user_id)
           SELECT $1, user_id FROM unnest($2::text[]) AS user_ids(user_id)
           ON CONFLICT DO NOTHING`,
          [req.params.id, validShareIds]
        );
      }
    }
    await client.query('COMMIT');
    await syncProjectStatus(result.rows[0]?.project_id);
    const addedShareIds = validShareIds.filter(uid => !oldShareIds.has(uid));
    await Promise.all(addedShareIds.map(uid => sendPushToUser(
      uid,
      '📅 팀 일정 공유',
      `${req.userName}: ${result.rows[0].title} (${result.rows[0].date})`,
      {
        kind: 'event-share',
        link: `/?page=calendar&tab=month&date=${result.rows[0].date}&eventId=${result.rows[0].id}`,
        tag: `event-share-${result.rows[0].id}`,
        page: 'calendar',
        eventId: result.rows[0].id,
        date: result.rows[0].date
      }
    )));
    res.json(result.rows[0]);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

// ── Ideas ──────────────────────────────────────────────────
app.get('/api/ideas', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    let result;
    if (req.userDoc.role === 'admin') {
      result = await pool.query('SELECT * FROM ideas ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT * FROM ideas WHERE owner_id = $1 OR scope = 'team' ORDER BY created_at DESC`,
        [req.uid]
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ideas/upload', authMiddleware, uploadJpgPng.array('images', 10), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.files?.length) return res.status(400).json({ error: 'JPG/PNG 이미지만 업로드할 수 있습니다' });
  const attachments = req.files.map(file => ({
    url: '/uploads/' + file.filename,
    name: path.basename(decodeMultipartFilename(file.originalname || file.filename)),
    storedName: file.filename,
    mimeType: file.mimetype || null,
    size: file.size || null
  }));
  res.json({ attachments: normalizeNoticeAttachments(attachments) });
});

app.post('/api/ideas', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { title, category, source, url, summary, detail, scope, date, attachments } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO ideas (title, category, source, url, summary, detail, scope, owner_id, owner_name, date, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [title||'', category, source||'', url||'', summary||'', detail||'', scope||'personal', req.uid, req.userName, date||null, JSON.stringify(normalizeNoticeAttachments(attachments))]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ideas/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const idea = await pool.query('SELECT * FROM ideas WHERE id = $1', [req.params.id]);
  if (!idea.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && idea.rows[0].owner_id !== req.uid) {
    return res.status(403).json({ error: 'Not owner' });
  }
  const { title, category, source, url, summary, detail, scope, attachments } = req.body;
  const result = await pool.query(
    `UPDATE ideas SET title=COALESCE($1,title), category=COALESCE($2,category), source=COALESCE($3,source),
     url=COALESCE($4,url), summary=COALESCE($5,summary), detail=COALESCE($6,detail), scope=COALESCE($7,scope),
     attachments=COALESCE($8,attachments)
     WHERE id=$9 RETURNING *`,
    [title, category, source, url, summary, detail, scope, attachments === undefined ? null : JSON.stringify(normalizeNoticeAttachments(attachments)), req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/ideas/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const idea = await pool.query('SELECT * FROM ideas WHERE id = $1', [req.params.id]);
  if (!idea.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && idea.rows[0].owner_id !== req.uid) {
    return res.status(403).json({ error: 'Not owner' });
  }
  await pool.query('DELETE FROM ideas WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/ideas', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  await pool.query('DELETE FROM ideas');
  res.json({ ok: true });
});

// ── Custom Idea Categories (사용자별 아이디어 카테고리) ────────
app.get('/api/idea-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    'SELECT * FROM custom_idea_cats WHERE owner_id = $1 ORDER BY sort_order, created_at',
    [req.uid]
  );
  res.json(result.rows);
});

app.post('/api/idea-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO custom_idea_cats (owner_id, name, color) VALUES ($1,$2,$3) RETURNING *',
    [req.uid, name, color || '#888888']
  );
  res.json(result.rows[0]);
});

app.delete('/api/idea-cats/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM custom_idea_cats WHERE id = $1 AND owner_id = $2', [req.params.id, req.uid]);
  res.json({ ok: true });
});

// ── Custom Event Types (사용자별 일정 종류) ──────────────────
app.get('/api/event-types', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    `SELECT * FROM custom_event_types
      WHERE owner_id = $1
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
      ORDER BY sort_order, created_at`,
    [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json(result.rows);
});

app.post('/api/event-types', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, icon, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO custom_event_types (workspace_id, owner_id, name, icon, color) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [requestWorkspaceId(req), req.uid, name, icon || '📌', color || '#3B82F6']
  );
  res.json(result.rows[0]);
});

app.delete('/api/event-types/:id', authMiddleware, async (req, res) => {
  await pool.query(
    `DELETE FROM custom_event_types WHERE id = $1 AND owner_id = $2
      AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.params.id, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  res.json({ ok: true });
});

// ── Custom Todo Categories (사용자별 할 일 카테고리) ──────────
app.get('/api/todo-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    `SELECT * FROM custom_todo_cats
      WHERE owner_id = $1
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
      ORDER BY sort_order, created_at`,
    [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json(result.rows);
});

app.post('/api/todo-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO custom_todo_cats (workspace_id, owner_id, name, color) VALUES ($1,$2,$3,$4) RETURNING *',
    [requestWorkspaceId(req), req.uid, name, color || '#3B82F6']
  );
  res.json(result.rows[0]);
});

app.delete('/api/todo-cats/:id', authMiddleware, async (req, res) => {
  await pool.query(
    `DELETE FROM custom_todo_cats WHERE id = $1 AND owner_id = $2
      AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.params.id, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  res.json({ ok: true });
});

// ── Chat Rooms (팀 채팅방) ─────────────────────────────────
app.get('/api/chat-rooms', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    `WITH my_rooms AS (
       SELECT cr.*
       FROM chat_rooms cr
       JOIN chat_room_members crm ON cr.id = crm.room_id
       WHERE crm.user_id = $1
         AND (cr.workspace_id = $2 OR (cr.workspace_id IS NULL AND $2 = $3))
     ),
     member_counts AS (
       SELECT crm.room_id, COUNT(*)::int AS member_count
       FROM chat_room_members crm
       JOIN my_rooms mr ON mr.id = crm.room_id
       JOIN users member_user ON member_user.uid = crm.user_id
         AND member_user.approved = true
         AND COALESCE(member_user.is_active, true) = true
       JOIN peakos_workspace_memberships member_workspace
         ON member_workspace.user_uid = crm.user_id
        AND member_workspace.workspace_id = COALESCE(mr.workspace_id, $3)
        AND member_workspace.active = TRUE
        AND member_workspace.role <> 'oversight'
       GROUP BY crm.room_id
     ),
     last_messages AS (
       SELECT DISTINCT ON (c.room_id)
         c.room_id,
         c.created_at AS last_message_at,
         c.name AS last_message_sender,
         CASE
           WHEN c.image_url IS NOT NULL THEN '사진을 보냈습니다'
           WHEN c.file_url IS NOT NULL THEN COALESCE(c.file_name, '파일을 보냈습니다')
           WHEN c.text LIKE '[EVENT_SHARE]%' THEN '일정을 공유했습니다'
           WHEN c.text LIKE '[NOTICE_SHARE]%' THEN '공지를 공유했습니다'
           WHEN c.text LIKE '[IDEA_SHARE]%' THEN '아이디어를 공유했습니다'
           WHEN c.text LIKE '[MEETING_BRIEF]%' THEN '회의 카드가 업데이트됐습니다'
           WHEN c.text LIKE '[MEETING_ACTION]%' THEN '액션 아이템이 등록됐습니다'
           WHEN c.text LIKE '[MEETING_ACTION_LINK]%' THEN '액션 아이템이 등록 처리됐습니다'
           ELSE LEFT(COALESCE(c.text, ''), 120)
         END AS last_message_text
       FROM chat c
       JOIN my_rooms mr ON mr.id = c.room_id
       ORDER BY c.room_id, c.created_at DESC, c.id DESC
     )
     SELECT mr.*,
       COALESCE(mc.member_count, 0) AS member_count,
       crgl.group_id,
       crg.name AS group_name,
       crg.color AS group_color,
       lm.last_message_at,
       lm.last_message_sender,
       lm.last_message_text
     FROM my_rooms mr
     LEFT JOIN member_counts mc ON mc.room_id = mr.id
     LEFT JOIN chat_room_group_links crgl ON crgl.room_id = mr.id
     LEFT JOIN chat_room_groups crg ON crg.id = crgl.group_id AND crg.deleted = false
     LEFT JOIN last_messages lm ON lm.room_id = mr.id
     ORDER BY lm.last_message_at DESC NULLS LAST, mr.created_at DESC`,
    [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json(result.rows);
});

app.get('/api/chat-room-groups', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const result = await pool.query(
      `WITH my_rooms AS (
         SELECT cr.id
         FROM chat_rooms cr
         JOIN chat_room_members crm ON cr.id = crm.room_id
         WHERE crm.user_id = $1
           AND (cr.workspace_id = $2 OR (cr.workspace_id IS NULL AND $2 = $3))
       )
       SELECT crg.*,
              COUNT(mr.id)::int AS room_count
       FROM chat_room_groups crg
       LEFT JOIN chat_room_group_links crgl ON crgl.group_id = crg.id
       LEFT JOIN my_rooms mr ON mr.id = crgl.room_id
       WHERE crg.deleted = false
         AND (crg.workspace_id = $2 OR (crg.workspace_id IS NULL AND $2 = $3))
       GROUP BY crg.id
       ORDER BY crg.sort_order, crg.created_at`,
      [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    res.json({ canManage: canManageChatRoomGroups(req), groups: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat-room-groups', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!canManageChatRoomGroups(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const color = String(req.body?.color || '#007AFF').trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = await pool.query(
      `INSERT INTO chat_room_groups (workspace_id, id, name, color, sort_order, created_by)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM chat_room_groups
                              WHERE workspace_id = $1 OR (workspace_id IS NULL AND $1 = $6)),$5)
       RETURNING *`,
      [requestWorkspaceId(req), crypto.randomUUID(), name, color || '#007AFF', req.uid, PEAK_WORKSPACE_ID]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/chat-room-groups/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!canManageChatRoomGroups(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const color = String(req.body?.color || '#007AFF').trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = await pool.query(
      `UPDATE chat_room_groups
       SET name=$1, color=$2, updated_at=NOW()
       WHERE id=$3 AND deleted=false
         AND (workspace_id = $4 OR (workspace_id IS NULL AND $4 = $5))
       RETURNING *`,
      [name, color || '#007AFF', req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chat-room-groups/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!canManageChatRoomGroups(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const group = await pool.query(
      `UPDATE chat_room_groups SET deleted=true, updated_at=NOW()
        WHERE id=$1 AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
        RETURNING id`,
      [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
    );
    if (!group.rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM chat_room_group_links WHERE group_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseJsonSafely(value) {
  try { return JSON.parse(value); } catch (err) { return null; }
}

async function getChatRoomById(roomId, req) {
  if (!req?.workspace) return null;
  const result = await pool.query(
    `SELECT * FROM chat_rooms WHERE id = $1
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [roomId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  return result.rows[0] || null;
}

async function isChatRoomMember(roomId, userId, req) {
  if (!req?.workspace) return false;
  const result = await pool.query(
    `SELECT 1 FROM chat_room_members crm
      JOIN chat_rooms cr ON cr.id = crm.room_id
      JOIN peakos_workspace_memberships pwm
        ON pwm.user_uid = crm.user_id
       AND pwm.workspace_id = COALESCE(cr.workspace_id, $4)
       AND pwm.active = TRUE
       AND pwm.role <> 'oversight'
      WHERE crm.room_id = $1 AND crm.user_id = $2
        AND (cr.workspace_id = $3 OR (cr.workspace_id IS NULL AND $3 = $4))`,
    [roomId, userId, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  return !!result.rows[0];
}

function canManageChatRoom(room, req) {
  return !!room && (room.creator_id === req.uid || req.userDoc?.role === 'admin');
}

function canManageChatRoomGroups(req) {
  return ['admin', 'manager'].includes(req.userDoc?.role) || !!req.userDoc?.can_manage_team;
}

function getChatPreviewText(text) {
  const value = String(text || '');
  if (!value) return '';
  if (value.startsWith('[MEETING_BRIEF]')) return '회의 카드가 업데이트됐습니다';
  if (value.startsWith('[MEETING_ACTION]')) return '액션 아이템이 등록됐습니다';
  if (value.startsWith('[MEETING_ACTION_LINK]')) {
    const payload = parseJsonSafely(value.slice('[MEETING_ACTION_LINK]'.length));
    return payload?.targetType === 'todo'
      ? '액션 아이템이 할 일로 등록됐습니다'
      : '액션 아이템이 일정으로 등록됐습니다';
  }
  if (value.startsWith('[')) return '공유 메시지';
  return value.slice(0, 50);
}

async function insertRoomSystemMessage(roomId, req, text) {
  const result = await pool.query(
    'INSERT INTO chat (text, uid, name, photo_url, room_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [text, req.uid, req.userName, req.userPhoto, roomId]
  );
  await pool.query(
    `INSERT INTO chat_read_status (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_msg_id=$3, last_read_at=NOW()`,
    [roomId, req.uid, result.rows[0].id]
  );
  return result.rows[0];
}

async function notifyChatRoomMembers(roomId, senderUid, title, body) {
  const members = await pool.query(
    `SELECT crm.user_id
     FROM chat_room_members crm
     JOIN chat_rooms cr ON cr.id = crm.room_id
     JOIN users u ON u.uid = crm.user_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = crm.user_id
      AND pwm.workspace_id = COALESCE(cr.workspace_id, $3)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE crm.room_id = $1
       AND crm.user_id != $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [roomId, senderUid, PEAK_WORKSPACE_ID]
  );
  for (const member of members.rows) {
    sendPushToUser(member.user_id, title, body, {
      kind: 'chat',
      link: `/?page=chat&roomId=${encodeURIComponent(roomId)}`,
      tag: `chat-room-${roomId}`,
      page: 'chat',
      roomId
    });
  }
}

const CHAT_TYPING_TTL_MS = 7000;
const chatTypingState = new Map();

function getLiveChatTypingUsers(roomId, excludeUid = '') {
  const roomKey = String(roomId || '');
  const roomState = chatTypingState.get(roomKey);
  if (!roomState) return [];
  const now = Date.now();
  for (const [uid, entry] of roomState.entries()) {
    if (!entry || entry.expiresAt <= now) roomState.delete(uid);
  }
  if (!roomState.size) chatTypingState.delete(roomKey);
  return Array.from(roomState.entries())
    .filter(([uid]) => uid !== excludeUid)
    .map(([uid, entry]) => ({ uid, name: entry.name }));
}

function clearChatTypingUser(roomId, uid) {
  const roomKey = String(roomId || '');
  const roomState = chatTypingState.get(roomKey);
  if (!roomState) return;
  roomState.delete(uid);
  if (!roomState.size) chatTypingState.delete(roomKey);
}

function escapeChatMentionRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chatTextMentionsName(text, name) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) return false;
  const escapedName = escapeChatMentionRegex(normalizedName);
  return new RegExp(`@(?:\\[${escapedName}\\]|${escapedName})(?=$|\\s|[.,!?;:])`, 'u').test(String(text || ''));
}

app.post('/api/chat-rooms', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, memberIds, groupId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const requestedMemberIds = Array.from(new Set((Array.isArray(memberIds) ? memberIds : [])
      .map(uid => String(uid || '').trim())
      .filter(uid => uid && uid !== req.uid)));
    let validMemberIds = [];
    if (requestedMemberIds.length) {
      const restrictedDirectory = req.userDoc.chat_only || req.userDoc.external_calendar_only;
      validMemberIds = await peakosWorkspaceService.assertUsersInWorkspace(
        requestedMemberIds,
        requestWorkspaceId(req),
      );
      if (restrictedDirectory) {
        const admins = await pool.query(
          'SELECT uid FROM users WHERE uid = ANY($1::text[]) AND role = $2',
          [validMemberIds, 'admin'],
        );
        if (admins.rows.length !== validMemberIds.length) {
          return res.status(400).json({ error: '초대할 수 없는 사용자가 포함되어 있습니다.' });
        }
      }
    }
    const room = await pool.query(
      'INSERT INTO chat_rooms (workspace_id, name, creator_id) VALUES ($1, $2, $3) RETURNING *',
      [requestWorkspaceId(req), name, req.uid]
    );
    const roomId = room.rows[0].id;
    // 생성자 자동 추가
    await pool.query('INSERT INTO chat_room_members (room_id, user_id) VALUES ($1, $2)', [roomId, req.uid]);
    // 초대된 멤버 추가
    if (validMemberIds.length > 0) {
      for (const mid of validMemberIds) {
        await pool.query(
          'INSERT INTO chat_room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [roomId, mid]
        );
      }
    }
    if (groupId) {
      const group = await pool.query(
        `SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false
          AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
        [groupId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
      );
      if (group.rows[0]) {
        await pool.query(
          'INSERT INTO chat_room_group_links (room_id, group_id, updated_by) VALUES ($1,$2,$3) ON CONFLICT (room_id) DO UPDATE SET group_id=EXCLUDED.group_id, updated_by=EXCLUDED.updated_by, updated_at=NOW()',
          [roomId, groupId, req.uid]
        );
      }
    }
    res.json(room.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/chat-rooms/:roomId', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (name.length > 60) return res.status(400).json({ error: '이름은 60자 이하여야 합니다.' });

  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });

  const member = await isChatRoomMember(req.params.roomId, req.uid, req);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const canManage = room.creator_id === req.uid || req.userDoc?.role === 'admin';
  if (!canManage) return res.status(403).json({ error: '생성자 또는 관리자만 수정할 수 있습니다.' });

  const updated = await pool.query(
    `UPDATE chat_rooms SET name = $1 WHERE id = $2
      AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4)) RETURNING *`,
    [name, req.params.roomId, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json(updated.rows[0]);
});

async function getManageableChatRoomsForBulk(roomIds, req) {
  const ids = Array.from(new Set((Array.isArray(roomIds) ? roomIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean)))
    .slice(0, 200);
  if (!ids.length) return { ids, rooms: [], forbidden: [] };

  const result = await pool.query(
    `SELECT cr.*
     FROM chat_rooms cr
     JOIN chat_room_members crm ON crm.room_id = cr.id AND crm.user_id = $1
     WHERE cr.id = ANY($2::text[])
       AND (cr.workspace_id = $3 OR (cr.workspace_id IS NULL AND $3 = $4))`,
    [req.uid, ids, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  const roomMap = new Map(result.rows.map(room => [String(room.id), room]));
  const canManageGroups = canManageChatRoomGroups(req);
  const forbidden = ids.filter(id => {
    const room = roomMap.get(String(id));
    return !room || (!canManageChatRoom(room, req) && !canManageGroups);
  });
  return { ids, rooms: result.rows, forbidden };
}

app.put('/api/chat-rooms/bulk/group', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const { ids, forbidden } = await getManageableChatRoomsForBulk(req.body?.roomIds, req);
    if (!ids.length) return res.status(400).json({ error: '선택된 채팅방이 없습니다.' });
    if (forbidden.length) return res.status(403).json({ error: '이동 권한이 없는 채팅방이 포함되어 있습니다.' });

    const groupId = String(req.body?.groupId || req.body?.group_id || '').trim();
    if (!groupId) {
      await pool.query('DELETE FROM chat_room_group_links WHERE room_id = ANY($1::text[])', [ids]);
      return res.json({ ok: true, updated: ids.length, group_id: null });
    }

    const group = await pool.query(
      `SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
      [groupId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
    );
    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });

    for (const roomId of ids) {
      await pool.query(
        `INSERT INTO chat_room_group_links (room_id, group_id, updated_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (room_id) DO UPDATE SET group_id=EXCLUDED.group_id, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [roomId, groupId, req.uid]
      );
    }
    res.json({ ok: true, updated: ids.length, group_id: groupId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/chat-rooms/:roomId/group', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const room = await getChatRoomById(req.params.roomId, req);
    if (!room) return res.status(404).json({ error: 'Not found' });
    const member = await isChatRoomMember(req.params.roomId, req.uid, req);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    if (!canManageChatRoom(room, req) && !canManageChatRoomGroups(req)) {
      return res.status(403).json({ error: '생성자, 관리자 또는 그룹 관리자만 이동할 수 있습니다.' });
    }
    const groupId = String(req.body?.groupId || req.body?.group_id || '').trim();
    if (!groupId) {
      await pool.query('DELETE FROM chat_room_group_links WHERE room_id=$1', [req.params.roomId]);
      return res.json({ ok: true, group_id: null });
    }
    const group = await pool.query(
      `SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
      [groupId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
    );
    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });
    await pool.query(
      `INSERT INTO chat_room_group_links (room_id, group_id, updated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (room_id) DO UPDATE SET group_id=EXCLUDED.group_id, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [req.params.roomId, groupId, req.uid]
    );
    res.json({ ok: true, group_id: groupId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat-rooms/:roomId/members', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const member = await isChatRoomMember(req.params.roomId, req.uid, req);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const result = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url,
      (u.uid = cr.creator_id) as is_creator
     FROM chat_room_members crm
     JOIN users u ON crm.user_id = u.uid
     JOIN chat_rooms cr ON cr.id = crm.room_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = crm.user_id
      AND pwm.workspace_id = COALESCE(cr.workspace_id, $2)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE crm.room_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true
     ORDER BY (u.uid = cr.creator_id) DESC, u.name`,
    [req.params.roomId, PEAK_WORKSPACE_ID]
  );
  res.json(result.rows);
});

app.post('/api/chat-rooms/:roomId/members', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { userId } = req.body;
  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const member = await isChatRoomMember(req.params.roomId, req.uid, req);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!canManageChatRoom(room, req)) return res.status(403).json({ error: '생성자 또는 관리자만 멤버를 추가할 수 있습니다.' });
  // Restricted chat/calendar accounts only receive the admin directory.
  // Enforce the same boundary here as well, so a caller cannot bypass the
  // directory by submitting a known employee UID directly.
  const restrictedDirectory = req.userDoc.chat_only || req.userDoc.external_calendar_only;
  try {
    await peakosWorkspaceService.assertUsersInWorkspace([userId], requestWorkspaceId(req));
  } catch (error) {
    return res.status(error.statusCode || 400).json({ code: error.code, error: error.message });
  }
  if (restrictedDirectory) {
    const user = await pool.query('SELECT uid FROM users WHERE uid = $1 AND role = $2', [userId, 'admin']);
    if (!user.rows[0]) return res.status(400).json({ error: '초대할 수 없는 사용자입니다.' });
  }
  await pool.query(
    'INSERT INTO chat_room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.params.roomId, userId]
  );
  res.json({ ok: true });
});

app.delete('/api/chat-rooms/:roomId/members/:userId', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const member = await isChatRoomMember(req.params.roomId, req.uid, req);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!canManageChatRoom(room, req)) return res.status(403).json({ error: '생성자 또는 관리자만 멤버를 제외할 수 있습니다.' });
  if (room.creator_id === req.params.userId) return res.status(400).json({ error: '방 생성자는 제외할 수 없습니다.' });
  await pool.query(
    'DELETE FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.params.userId]
  );
  res.json({ ok: true });
});

app.post('/api/chat-rooms/:roomId/action-items/convert', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });

  const { actionMessageId, title, assigneeUid, date, time, note, targetType } = req.body;
  const normalizedTitle = String(title || '').trim();
  const normalizedAssignee = String(assigneeUid || '').trim();
  const normalizedDate = String(date || '').trim();
  const normalizedTime = String(time || '').trim();
  const actionId = parseInt(actionMessageId, 10);

  if (!Number.isInteger(actionId)) return res.status(400).json({ error: '유효한 액션 항목이 필요합니다.' });
  if (!normalizedTitle) return res.status(400).json({ error: '제목이 필요합니다.' });
  if (!normalizedAssignee) return res.status(400).json({ error: '담당자를 선택하세요.' });
  if (!normalizedDate) return res.status(400).json({ error: '날짜를 선택하세요.' });
  if (!['todo', 'meeting'].includes(targetType)) return res.status(400).json({ error: '잘못된 전환 타입입니다.' });

  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });

  const requesterMember = await isChatRoomMember(req.params.roomId, req.uid, req);
  if (!requesterMember) return res.status(403).json({ error: 'Not a member' });

  const manager = canManageChatRoom(room, req);
  if (normalizedAssignee !== req.uid && !manager) {
    return res.status(403).json({ error: '다른 담당자의 일정은 방 생성자 또는 관리자만 등록할 수 있습니다.' });
  }

  const assigneeMember = await isChatRoomMember(req.params.roomId, normalizedAssignee, req);
  if (!assigneeMember) return res.status(400).json({ error: '담당자는 이 채팅방 멤버여야 합니다.' });

  const actionMessage = await pool.query(
    'SELECT * FROM chat WHERE id = $1 AND room_id = $2',
    [actionId, req.params.roomId]
  );
  const actionRow = actionMessage.rows[0];
  if (!actionRow || !String(actionRow.text || '').startsWith('[MEETING_ACTION]')) {
    return res.status(400).json({ error: '회의 액션 메시지를 찾을 수 없습니다.' });
  }

  const actionPayload = parseJsonSafely(String(actionRow.text).slice('[MEETING_ACTION]'.length));
  if (!actionPayload) return res.status(400).json({ error: '액션 메시지 형식이 올바르지 않습니다.' });

  const existingLinks = await pool.query(
    'SELECT text FROM chat WHERE room_id = $1 AND text LIKE $2 ORDER BY created_at DESC LIMIT 100',
    [req.params.roomId, '[MEETING_ACTION_LINK]%']
  );
  const alreadyLinked = existingLinks.rows.some(row => {
    const payload = parseJsonSafely(String(row.text || '').slice('[MEETING_ACTION_LINK]'.length));
    return payload?.actionMsgId === actionId && payload?.targetType === targetType;
  });
  if (alreadyLinked) return res.status(409).json({ error: '이미 전환된 액션입니다.' });

  const assigneeUser = await pool.query(
    'SELECT uid, name, email FROM users WHERE uid = $1 AND approved = true AND COALESCE(is_active, true) = true',
    [normalizedAssignee]
  );
  if (!assigneeUser.rows[0]) return res.status(400).json({ error: '담당자 정보를 찾을 수 없습니다.' });

  const memoLines = [];
  const actionNote = String(note || actionPayload.note || '').trim();
  if (actionNote) memoLines.push(actionNote);
  memoLines.push(`회의방: ${room.name}`);
  memoLines.push(`액션 등록자: ${actionRow.name || req.userName}`);
  memoLines.push(`일정 생성자: ${req.userName}`);

  const eventType = targetType === 'todo' ? 'todo' : 'meeting';
  const createdEvent = await pool.query(
    `INSERT INTO events (workspace_id, type, title, date, time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      requestWorkspaceId(req),
      eventType,
      normalizedTitle,
      normalizedDate,
      targetType === 'meeting' ? normalizedTime : '',
      '',
      memoLines.join('\n'),
      eventType === 'todo' ? '회의액션' : null,
      null,
      'team',
      normalizedAssignee,
      assigneeUser.rows[0].name || assigneeUser.rows[0].email || '담당자',
      null,
      null,
      null
    ]
  );

  const memberIds = await pool.query(
    `SELECT crm.user_id
     FROM chat_room_members crm
     JOIN chat_rooms cr ON cr.id = crm.room_id
     JOIN users u ON u.uid = crm.user_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = crm.user_id
      AND pwm.workspace_id = COALESCE(cr.workspace_id, $2)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE crm.room_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [req.params.roomId, PEAK_WORKSPACE_ID]
  );
  for (const memberRow of memberIds.rows) {
    if (memberRow.user_id === normalizedAssignee) continue;
    await pool.query(
      'INSERT INTO event_shares (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [createdEvent.rows[0].id, memberRow.user_id]
    );
  }

  const linkPayload = {
    actionMsgId: actionId,
    targetType,
    eventId: createdEvent.rows[0].id,
    title: normalizedTitle,
    assigneeUid: normalizedAssignee,
    assigneeName: assigneeUser.rows[0].name || assigneeUser.rows[0].email || '담당자',
    date: normalizedDate,
    time: targetType === 'meeting' ? normalizedTime : ''
  };
  const linkMessage = await insertRoomSystemMessage(
    req.params.roomId,
    req,
    '[MEETING_ACTION_LINK]' + JSON.stringify(linkPayload)
  );

  await notifyChatRoomMembers(
    req.params.roomId,
    req.uid,
    `💬 ${room.name}`,
    targetType === 'todo'
      ? `${normalizedTitle} 할 일이 등록됐습니다`
      : `${normalizedTitle} 일정이 등록됐습니다`
  );

  res.json({ event: createdEvent.rows[0], message: linkMessage, link: linkPayload });
});

// ── 채팅방 나가기 ──────────────────────────────────────────
app.post('/api/chat-rooms/:roomId/leave', authMiddleware, async (req, res) => {
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  await pool.query('DELETE FROM chat_room_members WHERE room_id = $1 AND user_id = $2', [req.params.roomId, req.uid]);
  res.json({ ok: true });
});

app.post('/api/chat-rooms/bulk/request-delete', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const ids = Array.from(new Set((Array.isArray(req.body?.roomIds) ? req.body.roomIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean)))
    .slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: '선택된 채팅방이 없습니다.' });

  const result = await pool.query(
    `SELECT cr.*
     FROM chat_rooms cr
     JOIN chat_room_members crm ON crm.room_id = cr.id AND crm.user_id = $1
     WHERE cr.id = ANY($2::text[])
       AND (cr.workspace_id = $3 OR (cr.workspace_id IS NULL AND $3 = $4))`,
    [req.uid, ids, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  const roomMap = new Map(result.rows.map(room => [String(room.id), room]));
  const forbidden = ids.filter(id => {
    const room = roomMap.get(String(id));
    return !room || room.creator_id !== req.uid;
  });
  if (forbidden.length) return res.status(403).json({ error: '생성자가 아닌 채팅방이 포함되어 있습니다.' });

  await pool.query(
    `UPDATE chat_rooms SET delete_requested = true, delete_requested_by = $1
      WHERE id = ANY($2::text[])
        AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.uid, ids, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json({ ok: true, updated: ids.length });
});

// ── 채팅방 삭제 요청 (생성자만) ──────────────────────────────
app.post('/api/chat-rooms/:roomId/request-delete', authMiddleware, async (req, res) => {
  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (room.creator_id !== req.uid) return res.status(403).json({ error: '생성자만 삭제 요청 가능' });
  await pool.query(
    `UPDATE chat_rooms SET delete_requested = true, delete_requested_by = $1 WHERE id = $2
      AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.uid, req.params.roomId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  res.json({ ok: true });
});

// ── 채팅방 삭제 승인 (admin만) ───────────────────────────────
app.delete('/api/chat-rooms/:roomId', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const room = await getChatRoomById(req.params.roomId, req);
  if (!room) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM chat WHERE room_id = $1', [req.params.roomId]);
  await pool.query('DELETE FROM chat_room_members WHERE room_id = $1', [req.params.roomId]);
  await pool.query('DELETE FROM chat_rooms WHERE id = $1', [req.params.roomId]);
  res.json({ ok: true });
});

app.post('/api/chat-rooms/bulk/delete', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ids = Array.from(new Set((Array.isArray(req.body?.roomIds) ? req.body.roomIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean)))
    .slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: '선택된 채팅방이 없습니다.' });
  const scoped = await pool.query(
    `SELECT id FROM chat_rooms WHERE id = ANY($1::text[])
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [ids, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  const scopedIds = scoped.rows.map(row => row.id);
  if (scopedIds.length !== ids.length) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM chat_room_group_links WHERE room_id = ANY($1::text[])', [scopedIds]);
  await pool.query('DELETE FROM chat WHERE room_id = ANY($1::text[])', [scopedIds]);
  await pool.query('DELETE FROM chat_room_members WHERE room_id = ANY($1::text[])', [scopedIds]);
  await pool.query('DELETE FROM chat_rooms WHERE id = ANY($1::text[])', [scopedIds]);
  res.json({ ok: true, deleted: scopedIds.length });
});

// ── 삭제 요청된 채팅방 목록 (admin) ─────────────────────────
app.get('/api/chat-rooms/delete-requests', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await pool.query(
    `SELECT cr.*, u.name as requester_name
       FROM chat_rooms cr JOIN users u ON cr.delete_requested_by = u.uid
      WHERE cr.delete_requested = true
        AND (cr.workspace_id = $1 OR (cr.workspace_id IS NULL AND $1 = $2))`,
    [requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json(result.rows);
});

// ── 채팅방 삭제 요청 거절 ────────────────────────────────────
app.post('/api/chat-rooms/:roomId/reject-delete', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const updated = await pool.query(
    `UPDATE chat_rooms SET delete_requested = false, delete_requested_by = null WHERE id = $1
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3)) RETURNING id`,
    [req.params.roomId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  if (!updated.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Chat Messages (방별 메시지) ─────────────────────────────
app.get('/api/chat-rooms/:roomId/typing', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  res.json({ users: getLiveChatTypingUsers(req.params.roomId, req.uid) });
});

app.post('/api/chat-rooms/:roomId/typing', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const roomKey = String(req.params.roomId);
  if (req.body?.typing === true) {
    if (!chatTypingState.has(roomKey)) chatTypingState.set(roomKey, new Map());
    chatTypingState.get(roomKey).set(req.uid, {
      name: req.userName || req.userEmail || '사용자',
      expiresAt: Date.now() + CHAT_TYPING_TTL_MS
    });
    setTimeout(() => getLiveChatTypingUsers(roomKey), CHAT_TYPING_TTL_MS + 250);
  } else {
    clearChatTypingUser(roomKey, req.uid);
  }
  res.json({ ok: true });
});

app.get('/api/chat-rooms/:roomId/messages', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  // 멤버인지 확인
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const result = await pool.query(
    `SELECT * FROM (
       SELECT * FROM chat
       WHERE room_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 200
     ) recent_messages
     ORDER BY created_at ASC, id ASC`,
    [req.params.roomId]
  );
  res.json(result.rows);
});

app.post('/api/chat-rooms/:roomId/messages', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '메시지를 입력하세요.' });
  const result = await pool.query(
    'INSERT INTO chat (text, uid, name, photo_url, room_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [text, req.uid, req.userName, req.userPhoto, req.params.roomId]
  );
  // 자동으로 읽음 처리
  await pool.query(
    `INSERT INTO chat_read_status (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_msg_id=$3, last_read_at=NOW()`,
    [req.params.roomId, req.uid, result.rows[0].id]
  );
  // FCM 푸시: 같은 방 멤버에게 알림
  clearChatTypingUser(req.params.roomId, req.uid);
  const members = await pool.query(
    `SELECT crm.user_id, u.name
     FROM chat_room_members crm
     JOIN chat_rooms cr ON cr.id = crm.room_id
     JOIN users u ON u.uid = crm.user_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = crm.user_id
      AND pwm.workspace_id = COALESCE(cr.workspace_id, $3)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE crm.room_id = $1
       AND crm.user_id != $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [req.params.roomId, req.uid, PEAK_WORKSPACE_ID]
  );
  const roomInfo = await pool.query(
    `SELECT name FROM chat_rooms WHERE id = $1
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [req.params.roomId, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  const roomName = roomInfo.rows[0]?.name || '채팅';
  const msgPreview = getChatPreviewText(text || '');
  const mentionedUserIds = new Set(
    members.rows
      .filter(member => chatTextMentionsName(text, member.name))
      .map(member => member.user_id)
  );
  for (const m of members.rows) {
    const isMentioned = mentionedUserIds.has(m.user_id);
    sendPushToUser(
      m.user_id,
      isMentioned ? `@ ${req.userName}님이 회원님을 언급했습니다` : `💬 ${roomName}`,
      isMentioned ? `${roomName} · ${msgPreview}` : `${req.userName}: ${msgPreview}`,
      {
      kind: isMentioned ? 'chat-mention' : 'chat',
      link: `/?page=chat&roomId=${encodeURIComponent(req.params.roomId)}`,
      tag: isMentioned ? `chat-mention-${req.params.roomId}` : `chat-room-${req.params.roomId}`,
      page: 'chat',
      roomId: req.params.roomId,
      messageId: result.rows[0].id,
      mentioned: isMentioned ? 'true' : 'false'
    });
  }
  res.json(result.rows[0]);
});

// 이미지 업로드 메시지
app.post('/api/chat-rooms/:roomId/upload', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image' });
  const imageUrl = '/uploads/' + req.file.filename;
  const result = await pool.query(
    'INSERT INTO chat (text, uid, name, photo_url, room_id, image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    ['', req.uid, req.userName, req.userPhoto, req.params.roomId, imageUrl]
  );
  await pool.query(
    `INSERT INTO chat_read_status (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_msg_id=$3, last_read_at=NOW()`,
    [req.params.roomId, req.uid, result.rows[0].id]
  );
  res.json(result.rows[0]);
});

// 읽음 표시 업데이트
app.post('/api/chat-rooms/:roomId/read', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const lastMsgId = normalizeChatMessageId(req.body?.lastMsgId);
  if (!lastMsgId) return res.status(400).json({ error: '유효한 마지막 메시지가 필요합니다.' });
  const message = await pool.query(
    'SELECT id FROM chat WHERE id = $1 AND room_id = $2',
    [lastMsgId, req.params.roomId]
  );
  if (!message.rows[0]) return res.status(404).json({ error: 'Message not found in this room' });
  await pool.query(
    `INSERT INTO chat_read_status (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (room_id, user_id) DO UPDATE
     SET last_read_msg_id=$3, last_read_at=NOW()`,
    [req.params.roomId, req.uid, lastMsgId]
  );
  res.json({ ok: true });
});

// 메시지별 안 읽은 수 조회
app.get('/api/chat-rooms/:roomId/unread-counts', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  const result = await pool.query(
    `WITH recent_messages AS (
       SELECT id, uid, created_at
       FROM chat
       WHERE room_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 200
     ),
     member_reads AS (
       SELECT crm.user_id,
         COALESCE(crs.last_read_at, '1970-01-01'::timestamptz) AS last_read_at
       FROM chat_room_members crm
       JOIN chat_rooms cr ON cr.id = crm.room_id
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = crm.user_id
        AND pwm.workspace_id = COALESCE(cr.workspace_id, $2)
        AND pwm.active = TRUE
        AND pwm.role <> 'oversight'
       LEFT JOIN chat_read_status crs
         ON crs.room_id = $1 AND crs.user_id = crm.user_id
       WHERE crm.room_id = $1
     )
     SELECT rm.id AS msg_id,
       COUNT(mr.user_id)::int AS unread_count
     FROM recent_messages rm
     LEFT JOIN member_reads mr
       ON mr.user_id != rm.uid
      AND mr.last_read_at < rm.created_at
     GROUP BY rm.id, rm.created_at
     ORDER BY rm.created_at ASC, rm.id ASC`,
    [req.params.roomId, PEAK_WORKSPACE_ID]
  );
  const counts = {};
  result.rows.forEach(r => { counts[r.msg_id] = parseInt(r.unread_count); });
  res.json(counts);
});

// 채팅방 안 읽은 메시지 수
app.get('/api/chat-rooms/unread', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    `WITH my_rooms AS (
       SELECT crm.room_id AS id
       FROM chat_room_members crm
       JOIN chat_rooms cr ON cr.id = crm.room_id
       WHERE crm.user_id = $1
         AND (cr.workspace_id = $2 OR (cr.workspace_id IS NULL AND $2 = $3))
     ),
     last_reads AS (
       SELECT room_id, last_read_at
       FROM chat_read_status
       WHERE user_id = $1
     )
     SELECT mr.id AS room_id,
       COUNT(c.id)::int AS unread
     FROM my_rooms mr
     LEFT JOIN last_reads lr ON lr.room_id = mr.id
     LEFT JOIN chat c
       ON c.room_id = mr.id
      AND c.uid != $1
      AND c.created_at > COALESCE(lr.last_read_at, '1970-01-01'::timestamptz)
     GROUP BY mr.id
     ORDER BY mr.id`,
    [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  const counts = {};
  result.rows.forEach(r => { counts[r.room_id] = parseInt(r.unread); });
  res.json(counts);
});

// ── Event Comments (일정 댓글) ─────────────────────────────
app.get('/api/events/:id/comments', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await canAccessEvent(req, req.params.id))) return res.status(403).json({ error: 'No access' });
  const result = await pool.query(
    'SELECT * FROM event_comments WHERE event_id = $1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(result.rows);
});

app.post('/api/events/:id/comments', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await canAccessEvent(req, req.params.id))) return res.status(403).json({ error: 'No access' });
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  const result = await pool.query(
    'INSERT INTO event_comments (event_id, uid, name, photo_url, text) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.params.id, req.uid, req.userName, req.userPhoto, text.trim()]
  );
  res.json(result.rows[0]);
});

app.delete('/api/events/:eventId/comments/:commentId', authMiddleware, async (req, res) => {
  if (!(await canAccessEvent(req, req.params.eventId))) return res.status(403).json({ error: 'No access' });
  const comment = await pool.query('SELECT * FROM event_comments WHERE id = $1', [req.params.commentId]);
  if (!comment.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && comment.rows[0].uid !== req.uid) return res.status(403).json({ error: 'Not owner' });
  await pool.query('DELETE FROM event_comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
});

// ── 승인된 유저 목록 (채팅방 멤버 초대용) ─────────────────────
app.get('/api/users/all-approved', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.workspace) return res.status(403).json({ code: 'PEAKOS_WORKSPACE_REQUIRED', error: 'Workspace required' });
  // A chat_only user should not see the rest of the member directory
  // when picking who to add to a chat room — only themselves and the
  // admin accounts, so they can at most talk to an admin. The admin
  // can invite whoever they need into the room afterwards.
  if (req.userDoc.chat_only || req.userDoc.external_calendar_only) {
    const result = await pool.query(
      `SELECT u.uid, u.name, u.email, u.photo_url, u.group_id, g.name AS group_name
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = u.uid
        AND pwm.workspace_id = $2
        AND pwm.active = TRUE
        AND pwm.role <> 'oversight'
       WHERE u.approved = true
         AND COALESCE(u.is_active, true) = true
         AND (u.uid = $1 OR u.role = 'admin')
       ORDER BY u.role DESC, u.name`,
      [req.uid, requestWorkspaceId(req)]
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url, u.group_id, g.name AS group_name
     FROM users u
     LEFT JOIN groups g ON g.id = u.group_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = u.uid
      AND pwm.workspace_id = $1
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE u.approved = true AND COALESCE(u.is_active, true) = true
     ORDER BY g.created_at NULLS LAST, u.name`,
    [requestWorkspaceId(req)]
  );
  res.json(result.rows);
});

// ── 파일 첨부 (채팅) ──────────────────────────────────────────
app.post('/api/chat-rooms/:roomId/upload-file', authMiddleware, uploadFile.single('file'), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid, req))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const fileUrl = '/uploads/' + req.file.filename;
  const originalName = decodeMultipartFilename(req.file.originalname);
  const result = await pool.query(
    'INSERT INTO chat (text, uid, name, photo_url, room_id, file_url, file_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    ['', req.uid, req.userName, req.userPhoto, req.params.roomId, fileUrl, originalName]
  );
  res.json(result.rows[0]);
});

// ── 주간 리포트 ───────────────────────────────────────────────
app.get('/api/weekly-report', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const monStr = monday.toISOString().slice(0, 10);
  const sunStr = sunday.toISOString().slice(0, 10);

  try {
    // 이번 주 일정
    let evQuery;
    if (req.userDoc.role === 'admin') {
      evQuery = await pool.query(
        `SELECT * FROM events
          WHERE deleted = false AND date >= $1 AND date <= $2
            AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))
          ORDER BY date, time`,
        [monStr, sunStr, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
      );
    } else if (req.userDoc.role === 'manager') {
      evQuery = await pool.query(
        `SELECT e.*
         FROM events e
         LEFT JOIN users owner_user ON owner_user.uid = e.owner_id
         WHERE e.deleted = false
           AND e.date >= $1 AND e.date <= $2
           AND (e.workspace_id = $5 OR (e.workspace_id IS NULL AND $5 = $6))
           AND (
             e.owner_id = $3
             OR EXISTS (SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $3)
             OR (e.scope = 'team' AND owner_user.group_id = $4)
           )
           AND NOT (e.scope = 'team' AND e.done = true AND e.owner_id <> $3)
         ORDER BY e.date, e.time`,
        [monStr, sunStr, req.uid, req.userDoc.group_id || null, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
      );
    } else {
      evQuery = await pool.query(
        `SELECT e.* FROM events e
         WHERE e.deleted = false
           AND e.date >= $1 AND e.date <= $2
           AND (e.workspace_id = $4 OR (e.workspace_id IS NULL AND $4 = $5))
           AND (e.owner_id = $3 OR EXISTS (
             SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $3
           ))
           AND NOT (e.scope = 'team' AND e.done = true AND e.owner_id <> $3)
         ORDER BY e.date, e.time`,
        [monStr, sunStr, req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
      );
    }
    const weekEvents = evQuery.rows;
    const totalEvents = weekEvents.length;
    const todos = weekEvents.filter(e => e.type === 'todo');
    const doneTodos = todos.filter(e => e.done);
    const meetings = weekEvents.filter(e => e.type === 'meeting');

    // 요일별 그룹
    const days = ['월', '화', '수', '목', '금', '토', '일'];
    const byDay = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      byDay[days[i]] = weekEvents.filter(e => e.date === ds);
    }

    res.json({
      period: monStr + ' ~ ' + sunStr,
      summary: {
        totalEvents,
        totalTodos: todos.length,
        completedTodos: doneTodos.length,
        completionRate: todos.length > 0 ? Math.round(doneTodos.length / todos.length * 100) : 0,
        totalMeetings: meetings.length,
      },
      byDay,
      events: weekEvents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ 보고서 시스템 ══════════════════════════════════════════════

// ── 양식 관리 ─────────────────────────────────────────────────
app.get('/api/report-templates', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query('SELECT * FROM report_templates ORDER BY created_at');
  res.json(result.rows);
});

app.post('/api/report-templates', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name } = req.body;
  const result = await pool.query(
    'INSERT INTO report_templates (name, created_by) VALUES ($1,$2) RETURNING *',
    [name || '일일 보고', req.uid]
  );
  res.json(result.rows[0]);
});

// ── 양식 필드 관리 (유동적 추가/삭제) ──────────────────────────
app.get('/api/report-templates/:tid/fields', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM report_fields WHERE template_id = $1 ORDER BY sort_order, created_at',
    [req.params.tid]
  );
  res.json(result.rows);
});

app.post('/api/report-templates/:tid/fields', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { fieldName, fieldType, fieldGroup, isAmount, sortOrder } = req.body;
  const result = await pool.query(
    'INSERT INTO report_fields (template_id, field_name, field_type, field_group, is_amount, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.params.tid, fieldName, fieldType || 'text', fieldGroup || null, isAmount || false, sortOrder || 0]
  );
  res.json(result.rows[0]);
});

app.delete('/api/report-templates/:tid/fields/:fid', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: '관리자만 삭제할 수 있습니다' });
  await pool.query('DELETE FROM report_fields WHERE id = $1 AND template_id = $2', [req.params.fid, req.params.tid]);
  res.json({ ok: true });
});

// ── 보고 대상(상위자) 관리 ────────────────────────────────────
app.get('/api/report-templates/:tid/viewers', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT rv.*, u.name, u.email FROM report_viewers rv JOIN users u ON rv.viewer_id = u.uid WHERE rv.template_id = $1`,
    [req.params.tid]
  );
  res.json(result.rows);
});

app.post('/api/report-templates/:tid/viewers', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { viewerId } = req.body;
  await pool.query(
    'INSERT INTO report_viewers (template_id, viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.params.tid, viewerId]
  );
  res.json({ ok: true });
});

app.delete('/api/report-templates/:tid/viewers/:vid', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  await pool.query('DELETE FROM report_viewers WHERE template_id = $1 AND viewer_id = $2', [req.params.tid, req.params.vid]);
  res.json({ ok: true });
});

// ── 보고서 작성/조회 ─────────────────────────────────────────
app.get('/api/reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { date, templateId } = req.query;
  let result;
  if (req.userDoc.role === 'admin' || req.userDoc.can_view_all_reports) {
    // admin 또는 전체 보고서 권한: 전체 보고서
    result = await pool.query(
      'SELECT * FROM reports WHERE ($1::text IS NULL OR report_date = $1) AND ($2::text IS NULL OR template_id = $2) ORDER BY report_date DESC, created_at DESC',
      [date || null, templateId || null]
    );
  } else if (req.userDoc.role === 'manager') {
    // manager: 같은 그룹 팀원 보고서
    result = await pool.query(
      `SELECT r.* FROM reports r JOIN users u ON r.author_id = u.uid
       WHERE ($1::text IS NULL OR r.report_date = $1) AND ($2::text IS NULL OR r.template_id = $2)
       AND (r.author_id = $3 OR u.group_id = $4)
       ORDER BY r.report_date DESC, r.created_at DESC`,
      [date || null, templateId || null, req.uid, req.userDoc.group_id]
    );
  } else {
    // member: 본인 보고서만
    result = await pool.query(
      'SELECT * FROM reports WHERE ($1::text IS NULL OR report_date = $1) AND ($2::text IS NULL OR template_id = $2) AND author_id = $3 ORDER BY report_date DESC',
      [date || null, templateId || null, req.uid]
    );
  }
  res.json(result.rows);
});

app.post('/api/reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { templateId, reportDate, entries } = req.body;
  try {
    const report = await pool.query(
      `INSERT INTO reports (template_id, author_id, author_name, report_date)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (template_id, author_id, report_date) DO UPDATE SET status='submitted', created_at=NOW()
       RETURNING *`,
      [templateId, req.uid, req.userName, reportDate]
    );
    const reportId = report.rows[0].id;
    const allFields = await pool.query('SELECT id, is_amount FROM report_fields WHERE template_id = $1', [templateId]);
    const amountFieldById = new Map(allFields.rows.map(f => [String(f.id), f.is_amount]));
    // 기존 entries 삭제 후 재작성
    await pool.query('DELETE FROM report_entries WHERE report_id = $1', [reportId]);
    // 제출된 entries 저장
    const submittedFieldIds = new Set();
    if (entries && entries.length > 0) {
      for (const e of entries) {
        const fieldId = e.fieldId;
        const value = normalizeReportEntryValue(e.value, amountFieldById.get(String(fieldId)));
        await pool.query(
          'INSERT INTO report_entries (report_id, field_id, value) VALUES ($1,$2,$3)',
          [reportId, fieldId, value]
        );
        submittedFieldIds.add(String(fieldId));
      }
    }
    // 빠진 필드 자동 추가 (매출=0, 나머지='')
    for (const f of allFields.rows) {
      if (!submittedFieldIds.has(String(f.id))) {
        await pool.query(
          'INSERT INTO report_entries (report_id, field_id, value) VALUES ($1,$2,$3)',
          [reportId, f.id, f.is_amount ? '0' : '']
        );
      }
    }
    // 일일 보고서 작성 할일 자동 완료
    await pool.query(
      `UPDATE events SET done = true
       WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false
         AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
      [req.uid, reportDate, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
    );

    // admin + 같은 그룹 팀장에게 캘린더 알림
    const targets = await pool.query(
      `SELECT u.uid, u.name
         FROM users u
         JOIN peakos_workspace_memberships pwm
           ON pwm.user_uid = u.uid
          AND pwm.workspace_id = $3
          AND pwm.active = TRUE
          AND pwm.is_default = TRUE
          AND pwm.role <> 'oversight'
        WHERE u.uid != $1
          AND (u.role = 'admin' OR (u.role = 'manager' AND u.group_id = $2))`,
      [req.uid, req.userDoc.group_id, PEAK_WORKSPACE_ID]
    );
    for (const a of targets.rows) {
      const exists = await pool.query(
        `SELECT 1 FROM events
          WHERE type='todo' AND owner_id=$1 AND date=$2 AND title LIKE $3 AND deleted=false
            AND (workspace_id = $4 OR (workspace_id IS NULL AND $4 = $5))`,
        [a.uid, reportDate, `📄 ${req.userName}%보고서%`, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
      );
      if (!exists.rows[0]) {
        await pool.query(
          `INSERT INTO events (workspace_id, type, title, date, scope, owner_id, owner_name, todo_cat)
           VALUES ($1, 'todo', $2, $3, 'personal', $4, $5, '보고서')`,
          [PEAK_WORKSPACE_ID, `📄 ${req.userName} 보고서 확인`, reportDate, a.uid, a.name || '']
        );
      }
    }
    res.json(report.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reports/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { reportDate, entries } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '')) {
    return res.status(400).json({ error: 'Invalid report date' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [req.params.id]);
    const report = existing.rows[0];
    if (!report) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Report not found' });
    }
    if (req.userDoc.role !== 'admin' && report.author_id !== req.uid) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not allowed' });
    }

    const duplicate = await client.query(
      `SELECT id FROM reports
       WHERE template_id = $1 AND author_id = $2 AND report_date = $3 AND id != $4
       LIMIT 1`,
      [report.template_id, report.author_id, reportDate, report.id]
    );
    if (duplicate.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '해당 날짜에 이미 보고서가 있습니다' });
    }

    const updated = await client.query(
      `UPDATE reports SET report_date = $1, status = 'submitted', created_at = NOW()
       WHERE id = $2 RETURNING *`,
      [reportDate, report.id]
    );

    const allFields = await client.query('SELECT id, is_amount FROM report_fields WHERE template_id = $1', [report.template_id]);
    const amountFieldById = new Map(allFields.rows.map(f => [String(f.id), f.is_amount]));
    await client.query('DELETE FROM report_entries WHERE report_id = $1', [report.id]);
    const submittedFieldIds = new Set();
    if (Array.isArray(entries)) {
      for (const e of entries) {
        const fieldId = String(e.fieldId || '');
        if (!amountFieldById.has(fieldId)) continue;
        const value = normalizeReportEntryValue(e.value, amountFieldById.get(fieldId));
        await client.query(
          'INSERT INTO report_entries (report_id, field_id, value) VALUES ($1,$2,$3)',
          [report.id, fieldId, value]
        );
        submittedFieldIds.add(fieldId);
      }
    }
    for (const f of allFields.rows) {
      if (!submittedFieldIds.has(String(f.id))) {
        await client.query(
          'INSERT INTO report_entries (report_id, field_id, value) VALUES ($1,$2,$3)',
          [report.id, f.id, f.is_amount ? '0' : '']
        );
      }
    }

    if (report.report_date !== reportDate) {
      const remainingOldDateReports = await client.query(
        'SELECT 1 FROM reports WHERE author_id = $1 AND report_date = $2 LIMIT 1',
        [report.author_id, report.report_date]
      );
      if (!remainingOldDateReports.rows[0]) {
        await client.query(
          `UPDATE events SET done = false
           WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false
             AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
          [report.author_id, report.report_date, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
        );
      }
    }
    await client.query(
      `UPDATE events SET done = true
       WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false
         AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
      [report.author_id, reportDate, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/reports/:id/entries', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved || req.userDoc?.is_active === false) {
    return res.status(403).json({ error: 'Not approved' });
  }
  const accessParams = [req.params.id];
  let accessClause = '';
  if (req.userDoc.role !== 'admin' && !req.userDoc.can_view_all_reports) {
    accessParams.push(req.uid);
    if (req.userDoc.role === 'manager') {
      accessParams.push(req.userDoc.group_id || null);
      accessClause = `AND (r.author_id = $2 OR u.group_id = $3)`;
    } else {
      accessClause = `AND r.author_id = $2`;
    }
  }
  const accessible = await pool.query(
    `SELECT 1
       FROM reports r
       JOIN users u ON u.uid = r.author_id
      WHERE r.id = $1 ${accessClause}
      LIMIT 1`,
    accessParams,
  );
  // Do not reveal whether an inaccessible report ID exists.
  if (!accessible.rows[0]) return res.status(404).json({ error: 'Report not found' });
  const result = await pool.query(
    `SELECT re.*, rf.field_name, rf.field_type, rf.field_group, rf.is_amount, rf.sort_order
     FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id
     WHERE re.report_id = $1 ORDER BY rf.sort_order`,
    [req.params.id]
  );
  res.json(result.rows);
});

// ── 주간 보고서 요약 ─────────────────────────────────────────
app.get('/api/reports/weekly-summary', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { templateId } = req.query;
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const monStr = monday.toISOString().slice(0, 10);
  const sunStr = sunday.toISOString().slice(0, 10);

  try {
    // 이번 주 보고서 (role 기반 필터)
    let reports;
    if (req.userDoc.role === 'admin') {
      reports = await pool.query(
        'SELECT * FROM reports WHERE template_id = $1 AND report_date >= $2 AND report_date <= $3 ORDER BY author_name, report_date',
        [templateId, monStr, sunStr]
      );
    } else if (req.userDoc.role === 'manager') {
      reports = await pool.query(
        `SELECT r.* FROM reports r JOIN users u ON r.author_id = u.uid
         WHERE r.template_id = $1 AND r.report_date >= $2 AND r.report_date <= $3
         AND (r.author_id = $4 OR u.group_id = $5)
         ORDER BY r.author_name, r.report_date`,
        [templateId, monStr, sunStr, req.uid, req.userDoc.group_id]
      );
    } else {
      reports = await pool.query(
        'SELECT * FROM reports WHERE template_id = $1 AND report_date >= $2 AND report_date <= $3 AND author_id = $4',
        [templateId, monStr, sunStr, req.uid]
      );
    }
    // 금액 필드 집계
    const amountFields = await pool.query(
      'SELECT * FROM report_fields WHERE template_id = $1 AND is_amount = true ORDER BY sort_order',
      [templateId]
    );
    // 팀원별 집계
    const byAuthor = {};
    for (const r of reports.rows) {
      if (!byAuthor[r.author_name]) byAuthor[r.author_name] = { reports: [], totals: {} };
      byAuthor[r.author_name].reports.push(r);
      const entries = await pool.query(
        'SELECT re.*, rf.field_name, rf.is_amount FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id WHERE re.report_id = $1',
        [r.id]
      );
      entries.rows.forEach(e => {
        if (e.is_amount) {
          const val = parseInt(e.value?.replace(/[^0-9]/g, '') || '0');
          byAuthor[r.author_name].totals[e.field_name] = (byAuthor[r.author_name].totals[e.field_name] || 0) + val;
        }
      });
    }
    // 미제출자
    let allUsersQuery;
    if (req.userDoc.role === 'admin') {
      allUsersQuery = await pool.query('SELECT uid, name FROM users WHERE approved = true');
    } else {
      allUsersQuery = await pool.query('SELECT uid, name FROM users WHERE approved = true AND group_id = $1', [req.userDoc.group_id]);
    }
    const submittedUids = [...new Set(reports.rows.map(r => r.author_id))];
    const missing = allUsersQuery.rows.filter(u => !submittedUids.includes(u.uid));

    res.json({
      period: monStr + ' ~ ' + sunStr,
      totalReports: reports.rows.length,
      byAuthor,
      amountFields: amountFields.rows,
      missingUsers: missing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PEAK OS 보고서 매출 집계 (읽기 전용 조회 전용, 기간·단위별)
const SALES_SUMMARY_BUCKETS = {
  day: `r.report_date`,
  week: `to_char(date_trunc('week', r.report_date::date), 'YYYY-MM-DD')`,
  month: `substr(r.report_date, 1, 7)`,
  quarter: `to_char(date_trunc('quarter', r.report_date::date), 'YYYY"Q"Q')`,
};
// 금액 문자열에서 숫자만 남긴 값. 콤마·"원" 표기가 섞여 있어 파라곤 집계와 동일하게 정규화한다.
const SALES_AMOUNT_DIGITS = `regexp_replace(re.value, '[^0-9]', '', 'g')`;
const SALES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftDate(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

// 계정 권한에 따라 조회 가능한 보고서 범위를 좁힌다. 전체 범위는 legacy
// role 문자열이 아니라 startup에서 exact UID로 고정한 정책만 허용한다.
function salesSummaryScope(req, params) {
  if (peakosCanSeeAll(req)) {
    return { clause: '', scope: 'all' };
  }
  if (req.workspace?.role === 'manager') {
    params.push(req.uid, req.userDoc.group_id);
    return { clause: ` AND (r.author_id = $${params.length - 1} OR u.group_id = $${params.length})`, scope: 'group' };
  }
  params.push(req.uid);
  return { clause: ` AND r.author_id = $${params.length}`, scope: 'self' };
}

function peakosReportPreviewRequest(req) {
  const header = name => String(req.get?.(name) || req.headers?.[name.toLowerCase()] || '').trim();
  return /^(?:1|true|yes|on)$/i.test(header('x-peakos-preview'))
    || Boolean(header('x-peakos-preview-persona') || header('x-peakos-preview-owner'));
}

async function handlePeakosSalesSummary(req, res) {
  if (!req.userDoc?.approved || req.userDoc?.is_active === false
      || req.userDoc?.chat_only === true || req.userDoc?.external_calendar_only === true) {
    return res.status(403).json({ code: 'REPORT_ACCOUNT_RESTRICTED', error: '승인된 일반 계정만 보고 매출을 볼 수 있습니다.' });
  }
  if (peakosReportPreviewRequest(req)) {
    return res.status(403).json({ code: 'REPORT_PREVIEW_FORBIDDEN', error: '계정 미리보기에서는 보고 매출을 불러오지 않습니다.' });
  }

  const bucket = String(req.query.bucket || 'month');
  const bucketExpr = Object.prototype.hasOwnProperty.call(SALES_SUMMARY_BUCKETS, bucket)
    ? SALES_SUMMARY_BUCKETS[bucket]
    : null;
  if (!bucketExpr) return res.status(400).json({ error: '지원하지 않는 집계 단위입니다.' });

  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!SALES_DATE_PATTERN.test(from) || !SALES_DATE_PATTERN.test(to) || from > to) {
    return res.status(400).json({ error: '조회 기간이 올바르지 않습니다.' });
  }

  try {
    // 기간·금액 필드 공통 조건. is_amount 항목만 매출로 보고, 수금액·미수잔액 등은 제외된다.
    const baseWhere = `WHERE r.report_date BETWEEN $1 AND $2
        AND r.report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
    const amountJoin = `JOIN report_entries re ON re.report_id = r.id
      JOIN report_fields rf ON rf.id = re.field_id AND rf.is_amount = true`;
    const amountWhere = ` AND length(${SALES_AMOUNT_DIGITS}) BETWEEN 1 AND 15`;

    const amountParams = [from, to];
    const amountScope = salesSummaryScope(req, amountParams);
    const amounts = await pool.query(
      `SELECT r.author_id,
              r.author_name,
              COALESCE(g.name, '(미지정)') AS group_name,
              ${bucketExpr} AS bucket_key,
              COALESCE(SUM(${SALES_AMOUNT_DIGITS}::bigint), 0) AS amount
       FROM reports r
       JOIN users u ON u.uid = r.author_id
       LEFT JOIN groups g ON g.id = u.group_id
       ${amountJoin}
       ${baseWhere}${amountWhere}${amountScope.clause}
       GROUP BY 1, 2, 3, 4`,
      amountParams
    );

    const countParams = [from, to];
    const countScope = salesSummaryScope(req, countParams);
    const counts = await pool.query(
      `SELECT r.author_id, ${bucketExpr} AS bucket_key, COUNT(*)::int AS report_count
       FROM reports r
       JOIN users u ON u.uid = r.author_id
       ${baseWhere}${countScope.clause}
       GROUP BY 1, 2`,
      countParams
    );

    const fieldParams = [from, to];
    const fieldScope = salesSummaryScope(req, fieldParams);
    const fields = await pool.query(
      `SELECT rf.field_name, COALESCE(SUM(${SALES_AMOUNT_DIGITS}::bigint), 0) AS amount
       FROM reports r
       JOIN users u ON u.uid = r.author_id
       ${amountJoin}
       ${baseWhere}${amountWhere}${fieldScope.clause}
       GROUP BY 1
       HAVING SUM(${SALES_AMOUNT_DIGITS}::bigint) > 0
       ORDER BY 2 DESC`,
      fieldParams
    );

    // 전기 대비: 조회 기간과 같은 길이의 직전 구간
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    const prevTo = shiftDate(from, -1);
    const prevFrom = shiftDate(prevTo, -(spanDays - 1));
    const prevParams = [prevFrom, prevTo];
    const prevScope = salesSummaryScope(req, prevParams);
    const previous = await pool.query(
      `SELECT COALESCE(SUM(${SALES_AMOUNT_DIGITS}::bigint), 0) AS amount
       FROM reports r
       JOIN users u ON u.uid = r.author_id
       ${amountJoin}
       ${baseWhere}${amountWhere}${prevScope.clause}`,
      prevParams
    );

    const bucketKeys = [...new Set([
      ...amounts.rows.map(row => row.bucket_key),
      ...counts.rows.map(row => row.bucket_key),
    ])].sort();

    const authorMap = new Map();
    const ensureAuthor = (authorId, authorName, groupName) => {
      if (!authorMap.has(authorId)) {
        authorMap.set(authorId, {
          authorId,
          name: authorName || '이름 없음',
          groupName: groupName || '(미지정)',
          total: 0,
          reportCount: 0,
          amounts: {},
          reportCounts: {},
        });
      }
      return authorMap.get(authorId);
    };

    amounts.rows.forEach(row => {
      const author = ensureAuthor(row.author_id, row.author_name, row.group_name);
      const amount = Number(row.amount) || 0;
      author.amounts[row.bucket_key] = (author.amounts[row.bucket_key] || 0) + amount;
      author.total += amount;
    });
    counts.rows.forEach(row => {
      const author = ensureAuthor(row.author_id, row.author_name, null);
      author.reportCounts[row.bucket_key] = (author.reportCounts[row.bucket_key] || 0) + row.report_count;
      author.reportCount += row.report_count;
    });

    const authors = [...authorMap.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'));
    const groupMap = new Map();
    authors.forEach(author => {
      const current = groupMap.get(author.groupName) || { name: author.groupName, total: 0, amounts: {} };
      current.total += author.total;
      bucketKeys.forEach(key => {
        current.amounts[key] = (current.amounts[key] || 0) + (author.amounts[key] || 0);
      });
      groupMap.set(author.groupName, current);
    });

    const totalAmount = authors.reduce((sum, author) => sum + author.total, 0);
    const totalReports = authors.reduce((sum, author) => sum + author.reportCount, 0);
    const previousAmount = Number(previous.rows[0]?.amount) || 0;

    res.json({
      from,
      to,
      bucket,
      scope: amountScope.scope,
      bucketKeys,
      authors,
      groups: [...groupMap.values()].sort((a, b) => b.total - a.total),
      fields: fields.rows.map(row => ({ name: row.field_name, amount: Number(row.amount) || 0 })),
      totals: {
        amount: totalAmount,
        reportCount: totalReports,
        authorCount: authors.length,
      },
      previous: {
        from: prevFrom,
        to: prevTo,
        amount: previousAmount,
        changeRate: previousAmount > 0 ? (totalAmount - previousAmount) / previousAmount : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 미제출 체크
app.get('/api/reports/missing-today', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const today = new Date().toISOString().slice(0, 10);
  const { templateId } = req.query;
  const submitted = await pool.query(
    'SELECT author_id FROM reports WHERE template_id = $1 AND report_date = $2',
    [templateId, today]
  );
  const submittedIds = submitted.rows.map(r => r.author_id);
  const allUsers = await pool.query('SELECT uid, name, email FROM users WHERE approved = true');
  const missing = allUsers.rows.filter(u => !submittedIds.includes(u.uid));
  res.json(missing);
});

// ══ 그룹 관리 ═════════════════════════════════════════════════
app.get('/api/groups', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM groups ORDER BY created_at');
  res.json(result.rows);
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, groupType, showSalesReport } = req.body;
  const result = await pool.query(
    'INSERT INTO groups (name, group_type, show_sales_report) VALUES ($1,$2,$3) RETURNING *',
    [name, groupType || 'sales', showSalesReport !== false]
  );
  res.json(result.rows[0]);
});

app.put('/api/users/:uid/group', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { groupId, workspaceSlug } = req.body;
  const membershipClient = await pool.connect();
  try {
    await membershipClient.query('BEGIN');
    await membershipClient.query('UPDATE users SET group_id = $1 WHERE uid = $2', [groupId, req.params.uid]);
    const membership = await peakosWorkspaceService.syncUserDefaultMembership({
      actorUid: req.uid,
      targetUid: req.params.uid,
      groupId,
      workspaceSlug,
      client: membershipClient,
    });
    await membershipClient.query('COMMIT');
    res.json({ ok: true, workspace: membership });
  } catch (err) {
    await membershipClient.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  } finally {
    membershipClient.release();
  }
});

app.put('/api/users/:uid/permissions', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { canViewAllAttendance, canViewAllReports, canManageTeam, viewableGroups } = req.body;
  await pool.query(
    'UPDATE users SET can_view_all_attendance=COALESCE($1,can_view_all_attendance), can_view_all_reports=COALESCE($2,can_view_all_reports), can_manage_team=COALESCE($3,can_manage_team), viewable_groups=COALESCE($4,viewable_groups) WHERE uid=$5',
    [canViewAllAttendance, canViewAllReports, canManageTeam, viewableGroups||null, req.params.uid]
  );
  res.json({ ok: true });
});

app.put('/api/users/:uid/deactivate', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET is_active = false, approved = false WHERE uid = $1', [req.params.uid]);
    await peakosWorkspaceService.setUserMembershipsActive({
      actorUid: req.uid,
      targetUid: req.params.uid,
      active: false,
      client,
    });
    await client.query('DELETE FROM fcm_tokens WHERE user_uid = $1', [req.params.uid]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/users/:uid/activate', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET is_active = true, approved = true WHERE uid = $1', [req.params.uid]);
    const membership = await peakosWorkspaceService.syncUserDefaultMembership({
      actorUid: req.uid,
      targetUid: req.params.uid,
      client,
    });
    await peakosWorkspaceService.setUserMembershipsActive({
      actorUid: req.uid,
      targetUid: req.params.uid,
      active: true,
      client,
    });
    await client.query('COMMIT');
    res.json({ ok: true, workspace: membership });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/users/:uid/role', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { role } = req.body;
  if (!['member','manager','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET role = $1 WHERE uid = $2', [role, req.params.uid]);
    const membership = await peakosWorkspaceService.syncUserDefaultMembership({
      actorUid: req.uid,
      targetUid: req.params.uid,
      role,
      client,
    });
    await client.query('COMMIT');
    res.json({ ok: true, workspace: membership });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  } finally {
    client.release();
  }
});

// Toggle chat-only restriction. A chat_only user's client hides every
// non-chat page; this endpoint persists the flag and the paired server
// guard below also denies non-chat API paths so the policy can't be
// sidestepped by calling the API directly.
app.put('/api/users/:uid/chat-only', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const chatOnly = !!req.body?.chatOnly;
  try {
    await peakosWorkspaceService.setUserRestrictionMode({
      actorUid: req.uid,
      targetUid: req.params.uid,
      mode: 'chat_only',
      enabled: chatOnly,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  }
});

app.put('/api/users/:uid/external-calendar-only', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const externalCalendarOnly = !!req.body?.externalCalendarOnly;
  try {
    await peakosWorkspaceService.setUserRestrictionMode({
      actorUid: req.uid,
      targetUid: req.params.uid,
      mode: 'external_calendar_only',
      enabled: externalCalendarOnly,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ code: err.code, error: err.message });
  }
});

// ══ 출근 보고서 ═══════════════════════════════════════════════
// Legacy calendar URLs and the PEAK OS module share one tenant-scoped service.
// In particular, a client-supplied userId is authorized by workspace role
// before SQL, so ordinary users cannot read another employee's attendance.
app.get('/api/attendance', authMiddleware, legacyAttendanceHandlers.list);
app.post('/api/attendance/check-in', authMiddleware, legacyAttendanceHandlers.checkIn);
app.post('/api/attendance/check-out', authMiddleware, legacyAttendanceHandlers.checkOut);
app.get('/api/attendance/details', authMiddleware, legacyAttendanceHandlers.details);
app.get('/api/attendance/monthly-summary', authMiddleware, legacyAttendanceHandlers.summary);

// ══ 프로젝트 ══════════════════════════════════════════════════
app.get('/api/projects', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const params = [requestWorkspaceId(req), PEAK_WORKSPACE_ID];
  let where = `COALESCE(pd.deleted, false) = false
    AND p.status IS DISTINCT FROM 'archived'
    AND (p.workspace_id = $1 OR (p.workspace_id IS NULL AND $1 = $2))`;
  if (req.userDoc.role !== 'admin' && !req.workspace?.headquartersOversight) {
    params.push(req.uid);
    where += ` AND (p.owner_id = $${params.length} OR EXISTS (
      SELECT 1 FROM project_members pmx WHERE pmx.project_id = p.id AND pmx.user_id = $${params.length}
    ))`;
  }
  const result = await pool.query(
    `SELECT p.*,
            COALESCE(pd.owner_name, owner_user.name, '') AS owner_name,
            COALESCE(pd.deadline, '') AS deadline,
            COALESCE(pd.updated_at, p.created_at) AS updated_at,
            COALESCE(pd.deleted, false) AS deleted,
            pd.completed_at,
            COUNT(DISTINCT pm.user_id)::int AS member_count,
            COUNT(DISTINCT pt.id)::int AS task_count,
            COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'done')::int AS done_task_count,
            COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'review')::int AS review_task_count,
            COUNT(DISTINCT pt.id) FILTER (
              WHERE pt.status <> 'done'
                AND pt.due_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
                AND pt.due_date < TO_CHAR(NOW() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
            )::int AS overdue_task_count,
            COUNT(DISTINCT pc.id) FILTER (WHERE pc.deleted = false)::int AS comment_count,
            MAX(pc.created_at) FILTER (WHERE pc.deleted = false) AS last_comment_at,
            COALESCE(STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name), '') AS member_names
     FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     LEFT JOIN users owner_user ON owner_user.uid = p.owner_id
     LEFT JOIN project_members pm
       ON pm.project_id = p.id
      AND EXISTS (
        SELECT 1 FROM peakos_workspace_memberships pwm
        WHERE pwm.user_uid = pm.user_id
          AND pwm.workspace_id = COALESCE(p.workspace_id, $2)
          AND pwm.active = TRUE
          AND pwm.role <> 'oversight'
      )
     LEFT JOIN users u ON u.uid = pm.user_id
     LEFT JOIN project_tasks pt ON pt.project_id = p.id
     LEFT JOIN project_comments pc ON pc.project_id = p.id
     WHERE ${where}
     GROUP BY p.id, pd.project_id, owner_user.name
     ORDER BY
       CASE p.status
         WHEN 'active' THEN 1
         WHEN 'review' THEN 2
         WHEN 'planning' THEN 3
         WHEN 'hold' THEN 4
         WHEN 'done' THEN 5
         ELSE 6
       END,
       COALESCE(pd.updated_at, p.created_at) DESC NULLS LAST,
       p.created_at DESC`,
    params
  );
  res.json({
    canManageAll: req.userDoc.role === 'admin' && !req.workspace?.headquartersOversight,
    readOnly: req.workspace?.headquartersOversight === true,
    projects: result.rows,
  });
});

app.post('/api/projects', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const name = String(req.body.name || '').trim().slice(0, 160);
  const description = String(req.body.description || '').trim().slice(0, 5000);
  const deadline = String(req.body.deadline || '').trim().slice(0, 10);
  const status = normalizeProjectStatus(req.body.status);
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  if (!name) return res.status(400).json({ error: '프로젝트명을 입력하세요' });
  try {
    const uniqueMemberIds = [...new Set(memberIds.map(uid => String(uid || '').trim()).filter(Boolean))];
    await peakosWorkspaceService.assertUsersInWorkspace(uniqueMemberIds, requestWorkspaceId(req));
    const id = crypto.randomUUID();
    const project = await pool.query(
      `INSERT INTO projects (workspace_id, id, name, description, owner_id, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [requestWorkspaceId(req), id, name, description, req.uid, status]
    );
    await pool.query(
      `INSERT INTO project_details (project_id, owner_name, deadline, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (project_id) DO UPDATE SET owner_name=EXCLUDED.owner_name, deadline=EXCLUDED.deadline, updated_at=NOW()`,
      [id, req.userName || req.userEmail || '사용자', deadline]
    );
    await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, req.uid]);
    for (const uid of uniqueMemberIds) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_id)
         SELECT $1, uid FROM users
         WHERE uid = $2 AND approved = true AND COALESCE(is_active, true) = true
         ON CONFLICT DO NOTHING`,
        [id, uid]
      );
    }
    await notifyProjectMembers(
      id,
      req.uid,
      '새 프로젝트',
      `${req.userName || req.userEmail || '사용자'}님이 "${name}" 프로젝트에 초대했습니다.`,
      { link: `/?page=project&projectId=${id}` }
    );
    let meetingEvent = null;
    if (req.body.meeting && req.body.meeting.date) {
      meetingEvent = await createProjectMeetingEvent(id, req, {
        ...req.body.meeting,
        title: req.body.meeting.title || `${name} 회의`
      });
    }
    res.json({ ...project.rows[0], meetingEvent });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

app.get('/api/projects/my-tasks', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.workspace) {
    return res.status(403).json({ code: 'PEAKOS_WORKSPACE_REQUIRED', error: 'Workspace required' });
  }
  // 본사 열람 계정은 지사 프로젝트 전체를 읽을 수 있지만 지사 업무의
  // 담당자가 될 수는 없다. "프로젝트 할 일" 응답도 그 경계를 그대로 지킨다.
  if (req.workspace.headquartersOversight === true) {
    return res.json({ readOnly: true, tasks: [] });
  }

  const isAdmin = req.userDoc.role === 'admin';
  const isManager = req.userDoc.role === 'manager';
  try {
    const result = await pool.query(
      `SELECT
         pt.*,
         p.name AS project_name,
         p.status AS project_status,
         COALESCE(pd.owner_name, owner_user.name, '') AS project_owner_name,
         MAX(p.owner_id) AS project_owner_uid,
         COALESCE(
           NULLIF(MAX(pt.assigned_by_name), ''),
           MAX(task_creator.name),
           MAX(task_reviewer.name),
           ''
         ) AS creator_name,
         COALESCE(MAX(task_reviewer.name), '') AS reviewer_directory_name,
         TRUE AS is_assignee,
         COALESCE(
           JSONB_AGG(
             JSONB_BUILD_OBJECT(
               'uid', pta.user_uid,
               'name', pta.user_name,
               'completed', pta.completed,
               'completedAt', pta.completed_at
             )
             ORDER BY pta.user_name
           ) FILTER (WHERE pta.user_uid IS NOT NULL),
           '[]'::jsonb
         ) AS assignees,
         COUNT(pta.user_uid)::int AS assignee_count,
         COUNT(pta.user_uid) FILTER (WHERE pta.completed)::int AS completed_assignee_count,
         ($4::boolean OR p.owner_id = $1 OR $5::boolean) AS can_direct_tasks,
         ($4::boolean OR p.owner_id = $1 OR pt.reviewer_uid = $1) AS can_review_task
       FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id
       LEFT JOIN project_details pd ON pd.project_id = p.id
       LEFT JOIN users owner_user ON owner_user.uid = p.owner_id
       LEFT JOIN users task_creator ON task_creator.uid = pt.created_by
       LEFT JOIN users task_reviewer ON task_reviewer.uid = COALESCE(pt.reviewer_uid, p.owner_id)
       JOIN project_members current_project_member
         ON current_project_member.project_id = p.id
        AND current_project_member.user_id = $1
       JOIN peakos_workspace_memberships current_workspace_member
         ON current_workspace_member.user_uid = $1
        AND current_workspace_member.workspace_id = COALESCE(p.workspace_id, $3)
        AND current_workspace_member.active = TRUE
        AND current_workspace_member.role <> 'oversight'
       LEFT JOIN project_task_assignees pta
         ON pta.task_id = pt.id
        AND pta.project_id = p.id
        AND EXISTS (
          SELECT 1
          FROM peakos_workspace_memberships assignee_workspace_member
          WHERE assignee_workspace_member.user_uid = pta.user_uid
            AND assignee_workspace_member.workspace_id = COALESCE(p.workspace_id, $3)
            AND assignee_workspace_member.active = TRUE
            AND assignee_workspace_member.role <> 'oversight'
        )
       WHERE COALESCE(pd.deleted, false) = false
         AND p.status IS DISTINCT FROM 'archived'
         AND (p.workspace_id = $2 OR (p.workspace_id IS NULL AND $2 = $3))
         AND (
           pt.assignee_uid = $1
           OR EXISTS (
             SELECT 1
             FROM project_task_assignees mine
             WHERE mine.project_id = p.id
               AND mine.task_id = pt.id
               AND mine.user_uid = $1
           )
         )
       GROUP BY pt.id, p.id, pd.project_id, owner_user.uid
       ORDER BY
         CASE pt.status
           WHEN 'review' THEN 1
           WHEN 'doing' THEN 2
           WHEN 'todo' THEN 3
           WHEN 'hold' THEN 4
           WHEN 'done' THEN 5
           ELSE 6
         END,
         CASE
           WHEN pt.due_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN pt.due_date
           ELSE '9999-12-31'
         END,
         p.name,
         pt.sort_order,
         pt.created_at`,
      [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID, isAdmin, isManager]
    );

    const tasks = result.rows.map(row => {
      const {
        project_name: projectName,
        project_status: projectStatus,
        project_owner_name: projectOwnerName,
        project_owner_uid: projectOwnerUid,
        reviewer_directory_name: reviewerDirectoryName,
        can_direct_tasks: canDirectTasks,
        can_review_task: canReviewTask,
        ...task
      } = row;
      return {
        project: {
          id: task.project_id,
          name: projectName,
          status: projectStatus,
          owner_name: projectOwnerName,
        },
        task: {
          ...task,
          is_assignee: true,
          reviewer_uid: task.reviewer_uid || projectOwnerUid || null,
          reviewer_name: task.reviewer_name || reviewerDirectoryName || '',
          permissions: {
            canEdit: canDirectTasks === true,
            canSetDeadline: canDirectTasks === true,
            canDelete: canDirectTasks === true,
            canReview: canReviewTask === true && task.status === 'review',
            canRequestReview: task.assignment_mode !== 'all'
              && ['todo', 'doing'].includes(task.status),
            canComplete: task.assignment_mode === 'all'
              && ['todo', 'doing'].includes(task.status),
          },
        },
      };
    });
    return res.json({ readOnly: false, tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const result = await pool.query(
    `SELECT p.*,
            COALESCE(pd.owner_name, u.name, '') AS owner_name,
            COALESCE(pd.deadline, '') AS deadline,
            COALESCE(pd.updated_at, p.created_at) AS updated_at,
            COALESCE(pd.deleted, false) AS deleted,
            pd.completed_at
     FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     LEFT JOIN users u ON u.uid = p.owner_id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.workspace_id = $2 OR (p.workspace_id IS NULL AND $2 = $3))`,
    [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  const members = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url,
            CASE WHEN u.uid = p.owner_id OR u.role = 'manager' THEN 'manager' ELSE 'member' END AS role
     FROM project_members pm
     JOIN users u ON pm.user_id = u.uid
     JOIN projects p ON p.id = pm.project_id
     JOIN peakos_workspace_memberships pwm
       ON pwm.user_uid = pm.user_id
      AND pwm.workspace_id = COALESCE(p.workspace_id, $2)
      AND pwm.active = TRUE
      AND pwm.role <> 'oversight'
     WHERE pm.project_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true
     ORDER BY CASE WHEN u.uid = p.owner_id THEN 0 ELSE 1 END, u.name`,
    [req.params.id, PEAK_WORKSPACE_ID]
  );
  const tasks = await pool.query(
    `SELECT
       pt.*,
       COALESCE(NULLIF(MAX(pt.assigned_by_name), ''), MAX(task_creator.name), MAX(task_reviewer.name), '') AS creator_name,
       MAX(task_project.owner_id) AS project_owner_uid,
       COALESCE(MAX(task_reviewer.name), '') AS reviewer_directory_name,
       (
         COALESCE(pt.assignee_uid = $3, false)
         OR COALESCE(BOOL_OR(pta.user_uid = $3), false)
       ) AS is_assignee,
       COALESCE(
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'uid', pta.user_uid,
             'name', pta.user_name,
             'completed', pta.completed,
             'completedAt', pta.completed_at
           )
           ORDER BY pta.user_name
         ) FILTER (WHERE pta.user_uid IS NOT NULL),
         '[]'::jsonb
       ) AS assignees,
       COUNT(pta.user_uid)::int AS assignee_count,
       COUNT(pta.user_uid) FILTER (WHERE pta.completed)::int AS completed_assignee_count
     FROM project_tasks pt
     JOIN projects task_project ON task_project.id = pt.project_id
     LEFT JOIN users task_creator ON task_creator.uid = pt.created_by
     LEFT JOIN users task_reviewer ON task_reviewer.uid = COALESCE(pt.reviewer_uid, task_project.owner_id)
     LEFT JOIN project_task_assignees pta
       ON pta.task_id = pt.id
      AND EXISTS (
        SELECT 1 FROM peakos_workspace_memberships pwm
        WHERE pwm.user_uid = pta.user_uid
          AND pwm.workspace_id = COALESCE(task_project.workspace_id, $2)
          AND pwm.active = TRUE
          AND pwm.role <> 'oversight'
      )
     WHERE pt.project_id = $1
     GROUP BY pt.id
     ORDER BY pt.sort_order, pt.created_at`,
    [req.params.id, PEAK_WORKSPACE_ID, req.uid]
  );
  const updates = await pool.query(
    'SELECT * FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  const comments = await pool.query(
    'SELECT * FROM project_comments WHERE project_id = $1 AND deleted = false ORDER BY created_at ASC',
    [req.params.id]
  );
  const taskComments = await pool.query(
    'SELECT * FROM project_task_comments WHERE project_id = $1 AND deleted = false ORDER BY created_at ASC',
    [req.params.id]
  );
  const taskWorkflowEvents = await pool.query(
    `SELECT id, project_id, task_id, action, actor_uid, actor_name, note,
            from_status, to_status, due_date_snapshot, workflow_version, created_at
     FROM project_task_workflow_events
     WHERE project_id = $1
     ORDER BY created_at ASC, id ASC`,
    [req.params.id]
  );
  const events = await pool.query(
    `SELECT * FROM events
      WHERE project_id = $1 AND deleted = false
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
        ${eventHiddenPredicate(req, { eventAlias: 'events', workspaceParameter: 2 })}
      ORDER BY date`,
    [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  const canManage = await canManageProject(req, req.params.id);
  const canDirectTasks = await canDirectProjectTasks(req, req.params.id);
  const canCreateTasks = req.workspace?.headquartersOversight !== true;
  const taskRows = tasks.rows.map(task => {
    const { project_owner_uid: projectOwnerUid, reviewer_directory_name: reviewerDirectoryName, ...publicTask } = task;
    const taskWithOwner = { ...task, project_owner_uid: projectOwnerUid };
    const canReview = canReviewProjectTask(req, taskWithOwner);
    return {
      ...publicTask,
      reviewer_uid: task.reviewer_uid || projectOwnerUid || null,
      reviewer_name: task.reviewer_name || reviewerDirectoryName || '',
      permissions: {
        canEdit: canDirectTasks,
        canSetDeadline: canDirectTasks,
        canDelete: canDirectTasks,
        canReview: canReview && task.status === 'review',
        canRequestReview: task.is_assignee === true
          && task.assignment_mode !== 'all'
          && ['todo', 'doing'].includes(task.status),
        canComplete: task.is_assignee === true
          && task.assignment_mode === 'all'
          && ['todo', 'doing'].includes(task.status),
      },
    };
  });
  res.json({
    ...result.rows[0],
    canManage,
    canCreateTasks,
    canDirectTasks,
    members: members.rows,
    tasks: taskRows,
    updates: updates.rows,
    comments: comments.rows,
    taskComments: taskComments.rows,
    taskWorkflowEvents: taskWorkflowEvents.rows,
    events: events.rows
  });
});

app.put('/api/projects/:id', authMiddleware, async (req, res) => {
  if (!await canManageProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  try {
    const sets = [];
    const params = [req.params.id];
    const addSet = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 160);
      if (!name) return res.status(400).json({ error: '프로젝트명을 입력하세요' });
      addSet('name', name);
    }
    if (req.body.description !== undefined) addSet('description', String(req.body.description || '').trim().slice(0, 5000));
    if (req.body.status !== undefined) {
      const status = normalizeProjectStatus(req.body.status);
      addSet('status', status);
    }
    let result;
    if (sets.length) {
      params.push(requestWorkspaceId(req), PEAK_WORKSPACE_ID);
      const workspaceParam = params.length - 1;
      const peakParam = params.length;
      result = await pool.query(
        `UPDATE projects SET ${sets.join(', ')}
         WHERE id = $1 AND status IS DISTINCT FROM 'archived'
           AND (workspace_id = $${workspaceParam} OR (workspace_id IS NULL AND $${workspaceParam} = $${peakParam}))
         RETURNING *`,
        params
      );
    } else {
      result = await pool.query(
        `SELECT * FROM projects WHERE id = $1 AND status IS DISTINCT FROM 'archived'
          AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
        [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
      );
    }
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.body.deadline !== undefined || req.body.status !== undefined) {
      const deadline = String(req.body.deadline ?? '').trim().slice(0, 10);
      const completedAt = normalizeProjectStatus(req.body.status) === 'done' ? new Date() : null;
      await pool.query(
        `INSERT INTO project_details (project_id, deadline, completed_at, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (project_id) DO UPDATE
         SET deadline = CASE WHEN $4::boolean THEN EXCLUDED.deadline ELSE project_details.deadline END,
             completed_at = CASE WHEN $5::boolean THEN EXCLUDED.completed_at ELSE project_details.completed_at END,
             updated_at = NOW()`,
        [req.params.id, deadline, completedAt, req.body.deadline !== undefined, req.body.status !== undefined]
      );
    } else {
      await touchProject(req.params.id);
    }

    if (Array.isArray(req.body.memberIds)) {
      const memberIds = [...new Set(req.body.memberIds.map(uid => String(uid || '').trim()).filter(Boolean))];
      if (!memberIds.includes(result.rows[0].owner_id)) memberIds.push(result.rows[0].owner_id);
      await peakosWorkspaceService.assertUsersInWorkspace(memberIds, requestWorkspaceId(req));
      await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id <> $2', [req.params.id, result.rows[0].owner_id]);
      for (const uid of memberIds) {
        await pool.query(
          `INSERT INTO project_members (project_id, user_id)
           SELECT $1, uid FROM users
           WHERE uid = $2 AND approved = true AND COALESCE(is_active, true) = true
           ON CONFLICT DO NOTHING`,
          [req.params.id, uid]
        );
      }
    }
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/projects/:id', authMiddleware, async (req, res) => {
  if (!await canManageProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  await pool.query("UPDATE projects SET status = 'archived' WHERE id = $1", [req.params.id]);
  await pool.query("UPDATE events SET deleted = true WHERE project_id = $1", [req.params.id]);
  await pool.query(
    `INSERT INTO project_details (project_id, deleted, updated_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (project_id) DO UPDATE SET deleted=true, updated_at=NOW()`,
    [req.params.id]
  );
  res.json({ ok: true });
});

app.post('/api/projects/:id/events', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const eventId = String(req.body?.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Event required' });
  // Linking changes the event row itself. Project membership must not let a
  // caller attach an unrelated private event whose ID they happen to know.
  if (!(await canAccessEvent(req, eventId, { requireOwner: true }))) {
    return res.status(403).json({ error: 'Not authorized to modify this event' });
  }
  // A personal checklist directive belongs to the Todo instructor inbox. The
  // lock and the directive check intentionally use two statements: under
  // READ COMMITTED the second statement gets a fresh snapshot after any
  // concurrent directive transaction that held the event row has committed.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      'SELECT id FROM events WHERE id = $1 AND deleted = FALSE FOR UPDATE',
      [eventId],
    );
    if (!target.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const directive = await client.query(
      'SELECT 1 FROM peakos_event_checklist_directives WHERE event_id = $1 LIMIT 1',
      [eventId],
    );
    if (directive.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'PROJECT_EVENT_DIRECTIVE_CONFLICT',
        error: '지시자가 지정된 체크리스트를 먼저 해제한 뒤 프로젝트에 연결해 주세요.',
      });
    }
    const linked = await client.query(
      'UPDATE events SET project_id = $1 WHERE id = $2 AND deleted = FALSE RETURNING id',
      [req.params.id, eventId],
    );
    if (!linked.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Event link conflict' });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('project event link error:', error.message);
    return res.status(500).json({ error: '프로젝트에 일정을 연결하지 못했습니다.' });
  } finally {
    client.release();
  }
  await syncProjectStatus(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/meetings', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  try {
    res.json(await createProjectMeetingEvent(req.params.id, req, req.body));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// 신규 프로젝트 업무 첨부 — 기획서·정산자료처럼 이미지가 아닌 파일도 올린다.
// 저장 경로는 /uploads 로 고정되며, 업무에 붙일 때 서버가 이 경로만 허용한다.
app.post('/api/new-projects/uploads', authMiddleware, uploadFile.array('files', 20), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.files?.length) return res.status(400).json({ error: '올릴 파일을 선택해 주세요' });
  const attachments = req.files.map(file => ({
    url: '/uploads/' + file.filename,
    name: path.basename(decodeMultipartFilename(file.originalname || file.filename)),
    mimeType: file.mimetype || null,
    size: file.size || null,
  }));
  res.json({ attachments });
});

app.post('/api/projects/upload', authMiddleware, uploadJpgPng.array('images', 10), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.files?.length) return res.status(400).json({ error: 'JPG/PNG 이미지만 업로드할 수 있습니다' });
  const attachments = req.files.map(file => ({
    url: '/uploads/' + file.filename,
    name: path.basename(decodeMultipartFilename(file.originalname || file.filename)),
    storedName: file.filename,
    mimeType: file.mimetype || null,
    size: file.size || null
  }));
  res.json({ attachments: normalizeNoticeAttachments(attachments) });
});

app.post('/api/projects/:id/tasks', authMiddleware, async (req, res) => {
  const canCreateTasks = await canAccessProject(req, req.params.id)
    && req.workspace?.headquartersOversight !== true;
  const canDirectTasks = canCreateTasks && await canDirectProjectTasks(req, req.params.id);
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: '업무명을 입력하세요' });
  const description = String(req.body.description || '').trim().slice(0, 3000);
  const roleLabel = String(req.body.roleLabel ?? req.body.role_label ?? '').trim().slice(0, 80);
  const requestedStatus = String(req.body.status || 'todo').trim();
  const dueDate = String(req.body.dueDate || req.body.due_date || '').trim().slice(0, 10);
  if (!isProjectDateKey(dueDate)) {
    return res.status(400).json({ code: 'PROJECT_TASK_DUE_DATE_REQUIRED', error: '업무 마감일을 지정하세요.' });
  }
  const assignmentMode = req.body.assigneeMode === 'all' ? 'all' : 'single';
  const assigneeUid = String(req.body.assigneeUid || req.body.assignee_uid || '').trim();
  const creationDecision = projectTaskCreationDecision({
    actorUid: req.uid,
    canCreateTasks,
    canDirectTasks,
    assignmentMode,
    assigneeUid,
    status: requestedStatus,
  });
  if (!creationDecision.allowed) {
    const responseStatus = creationDecision.code === 'PROJECT_TASK_REVIEW_REQUIRED' ? 400 : 403;
    return res.status(responseStatus).json({ code: creationDecision.code, error: creationDecision.error });
  }
  const status = normalizeProjectTaskStatus(requestedStatus);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const projectResult = await client.query(
      `SELECT p.id, p.name, p.owner_id, COALESCE(owner_user.name, '') AS reviewer_name
       FROM projects p
       LEFT JOIN project_details pd ON pd.project_id = p.id
       LEFT JOIN users owner_user ON owner_user.uid = p.owner_id
       WHERE p.id = $1
         AND COALESCE(pd.deleted, false) = false
         AND p.status IS DISTINCT FROM 'archived'
         AND (p.workspace_id = $2 OR (p.workspace_id IS NULL AND $2 = $3))
       FOR UPDATE OF p`,
      [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }
    const assignees = await resolveProjectTaskAssignees(client, req.params.id, assignmentMode, assigneeUid);
    if (!assignees.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'PROJECT_TASK_ASSIGNEE_REQUIRED', error: '업무 담당자를 지정하세요.' });
    }
    const primaryAssignee = assignmentMode === 'single' ? assignees[0] : null;
    const taskId = crypto.randomUUID();
    const actorName = req.userName || req.userEmail || '사용자';
    const project = projectResult.rows[0];
    const { reviewerUid, reviewerName } = projectTaskCreationReviewer({
      canDirectTasks,
      assignmentMode,
      assigneeUid,
      actorUid: req.uid,
      actorName,
      ownerUid: project.owner_id,
      ownerName: project.reviewer_name || '',
    });
    const result = await client.query(
      `INSERT INTO project_tasks
       (id, project_id, title, description, role_label, assignee_uid, assignee_name,
        assignment_mode, status, due_date, sort_order, created_by, assigned_by_uid,
        assigned_by_name, reviewer_uid, reviewer_name, workflow_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         (SELECT COALESCE(MAX(sort_order),0)+1 FROM project_tasks WHERE project_id=$2),
         $11,$11,$12,$13,$14,1)
       RETURNING *`,
      [
        taskId,
        req.params.id,
        title,
        description,
        roleLabel,
        primaryAssignee?.uid || null,
        assignmentMode === 'all' ? '모두' : primaryAssignee?.name || null,
        assignmentMode,
        status,
        dueDate,
        req.uid,
        actorName,
        reviewerUid,
        reviewerName,
      ]
    );
    await syncProjectTaskAssignees(client, req.params.id, taskId, assignees);
    await recordProjectTaskWorkflowEvent(client, {
      projectId: req.params.id,
      taskId,
      action: creationDecision.selfAssigned ? 'self_created' : 'assigned',
      actorUid: req.uid,
      actorName,
      fromStatus: '',
      toStatus: status,
      dueDate,
      workflowVersion: 1,
    });
    await touchProjectWithDb(client, req.params.id);
    await client.query('COMMIT');
    await notifyProjectMembers(
      req.params.id,
      req.uid,
      creationDecision.selfAssigned ? '새 업무 등록' : '새 업무 지시',
      creationDecision.selfAssigned
        ? `${actorName}님이 본인 업무 "${title}"을(를) 등록했습니다. 마감 ${dueDate}`
        : `${actorName}님이 "${title}" 업무를 배정했습니다. 마감 ${dueDate}`,
      {
        taskId,
        targetUids: assignmentMode === 'single' && assigneeUid === req.uid && reviewerUid !== req.uid
          ? [reviewerUid]
          : assignees.map(assignee => assignee.uid),
        link: `/?page=project&projectId=${req.params.id}&taskId=${taskId}`,
      }
    );
    return res.json({
      ...result.rows[0],
      creator_name: actorName,
      assignees: assignees.map(assignee => ({
        uid: assignee.uid,
        name: assignee.name,
        completed: false,
        completedAt: null,
      })),
      assignee_count: assignees.length,
      completed_assignee_count: 0,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/projects/:id/tasks/:taskId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const canDirectTasks = await canDirectProjectTasks(req, req.params.id);
  const client = await pool.connect();
  let notification = null;
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT pt.*, p.name AS project_name, p.owner_id,
              COALESCE(owner_user.name, '') AS project_owner_name
       FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id
       LEFT JOIN users owner_user ON owner_user.uid = p.owner_id
       LEFT JOIN project_details pd ON pd.project_id = p.id
       WHERE pt.id = $1 AND pt.project_id = $2
         AND COALESCE(pd.deleted, false) = false
         AND p.status IS DISTINCT FROM 'archived'
         AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       FOR UPDATE OF pt, p`,
      [req.params.taskId, req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    if (!previous.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }
    const assignmentRows = await client.query(
      'SELECT user_uid FROM project_task_assignees WHERE project_id = $1 AND task_id = $2',
      [req.params.id, req.params.taskId]
    );
    const before = previous.rows[0];
    const canReview = canReviewProjectTask(req, before);
    const patchDecision = projectTaskPatchDecision({
      task: before,
      body: req.body || {},
      actorUid: req.uid,
      canDirectTasks,
      canReview,
      assignmentUids: assignmentRows.rows.map(row => row.user_uid),
    });
    if (!patchDecision.allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ code: patchDecision.code, error: patchDecision.error });
    }
    if (req.body.expectedVersion !== undefined && Number(req.body.expectedVersion) !== Number(before.workflow_version || 1)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'PROJECT_TASK_VERSION_CONFLICT', error: '다른 사용자가 먼저 업무를 변경했습니다. 최신 내용을 다시 확인하세요.' });
    }

    const sets = ['updated_at = NOW()', 'workflow_version = workflow_version + 1'];
    const params = [req.params.taskId, req.params.id];
    const addSet = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (req.body.title !== undefined) {
      const value = String(req.body.title || '').trim().slice(0, 200);
      if (!value) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '업무명을 입력하세요' });
      }
      addSet('title', value);
    }
    if (req.body.description !== undefined) addSet('description', String(req.body.description || '').trim().slice(0, 3000));
    if (req.body.roleLabel !== undefined || req.body.role_label !== undefined) {
      addSet('role_label', String(req.body.roleLabel ?? req.body.role_label ?? '').trim().slice(0, 80));
    }

    let requestedStatus = null;
    let statusWillChange = false;
    if (req.body.status !== undefined) {
      requestedStatus = String(req.body.status || '').trim();
      if (!['todo', 'doing', 'review', 'done', 'hold'].includes(requestedStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '업무 상태가 올바르지 않습니다.' });
      }
      statusWillChange = requestedStatus !== before.status;
      if (statusWillChange) {
        addSet('status', requestedStatus);
        if (requestedStatus === 'review') {
          sets.push('review_requested_at = NOW()', 'reviewed_at = NULL', "review_note = ''");
        } else if (requestedStatus === 'done') {
          sets.push('reviewed_at = NOW()');
          addSet('review_note', String(req.body.reviewNote || '').trim().slice(0, 5000));
          addSet('reviewer_uid', req.uid);
          addSet('reviewer_name', req.userName || req.userEmail || '사용자');
        } else if (before.status === 'review' && requestedStatus === 'doing') {
          sets.push('reviewed_at = NOW()');
          addSet('review_note', String(req.body.reviewNote || '기존 파라곤에서 다시 진행 처리').trim().slice(0, 5000));
          addSet('reviewer_uid', req.uid);
          addSet('reviewer_name', req.userName || req.userEmail || '사용자');
        }
      }
    }
    if (req.body.dueDate !== undefined || req.body.due_date !== undefined) {
      const dueDate = String(req.body.dueDate ?? req.body.due_date ?? '').trim().slice(0, 10);
      if (!isProjectDateKey(dueDate)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'PROJECT_TASK_DUE_DATE_REQUIRED', error: '업무 마감일을 지정하세요.' });
      }
      addSet('due_date', dueDate);
    }

    let assignmentUpdate = null;
    if (
      (req.body.assigneeMode !== undefined || req.body.assignment_mode !== undefined
        || req.body.assigneeUid !== undefined || req.body.assignee_uid !== undefined)
      && taskAssignmentPatchChanges(before, req.body)
    ) {
      const assignmentMode = String(req.body.assigneeMode ?? req.body.assignment_mode ?? '') === 'all' ? 'all' : 'single';
      const assigneeUid = String(req.body.assigneeUid ?? req.body.assignee_uid ?? '').trim();
      const assignees = await resolveProjectTaskAssignees(client, req.params.id, assignmentMode, assigneeUid);
      if (!assignees.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'PROJECT_TASK_ASSIGNEE_REQUIRED', error: '업무 담당자를 지정하세요.' });
      }
      const primaryAssignee = assignmentMode === 'single' ? assignees[0] : null;
      addSet('assignment_mode', assignmentMode);
      addSet('assignee_uid', primaryAssignee?.uid || null);
      addSet('assignee_name', assignmentMode === 'all' ? '모두' : primaryAssignee?.name || null);
      assignmentUpdate = {
        assignmentMode,
        assignees,
        assigneeUid: primaryAssignee?.uid || '',
      };
    }

    if (canDirectTasks && assignmentUpdate) {
      addSet('assigned_by_uid', req.uid);
      addSet('assigned_by_name', req.userName || req.userEmail || '사용자');
    }
    if (canDirectTasks && assignmentUpdate) {
      const reviewer = projectTaskCreationReviewer({
        canDirectTasks,
        assignmentMode: assignmentUpdate.assignmentMode,
        assigneeUid: assignmentUpdate.assigneeUid,
        actorUid: req.uid,
        actorName: req.userName || req.userEmail || '사용자',
        ownerUid: before.owner_id,
        ownerName: before.project_owner_name || '',
      });
      addSet('reviewer_uid', reviewer.reviewerUid);
      addSet('reviewer_name', reviewer.reviewerName);
    }
    const result = await client.query(
      `UPDATE project_tasks SET ${sets.join(', ')}
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      params
    );
    const after = result.rows[0];
    const statusChanged = before.status !== after.status;
    if (assignmentUpdate) {
      await syncProjectTaskAssignees(client, req.params.id, req.params.taskId, assignmentUpdate.assignees);
    }
    if ((statusChanged || assignmentUpdate) && after.status === 'done') {
      await client.query(
        `UPDATE project_task_assignees
         SET completed = true, completed_at = COALESCE(completed_at, NOW())
         WHERE project_id = $1 AND task_id = $2`,
        [req.params.id, req.params.taskId]
      );
    } else if (statusChanged && ['review', 'done'].includes(before.status) && after.status === 'doing' && after.assignment_mode === 'all') {
      await client.query(
        `UPDATE project_task_assignees
         SET completed = false, completed_at = NULL
         WHERE project_id = $1 AND task_id = $2`,
        [req.params.id, req.params.taskId]
      );
    }
    const actor = req.userName || req.userEmail || '사용자';
    await recordProjectTaskWorkflowEvent(client, {
      projectId: req.params.id,
      taskId: req.params.taskId,
      action: statusChanged
        ? (after.status === 'review' ? 'review_requested' : after.status === 'done' ? 'approved' : before.status === 'review' && after.status === 'doing' ? 'rejected' : 'status_changed')
        : 'edited',
      actorUid: req.uid,
      actorName: actor,
      note: after.review_note || '',
      fromStatus: before.status,
      toStatus: after.status,
      dueDate: after.due_date,
      workflowVersion: after.workflow_version,
    });
    await touchProjectWithDb(client, req.params.id);
    await client.query('COMMIT');

    if (statusChanged) {
      let title = '업무 상태 변경';
      let body = `${before.project_name} · ${after.title}: ${projectTaskStatusLabel(after.status)}`;
      if (after.status === 'review') {
        title = '업무 검토요청';
        body = `${actor}님이 "${after.title}" 업무 검토를 요청했습니다.`;
      } else if (after.status === 'done') {
        title = '업무 완료 승인';
        body = `${actor}님이 "${after.title}" 업무를 완료 승인했습니다.`;
      } else if (before.status === 'review' && after.status === 'doing') {
        title = '업무 수정 요청';
        body = `${actor}님이 "${after.title}" 업무를 다시 진행으로 돌렸습니다.`;
      }
      notification = { title, body };
    }
    if (!notification && assignmentUpdate) {
      notification = {
        title: '업무 재배정',
        body: `${actor}님이 "${after.title}" 업무를 재배정했습니다.`,
      };
    }
    if (notification) {
      await notifyProjectMembers(
        req.params.id,
        req.uid,
        notification.title,
        notification.body,
        {
          taskId: req.params.taskId,
          targetUids: assignmentUpdate
            ? assignmentUpdate.assignees.map(assignee => assignee.uid)
            : after.status === 'review'
              ? [before.reviewer_uid || before.owner_id]
              : assignmentRows.rows.map(row => row.user_uid),
          link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}`,
        }
      );
    }
    return res.json(after);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/projects/:id/tasks/:taskId/review', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const action = String(req.body?.action || '').trim().toLowerCase();
  const note = String(req.body?.note || '').trim().slice(0, 5000);
  const dueDate = req.body?.dueDate === undefined ? null : String(req.body.dueDate || '').trim().slice(0, 10);
  if (action === 'reject' && !note) {
    return res.status(400).json({ code: 'PROJECT_TASK_REVIEW_NOTE_REQUIRED', error: '수정 요청 사유를 입력하세요.' });
  }
  if (dueDate !== null && action !== 'reject') {
    return res.status(403).json({ code: 'PROJECT_TASK_MANAGER_REQUIRED', error: '새 마감일은 책임자가 수정 요청할 때만 지정할 수 있습니다.' });
  }
  if (dueDate !== null && !isProjectDateKey(dueDate)) {
    return res.status(400).json({ code: 'PROJECT_TASK_DUE_DATE_REQUIRED', error: '새 마감일을 올바르게 지정하세요.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT pt.*, p.name AS project_name, p.owner_id
       FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id
       LEFT JOIN project_details pd ON pd.project_id = p.id
       WHERE pt.id = $1 AND pt.project_id = $2
         AND COALESCE(pd.deleted, false) = false
         AND p.status IS DISTINCT FROM 'archived'
         AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       FOR UPDATE OF pt, p`,
      [req.params.taskId, req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }
    const task = current.rows[0];
    const canReview = canReviewProjectTask(req, task);
    const assignmentRows = await client.query(
      'SELECT user_uid FROM project_task_assignees WHERE project_id = $1 AND task_id = $2',
      [req.params.id, req.params.taskId]
    );
    const decision = projectTaskReviewDecision({
      task,
      action,
      actorUid: req.uid,
      canReview,
      assignmentUids: assignmentRows.rows.map(row => row.user_uid),
    });
    if (!decision.allowed) {
      await client.query('ROLLBACK');
      const status = decision.code === 'PROJECT_TASK_TRANSITION_FORBIDDEN' || decision.code === 'PROJECT_TASK_REVIEW_REQUIRED' ? 409 : 403;
      return res.status(status).json({ code: decision.code, error: decision.error });
    }
    if (req.body.expectedVersion !== undefined && Number(req.body.expectedVersion) !== Number(task.workflow_version || 1)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'PROJECT_TASK_VERSION_CONFLICT', error: '다른 사용자가 먼저 업무를 처리했습니다. 최신 내용을 다시 확인하세요.' });
    }
    const actorName = req.userName || req.userEmail || '사용자';
    const params = [
      req.params.id,
      req.params.taskId,
      decision.nextStatus,
      action === 'request' ? '' : note,
      req.uid,
      actorName,
    ];
    const dueSet = dueDate === null ? '' : ', due_date = $7';
    if (dueDate !== null) params.push(dueDate);
    const result = await client.query(
      `UPDATE project_tasks
       SET status = $3,
           review_requested_at = CASE WHEN $3 = 'review' THEN NOW() ELSE review_requested_at END,
           reviewed_at = CASE WHEN $3 IN ('done','doing') THEN NOW() ELSE NULL END,
           review_note = $4,
           reviewer_uid = CASE WHEN $3 IN ('done','doing') THEN $5 ELSE reviewer_uid END,
           reviewer_name = CASE WHEN $3 IN ('done','doing') THEN $6 ELSE reviewer_name END,
           workflow_version = workflow_version + 1,
           updated_at = NOW()
           ${dueSet}
       WHERE project_id = $1 AND id = $2
       RETURNING *`,
      params
    );
    const after = result.rows[0];
    if (action === 'approve') {
      await client.query(
        `UPDATE project_task_assignees
         SET completed = true, completed_at = COALESCE(completed_at, NOW())
         WHERE project_id = $1 AND task_id = $2`,
        [req.params.id, req.params.taskId]
      );
    } else if (action === 'reject') {
      await client.query(
        `UPDATE project_task_assignees
         SET completed = false, completed_at = NULL
         WHERE project_id = $1 AND task_id = $2`,
        [req.params.id, req.params.taskId]
      );
    }

    let reviewComment = null;
    if (note) {
      const comment = await client.query(
        `INSERT INTO project_task_comments
         (id, project_id, task_id, content, author_uid, author_name, author_photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [crypto.randomUUID(), req.params.id, req.params.taskId, note, req.uid, actorName, req.userPhoto || '']
      );
      reviewComment = comment.rows[0];
    }
    await recordProjectTaskWorkflowEvent(client, {
      projectId: req.params.id,
      taskId: req.params.taskId,
      action: action === 'request' ? 'review_requested' : action === 'approve' ? 'approved' : 'rejected',
      actorUid: req.uid,
      actorName,
      note,
      fromStatus: task.status,
      toStatus: after.status,
      dueDate: after.due_date,
      workflowVersion: after.workflow_version,
    });
    await touchProjectWithDb(client, req.params.id);
    await client.query('COMMIT');

    const notification = action === 'request'
      ? { title: '업무 검토요청', body: `${actorName}님이 "${task.title}" 업무 검토를 요청했습니다.` }
      : action === 'approve'
        ? { title: '업무 완료 승인', body: `${actorName}님이 "${task.title}" 업무를 완료 승인했습니다.` }
        : { title: '업무 수정 요청', body: `${actorName}님이 "${task.title}" 업무의 수정을 요청했습니다. ${note.slice(0, 80)}` };
    await notifyProjectMembers(
      req.params.id,
      req.uid,
      notification.title,
      notification.body,
      {
        taskId: req.params.taskId,
        targetUids: action === 'request'
          ? [task.reviewer_uid || task.owner_id]
          : assignmentRows.rows.map(row => row.user_uid),
        link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}`,
      }
    );
    return res.json({ ...after, reviewComment });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/projects/:id/tasks/:taskId/completion', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const client = await pool.connect();
  let response;
  let shouldNotify = false;
  let taskTitle = '';
  let reviewerUid = '';
  try {
    await client.query('BEGIN');
    const task = await client.query(
      `SELECT pt.*, p.name AS project_name, p.owner_id
       FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id
       LEFT JOIN project_details pd ON pd.project_id = p.id
       WHERE pt.id = $1 AND pt.project_id = $2
         AND COALESCE(pd.deleted, false) = false
         AND p.status IS DISTINCT FROM 'archived'
         AND (p.workspace_id = $3 OR (p.workspace_id IS NULL AND $3 = $4))
       FOR UPDATE OF pt, p`,
      [req.params.taskId, req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    if (!task.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }
    const currentTask = task.rows[0];
    taskTitle = currentTask.title;
    reviewerUid = currentTask.reviewer_uid || currentTask.owner_id || '';
    if (currentTask.assignment_mode !== 'all') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '모두 담당 업무만 개인별 완료 체크할 수 있습니다' });
    }
    if (currentTask.status === 'hold') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'PROJECT_TASK_COMPLETION_LOCKED', error: '보류 중인 업무는 완료 체크할 수 없습니다.' });
    }
    if (['review', 'done'].includes(currentTask.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'PROJECT_TASK_REVIEW_LOCKED', error: '검토 요청 후에는 책임자의 승인 또는 수정 요청을 기다려 주세요.' });
    }
    // The task-row lock, not an optimistic client version, serializes independent assignee checks.
    const assigned = await client.query(
      `SELECT 1 FROM project_task_assignees
       WHERE project_id = $1 AND task_id = $2 AND user_uid = $3
       FOR UPDATE`,
      [req.params.id, req.params.taskId, req.uid]
    );
    if (!assigned.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '이 업무의 담당자만 완료 체크할 수 있습니다' });
    }
    const completed = req.body.completed !== false;
    await client.query(
      `UPDATE project_task_assignees
       SET completed = $4,
           completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END
       WHERE project_id = $1 AND task_id = $2 AND user_uid = $3`,
      [req.params.id, req.params.taskId, req.uid, completed]
    );
    const progress = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE completed)::int AS completed
       FROM project_task_assignees
       WHERE project_id = $1 AND task_id = $2`,
      [req.params.id, req.params.taskId]
    );
    const total = Number(progress.rows[0]?.total || 0);
    const completedCount = Number(progress.rows[0]?.completed || 0);
    let nextStatus = currentTask.status;
    if (total > 0 && completedCount === total) nextStatus = 'review';
    else if (completedCount > 0 && currentTask.status === 'todo') nextStatus = 'doing';
    else if (completedCount === 0 && currentTask.status === 'doing') nextStatus = 'todo';
    let workflowVersion = Number(currentTask.workflow_version || 1);
    if (nextStatus !== currentTask.status) {
      const updated = await client.query(
        `UPDATE project_tasks
         SET status = $3,
             review_requested_at = CASE WHEN $3 = 'review' THEN NOW() ELSE review_requested_at END,
             reviewed_at = CASE WHEN $3 = 'review' THEN NULL ELSE reviewed_at END,
             review_note = CASE WHEN $3 = 'review' THEN '' ELSE review_note END,
             workflow_version = workflow_version + 1,
             updated_at = NOW()
         WHERE project_id = $1 AND id = $2
         RETURNING workflow_version`,
        [req.params.id, req.params.taskId, nextStatus]
      );
      workflowVersion = Number(updated.rows[0].workflow_version);
      await recordProjectTaskWorkflowEvent(client, {
        projectId: req.params.id,
        taskId: req.params.taskId,
        action: nextStatus === 'review' ? 'review_requested' : 'completion_changed',
        actorUid: req.uid,
        actorName: req.userName || req.userEmail || '사용자',
        fromStatus: currentTask.status,
        toStatus: nextStatus,
        dueDate: currentTask.due_date,
        workflowVersion,
      });
      shouldNotify = nextStatus === 'review';
    }
    await touchProjectWithDb(client, req.params.id);
    await client.query('COMMIT');
    response = {
      taskId: req.params.taskId,
      completed,
      completedCount,
      total,
      percent: total ? Math.round((completedCount / total) * 100) : 0,
      status: nextStatus,
      workflowVersion,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    client.release();
  }
  if (shouldNotify) {
    await notifyProjectMembers(
      req.params.id,
      req.uid,
      '업무 전체 완료',
      `"${taskTitle}" 담당자가 모두 체크해 검토를 요청했습니다.`,
      {
        taskId: req.params.taskId,
        targetUids: [reviewerUid],
        link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}`,
      }
    );
  }
  return res.json(response);
});

app.delete('/api/projects/:id/tasks/:taskId', authMiddleware, async (req, res) => {
  if (!await canDirectProjectTasks(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  await pool.query(
    'DELETE FROM project_task_assignees WHERE project_id = $1 AND task_id = $2',
    [req.params.id, req.params.taskId]
  );
  await pool.query('DELETE FROM project_tasks WHERE id = $1 AND project_id = $2', [req.params.taskId, req.params.id]);
  await touchProject(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/tasks/:taskId/comments', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const task = await pool.query('SELECT id, title FROM project_tasks WHERE id = $1 AND project_id = $2', [req.params.taskId, req.params.id]);
  if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });
  const content = String(req.body.content || '').trim().slice(0, 5000);
  if (!content) return res.status(400).json({ error: '내용을 입력하세요' });
  const result = await pool.query(
    `INSERT INTO project_task_comments
     (id, project_id, task_id, content, author_uid, author_name, author_photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [crypto.randomUUID(), req.params.id, req.params.taskId, content, req.uid, req.userName || req.userEmail || '사용자', req.userPhoto || '']
  );
  await touchProject(req.params.id);
  await notifyProjectMembers(
    req.params.id,
    req.uid,
    '업무 대화',
    `${task.rows[0].title} · ${req.userName || req.userEmail || '사용자'}: ${content.slice(0, 80)}`,
    { taskId: req.params.taskId, link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}` }
  );
  res.json(result.rows[0]);
});

app.delete('/api/projects/:id/tasks/:taskId/comments/:commentId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const current = await pool.query(
    'SELECT * FROM project_task_comments WHERE id = $1 AND project_id = $2 AND task_id = $3 AND deleted = false',
    [req.params.commentId, req.params.id, req.params.taskId]
  );
  if (!current.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && current.rows[0].author_uid !== req.uid && !await canManageProject(req, req.params.id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  await pool.query(
    'UPDATE project_task_comments SET deleted = true, updated_at = NOW() WHERE id = $1 AND project_id = $2 AND task_id = $3',
    [req.params.commentId, req.params.id, req.params.taskId]
  );
  await touchProject(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/updates', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const content = String(req.body.content || '').trim().slice(0, 5000);
  if (!content) return res.status(400).json({ error: '진행사항을 입력하세요' });
  const statusSnapshot = String(req.body.statusSnapshot || req.body.status_snapshot || '').trim().slice(0, 80);
  const result = await pool.query(
    `INSERT INTO project_updates
     (id, project_id, content, status_snapshot, author_uid, author_name, author_photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [crypto.randomUUID(), req.params.id, content, statusSnapshot, req.uid, req.userName || req.userEmail || '사용자', req.userPhoto || '']
  );
  await touchProject(req.params.id);
  res.json(result.rows[0]);
});

app.put('/api/projects/:id/updates/:updateId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const current = await pool.query(
    'SELECT * FROM project_updates WHERE id = $1 AND project_id = $2',
    [req.params.updateId, req.params.id]
  );
  if (!current.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && current.rows[0].author_uid !== req.uid && !await canManageProject(req, req.params.id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const content = String(req.body.content || '').trim().slice(0, 5000);
  if (!content) return res.status(400).json({ error: '진행사항을 입력하세요' });
  const statusSnapshot = String(req.body.statusSnapshot || req.body.status_snapshot || '').trim().slice(0, 80);
  const result = await pool.query(
    `UPDATE project_updates
     SET content = $3, status_snapshot = $4, updated_at = NOW()
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    [req.params.updateId, req.params.id, content, statusSnapshot]
  );
  await touchProject(req.params.id);
  res.json(result.rows[0]);
});

app.delete('/api/projects/:id/updates/:updateId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const update = await pool.query('SELECT * FROM project_updates WHERE id = $1 AND project_id = $2', [req.params.updateId, req.params.id]);
  if (!update.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && update.rows[0].author_uid !== req.uid && !await canManageProject(req, req.params.id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  await pool.query('DELETE FROM project_updates WHERE id = $1 AND project_id = $2', [req.params.updateId, req.params.id]);
  await touchProject(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/comments', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const content = String(req.body.content || '').trim().slice(0, 5000);
  const attachments = normalizeNoticeAttachments(req.body.attachments);
  if (!content && !attachments.length) return res.status(400).json({ error: '내용이나 이미지를 입력하세요' });
  const project = await pool.query('SELECT name FROM projects WHERE id = $1', [req.params.id]);
  const result = await pool.query(
    `INSERT INTO project_comments
     (id, project_id, content, author_uid, author_name, author_photo, attachments)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [crypto.randomUUID(), req.params.id, content, req.uid, req.userName || req.userEmail || '사용자', req.userPhoto || '', JSON.stringify(attachments)]
  );
  await touchProject(req.params.id);
  const preview = content || (attachments.length ? '이미지를 첨부했습니다.' : '새 대화가 등록되었습니다.');
  await notifyProjectMembers(
    req.params.id,
    req.uid,
    '프로젝트 대화',
    `${project.rows[0]?.name || '프로젝트'} · ${req.userName || req.userEmail || '사용자'}: ${preview.slice(0, 80)}`,
    { link: `/?page=project&projectId=${req.params.id}` }
  );
  res.json(result.rows[0]);
});

app.put('/api/projects/:id/comments/:commentId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const current = await pool.query('SELECT * FROM project_comments WHERE id = $1 AND project_id = $2 AND deleted = false', [req.params.commentId, req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && current.rows[0].author_uid !== req.uid && !await canManageProject(req, req.params.id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const content = String(req.body.content || '').trim().slice(0, 5000);
  const attachments = req.body.attachments !== undefined ? normalizeNoticeAttachments(req.body.attachments) : normalizeNoticeAttachments(current.rows[0].attachments);
  if (!content && !attachments.length) return res.status(400).json({ error: '내용이나 이미지를 입력하세요' });
  const result = await pool.query(
    `UPDATE project_comments
     SET content = $3, attachments = $4, updated_at = NOW()
     WHERE id = $1 AND project_id = $2 AND deleted = false
     RETURNING *`,
    [req.params.commentId, req.params.id, content, JSON.stringify(attachments)]
  );
  await touchProject(req.params.id);
  res.json(result.rows[0]);
});

app.delete('/api/projects/:id/comments/:commentId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const current = await pool.query('SELECT * FROM project_comments WHERE id = $1 AND project_id = $2 AND deleted = false', [req.params.commentId, req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && current.rows[0].author_uid !== req.uid && !await canManageProject(req, req.params.id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  await pool.query('UPDATE project_comments SET deleted = true, updated_at = NOW() WHERE id = $1 AND project_id = $2', [req.params.commentId, req.params.id]);
  await touchProject(req.params.id);
  res.json({ ok: true });
});

// ══ 북마크 (URL 모음) ═════════════════════════════════════════
app.get('/api/bookmarks', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query('SELECT * FROM bookmarks ORDER BY sort_order, created_at');
  res.json(result.rows);
});

app.post('/api/bookmarks', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role)) return res.status(403).json({ error: 'Manager or Admin only' });
  const { name, url, icon, description } = req.body;
  const result = await pool.query(
    'INSERT INTO bookmarks (name, url, icon, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, url, icon || '🔗', description || '', req.uid]
  );
  res.json(result.rows[0]);
});

app.delete('/api/bookmarks/:id', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role)) return res.status(403).json({ error: 'Manager or Admin only' });
  await pool.query('DELETE FROM bookmarks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ══ 피크마케팅 서비스 개발수정요청 ════════════════════════════
app.get('/api/service-requests', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const canManage = await canManageServiceRequests(req);
    const status = normalizeServiceRequestStatus(req.query.status);
    const params = [];
    let where = 'deleted = false';
    if (!canManage) {
      params.push(req.uid);
      where += ` AND requester_uid = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT * FROM service_requests
       WHERE ${where}
       ORDER BY
         CASE status
           WHEN 'requested' THEN 1
           WHEN 'reviewing' THEN 2
           WHEN 'working' THEN 3
           WHEN 'rejected' THEN 4
           WHEN 'done' THEN 5
           ELSE 6
         END,
         updated_at DESC,
         created_at DESC`,
      params
    );
    res.json({ canManage, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/service-requests/upload', authMiddleware, uploadJpgPng.array('images', 10), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!req.files?.length) return res.status(400).json({ error: 'JPG/PNG 이미지만 업로드할 수 있습니다' });
  const attachments = req.files.map(file => ({
    url: '/uploads/' + file.filename,
    name: path.basename(decodeMultipartFilename(file.originalname || file.filename)),
    storedName: file.filename,
    mimeType: file.mimetype || null,
    size: file.size || null
  }));
  res.json({ attachments: normalizeNoticeAttachments(attachments) });
});

app.post('/api/service-requests', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const productName = String(req.body.productName || req.body.product_name || '').trim().slice(0, 80);
    const title = String(req.body.title || '').trim().slice(0, 160);
    const content = String(req.body.content || '').trim().slice(0, 5000);
    const priority = normalizeServiceRequestPriority(req.body.priority);
    const attachments = normalizeNoticeAttachments(req.body.attachments);
    if (!title) return res.status(400).json({ error: '제목을 입력하세요' });
    if (!content) return res.status(400).json({ error: '요청 내용을 입력하세요' });
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO service_requests
       (id, product_name, title, content, priority, requester_uid, requester_name, requester_photo, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [id, productName || '기타', title, content, priority, req.uid, req.userName || req.userEmail || '사용자', req.userPhoto || '', JSON.stringify(attachments)]
    );
    await notifyServiceRequestManagers(result.rows[0], req.uid);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/service-requests/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const currentResult = await pool.query('SELECT * FROM service_requests WHERE id = $1 AND deleted = false', [req.params.id]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ error: 'Request not found' });

    const canManage = await canManageServiceRequests(req);
    const isOwner = current.requester_uid === req.uid;
    if (!canManage && !isOwner) return res.status(403).json({ error: 'Not authorized' });

    const sets = ['updated_at = NOW()'];
    const params = [req.params.id];
    const addSet = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (canManage) {
      if (req.body.status !== undefined) {
        const status = normalizeServiceRequestStatus(req.body.status);
        if (!status) return res.status(400).json({ error: 'Invalid status' });
        addSet('status', status);
        addSet('completed_at', status === 'done' ? new Date() : null);
      }
      if (req.body.priority !== undefined) addSet('priority', normalizeServiceRequestPriority(req.body.priority));
      if (req.body.attachments !== undefined) addSet('attachments', JSON.stringify(normalizeNoticeAttachments(req.body.attachments)));
      if (req.body.managerNote !== undefined || req.body.manager_note !== undefined) {
        addSet('manager_note', String(req.body.managerNote ?? req.body.manager_note ?? '').trim().slice(0, 5000));
      }
      if (req.body.assigneeUid !== undefined || req.body.assignee_uid !== undefined) {
        const assigneeUid = String(req.body.assigneeUid ?? req.body.assignee_uid ?? '').trim();
        if (assigneeUid) {
          const assignee = await pool.query('SELECT uid, name FROM users WHERE uid = $1 AND approved = true', [assigneeUid]);
          if (!assignee.rows[0]) return res.status(400).json({ error: '담당자를 찾을 수 없습니다' });
          addSet('assignee_uid', assignee.rows[0].uid);
          addSet('assignee_name', assignee.rows[0].name);
        } else {
          addSet('assignee_uid', null);
          addSet('assignee_name', null);
        }
      }
    } else if (isOwner && !['done', 'rejected'].includes(current.status)) {
      if (req.body.productName !== undefined || req.body.product_name !== undefined) {
        addSet('product_name', String(req.body.productName ?? req.body.product_name ?? '').trim().slice(0, 80) || '기타');
      }
      if (req.body.title !== undefined) {
        const title = String(req.body.title || '').trim().slice(0, 160);
        if (!title) return res.status(400).json({ error: '제목을 입력하세요' });
        addSet('title', title);
      }
      if (req.body.content !== undefined) {
        const content = String(req.body.content || '').trim().slice(0, 5000);
        if (!content) return res.status(400).json({ error: '요청 내용을 입력하세요' });
        addSet('content', content);
      }
      if (req.body.priority !== undefined) addSet('priority', normalizeServiceRequestPriority(req.body.priority));
      if (req.body.attachments !== undefined) addSet('attachments', JSON.stringify(normalizeNoticeAttachments(req.body.attachments)));
    }

    if (sets.length === 1) return res.json(current);
    const result = await pool.query(
      `UPDATE service_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    const updated = result.rows[0];
    if (canManage && req.body.status !== undefined && updated.status !== current.status) {
      await notifyServiceRequestRequester(
        updated,
        updated.status === 'done' ? '개발수정요청 완료' : '개발수정요청 상태 변경',
        `${updated.product_name || '서비스'} · ${updated.title}`
      );
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/service-requests/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const current = await pool.query('SELECT requester_uid FROM service_requests WHERE id = $1 AND deleted = false', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Request not found' });
    const canManage = await canManageServiceRequests(req);
    if (!canManage && current.rows[0].requester_uid !== req.uid) return res.status(403).json({ error: 'Not authorized' });
    await pool.query('UPDATE service_requests SET deleted = true, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/service-request-managers', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const canManage = await canManageServiceRequests(req);
    if (!canManage) return res.status(403).json({ error: 'Not authorized' });
    const result = await pool.query(
      `SELECT u.uid, u.name, u.email, u.photo_url, u.role,
              (srm.user_uid IS NOT NULL) AS service_request_manager,
              srm.created_at
       FROM users u
       LEFT JOIN service_request_managers srm ON srm.user_uid = u.uid
       WHERE u.approved = true
         AND (u.role = 'admin' OR srm.user_uid IS NOT NULL)
       ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.name`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/service-request-managers', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const userUid = String(req.body.userUid || req.body.user_uid || '').trim();
    const user = await pool.query('SELECT uid, name FROM users WHERE uid = $1 AND approved = true', [userUid]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const result = await pool.query(
      `INSERT INTO service_request_managers (user_uid, user_name, added_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_uid) DO UPDATE SET user_name = EXCLUDED.user_name
       RETURNING *`,
      [user.rows[0].uid, user.rows[0].name, req.uid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/service-request-managers/:uid', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM service_request_managers WHERE user_uid = $1', [req.params.uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ 주간 보고서 ═══════════════════════════════════════════════
// 자동 합산 데이터 계산
async function calcWeeklyAutoSummary(uid, weekStart, weekEnd, templateId) {
  const reports = await pool.query(
    'SELECT id FROM reports WHERE author_id = $1 AND report_date >= $2 AND report_date <= $3 AND template_id = $4',
    [uid, weekStart, weekEnd, templateId]
  );
  const amountFields = await pool.query(
    'SELECT * FROM report_fields WHERE template_id = $1 AND is_amount = true ORDER BY sort_order', [templateId]
  );
  const totals = {};
  let reportCount = reports.rows.length;
  for (const r of reports.rows) {
    const entries = await pool.query(
      'SELECT re.value, rf.field_name, rf.is_latest_only FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id WHERE re.report_id = $1 AND (rf.is_amount = true OR rf.is_latest_only = true)',
      [r.id]
    );
    entries.rows.forEach(e => {
      const val = parseInt(e.value?.replace(/[^0-9]/g, '') || '0');
      totals[e.field_name] = (totals[e.field_name] || 0) + val;
    });
  }
  return { reportCount, totals, amountFields: amountFields.rows.map(f => f.field_name) };
}

app.get('/api/weekly-reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  let result;
  if (req.userDoc.role === 'admin') {
    result = await pool.query('SELECT * FROM weekly_reports ORDER BY week_start DESC');
  } else if (req.userDoc.role === 'manager') {
    result = await pool.query(
      `SELECT wr.* FROM weekly_reports wr JOIN users u ON wr.author_id = u.uid
       WHERE wr.author_id = $1 OR u.group_id = $2 ORDER BY wr.week_start DESC`,
      [req.uid, req.userDoc.group_id]
    );
  } else {
    result = await pool.query('SELECT * FROM weekly_reports WHERE author_id = $1 ORDER BY week_start DESC', [req.uid]);
  }
  res.json(result.rows);
});

app.get('/api/weekly-reports/prepare', authMiddleware, async (req, res) => {
  // 지난주 월~일 자동 합산 데이터 반환
  const now = new Date();
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const weekStart = lastMonday.toISOString().slice(0, 10);
  const weekEnd = lastSunday.toISOString().slice(0, 10);

  let templateId = null;
  const templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (templates.rows[0]) templateId = templates.rows[0].id;

  const autoSummary = templateId ? await calcWeeklyAutoSummary(req.uid, weekStart, weekEnd, templateId) : { reportCount: 0, totals: {}, amountFields: [] };

  // 기존 제출 확인
  const existing = await pool.query('SELECT * FROM weekly_reports WHERE author_id = $1 AND week_start = $2', [req.uid, weekStart]);

  res.json({ weekStart, weekEnd, autoSummary, existing: existing.rows[0] || null });
});

app.post('/api/weekly-reports', authMiddleware, async (req, res) => {
  const { weekStart, weekEnd, additionalFields } = req.body;
  let templateId = null;
  const templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (templates.rows[0]) templateId = templates.rows[0].id;
  const autoSummary = templateId ? await calcWeeklyAutoSummary(req.uid, weekStart, weekEnd, templateId) : {};

  const result = await pool.query(
    `INSERT INTO weekly_reports (author_id, author_name, week_start, week_end, auto_summary, additional_fields, status, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,'submitted',NOW())
     ON CONFLICT (author_id, week_start) DO UPDATE SET auto_summary=$5, additional_fields=$6, status='submitted', submitted_at=NOW()
     RETURNING *`,
    [req.uid, req.userName, weekStart, weekEnd, JSON.stringify(autoSummary), JSON.stringify(additionalFields || [])]
  );
  res.json(result.rows[0]);
});

// ══ 월간 보고서 ═══════════════════════════════════════════════
async function calcMonthlyAutoSummary(uid, month, templateId, userDoc = null) {
  let reports;
  if (userDoc?.role === 'admin' || userDoc?.can_view_all_reports) {
    reports = await pool.query(
      'SELECT id FROM reports WHERE report_date LIKE $1 AND template_id = $2',
      [month + '%', templateId]
    );
  } else if (userDoc?.role === 'manager') {
    reports = await pool.query(
      `SELECT r.id FROM reports r JOIN users u ON r.author_id = u.uid
       WHERE r.report_date LIKE $1 AND r.template_id = $2
       AND (r.author_id = $3 OR u.group_id = $4)`,
      [month + '%', templateId, uid, userDoc.group_id]
    );
  } else {
    reports = await pool.query(
      'SELECT id FROM reports WHERE author_id = $1 AND report_date LIKE $2 AND template_id = $3',
      [uid, month + '%', templateId]
    );
  }
  const amountFields = await pool.query(
    'SELECT * FROM report_fields WHERE template_id = $1 AND is_amount = true ORDER BY sort_order', [templateId]
  );
  const totals = {};
  const reportIds = reports.rows.map(r => r.id);
  if (reportIds.length) {
    const entries = await pool.query(
      `SELECT rf.field_name,
              SUM(NULLIF(regexp_replace(COALESCE(re.value, ''), '[^0-9]', '', 'g'), '')::bigint) AS total
       FROM report_entries re
       JOIN report_fields rf ON re.field_id = rf.id
       WHERE re.report_id = ANY($1::text[]) AND rf.is_amount = true
       GROUP BY rf.field_name`,
      [reportIds]
    );
    entries.rows.forEach(e => {
      totals[e.field_name] = Number(e.total || 0);
    });
  }
  return { reportCount: reports.rows.length, totals, amountFields: amountFields.rows.map(f => f.field_name) };
}

function getDefaultMonthlyReportMonth() {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return lastMonth.toISOString().slice(0, 7);
}

function isValidReportMonth(month) {
  return /^\d{4}-\d{2}$/.test(String(month || ''));
}

function getMonthlyReportTodoDate(month) {
  const [year, monthNum] = String(month).split('-').map(Number);
  const due = new Date(Date.UTC(year, monthNum, 1));
  return due.toISOString().slice(0, 10);
}

function addMonthsToReportMonth(month, amount) {
  const [year, monthNum] = String(month).split('-').map(Number);
  const next = new Date(Date.UTC(year, monthNum - 1 + amount, 1));
  return next.toISOString().slice(0, 7);
}

async function getExistingMonthlyReport(uid, month) {
  const existing = await pool.query(
    'SELECT * FROM monthly_reports WHERE author_id = $1 AND report_month = $2',
    [uid, month]
  );
  return existing.rows[0] || null;
}

async function resolveMonthlyReportMonth(uid, requestedMonth) {
  const latestWritableMonth = getDefaultMonthlyReportMonth();
  let month = requestedMonth;
  let existing = null;
  for (let i = 0; i < 24; i++) {
    existing = await getExistingMonthlyReport(uid, month);
    if (!existing || existing.status !== 'submitted' || month >= latestWritableMonth) {
      return { month, existing, requestedMonth };
    }
    const nextMonth = addMonthsToReportMonth(month, 1);
    if (nextMonth > latestWritableMonth) return { month, existing, requestedMonth };
    month = nextMonth;
  }
  return { month, existing, requestedMonth };
}

app.get('/api/monthly-reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  let result;
  if (req.userDoc.role === 'admin') {
    result = await pool.query('SELECT * FROM monthly_reports ORDER BY report_month DESC');
  } else if (req.userDoc.role === 'manager') {
    result = await pool.query(
      `SELECT mr.* FROM monthly_reports mr JOIN users u ON mr.author_id = u.uid
       WHERE mr.author_id = $1 OR u.group_id = $2 ORDER BY mr.report_month DESC`,
      [req.uid, req.userDoc.group_id]
    );
  } else {
    result = await pool.query('SELECT * FROM monthly_reports WHERE author_id = $1 ORDER BY report_month DESC', [req.uid]);
  }
  res.json(result.rows);
});

app.get('/api/monthly-reports/prepare', authMiddleware, async (req, res) => {
  // 기본은 지난달, 월간 보고서 할 일에서 진입하면 해당 할 일의 대상 월을 사용.
  const requestedMonth = req.query.month || getDefaultMonthlyReportMonth();
  if (!isValidReportMonth(requestedMonth)) return res.status(400).json({ error: 'Invalid month' });
  const resolved = await resolveMonthlyReportMonth(req.uid, requestedMonth);
  const month = resolved.month;

  let templateId = null;
  const templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (templates.rows[0]) templateId = templates.rows[0].id;

  const autoSummary = templateId ? await calcMonthlyAutoSummary(req.uid, month, templateId, req.userDoc) : { reportCount: 0, totals: {}, amountFields: [] };
  const existing = resolved.existing && resolved.month === month ? resolved.existing : await getExistingMonthlyReport(req.uid, month);

  console.log(`[monthly-prepare] uid=${req.uid} name=${req.userName} requested=${requestedMonth} month=${month} reports=${autoSummary.reportCount || 0} existing=${existing ? 'yes' : 'no'}`);
  res.json({ month, requestedMonth, autoSummary, existing });
});

app.post('/api/monthly-reports', authMiddleware, async (req, res) => {
  const { additionalFields } = req.body;
  const requestedMonth = req.body.month;
  if (!isValidReportMonth(requestedMonth)) return res.status(400).json({ error: 'Invalid month' });
  const resolved = await resolveMonthlyReportMonth(req.uid, requestedMonth);
  const month = resolved.month;
  let templateId = null;
  const templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (templates.rows[0]) templateId = templates.rows[0].id;
  const autoSummary = templateId ? await calcMonthlyAutoSummary(req.uid, month, templateId, req.userDoc) : {};

  const result = await pool.query(
    `INSERT INTO monthly_reports (author_id, author_name, report_month, auto_summary, additional_fields, status, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'submitted',NOW())
     ON CONFLICT (author_id, report_month) DO UPDATE SET auto_summary=$4, additional_fields=$5, status='submitted', submitted_at=NOW()
     RETURNING *`,
    [req.uid, req.userName, month, JSON.stringify(autoSummary), JSON.stringify(additionalFields || [])]
  );
  await pool.query(
    `UPDATE events SET done = true
     WHERE owner_id = $1 AND date = $2 AND title = '📈 월간 보고서 작성' AND deleted = false
       AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.uid, getMonthlyReportTodoDate(month), PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
  );
  console.log(`[monthly-submit] uid=${req.uid} name=${req.userName} requested=${requestedMonth} month=${month} reports=${autoSummary.reportCount || 0}`);
  res.json(result.rows[0]);
});

// ── 할 일 순서/카테고리 변경 ───────────────────────────────
app.post('/api/events/reorder', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const normalized = normalizeEventReorderItems(req.body?.items);
  if (!normalized.ok) {
    return res.status(normalized.status).json({ code: normalized.code, error: normalized.error });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = normalized.items.map(item => item.id);
    const current = await client.query(
      `SELECT e.id, e.type, e.owner_id,
              ${INTERNAL_CALENDAR_RULE_EVENT_SQL} AS is_internal_rule
       FROM events e
       WHERE e.id = ANY($1::text[]) AND e.deleted = false
         AND (e.workspace_id = $2 OR (e.workspace_id IS NULL AND $2 = $3))
         ${eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 2 })}
       FOR UPDATE`,
      [ids, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    const permission = authorizeEventReorder({
      items: normalized.items,
      rows: current.rows,
      uid: req.uid,
      role: req.userDoc.role,
      externalCalendarOnly: isExternalCalendarUser(req),
    });
    if (!permission.ok) {
      await client.query('ROLLBACK');
      return res.status(permission.status).json({ code: permission.code, error: permission.error });
    }

    for (const item of normalized.items) {
      await client.query(
        `UPDATE events SET sort_order = $1, todo_cat = COALESCE($2, todo_cat)
          WHERE id = $3
            AND (workspace_id = $4 OR (workspace_id IS NULL AND $4 = $5))`,
        [item.sortOrder, item.todoCat ?? null, item.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated: normalized.items.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══ 휴무일 관리 ══════════════════════════════════════════════
app.get('/api/holidays', authMiddleware, async (req, res) => {
  const { year } = req.query;
  const y = year || new Date().getFullYear();
  const result = await pool.query('SELECT * FROM holidays WHERE holiday_date LIKE $1 ORDER BY holiday_date', [y+'%']);
  res.json(result.rows);
});

app.post('/api/holidays', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin' && !req.userDoc?.can_manage_team) return res.status(403).json({ error: 'Not authorized' });
  const { date, name } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  const result = await pool.query(
    'INSERT INTO holidays (holiday_date, name, created_by) VALUES ($1,$2,$3) ON CONFLICT (holiday_date) DO UPDATE SET name=$2 RETURNING *',
    [date, name||'휴무일', req.uid]
  );
  res.json(result.rows[0]);
});

app.delete('/api/holidays/:date', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin' && !req.userDoc?.can_manage_team) return res.status(403).json({ error: 'Not authorized' });
  await pool.query('DELETE FROM holidays WHERE holiday_date = $1', [req.params.date]);
  res.json({ ok: true });
});

// 지각 판단 시 휴무일 체크
app.get('/api/holidays/check', authMiddleware, async (req, res) => {
  const { date } = req.query;
  const result = await pool.query('SELECT 1 FROM holidays WHERE holiday_date = $1', [date]);
  res.json({ isHoliday: result.rows.length > 0 });
});

// ── 반복 일정 삭제 ─────────────────────────────────────────
app.post('/api/events/:id/delete-repeat-future', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const ev = await pool.query(
    `SELECT * FROM events WHERE id = $1
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  if (!ev.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) return res.status(403).json({ error: 'Not owner' });
  const parentId = ev.rows[0].repeat_parent_id || ev.rows[0].id;
  const { fromDate } = req.body;
  await pool.query(
    `UPDATE events SET deleted = true
      WHERE (repeat_parent_id = $1 OR id = $1) AND date >= $2
        AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [parentId, fromDate, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json({ ok: true });
});

app.post('/api/events/:id/delete-repeat-all', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const ev = await pool.query(
    `SELECT * FROM events WHERE id = $1
      AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [req.params.id, requestWorkspaceId(req), PEAK_WORKSPACE_ID],
  );
  if (!ev.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) return res.status(403).json({ error: 'Not owner' });
  const parentId = ev.rows[0].repeat_parent_id || ev.rows[0].id;
  await pool.query(
    `UPDATE events SET deleted = true
      WHERE (repeat_parent_id = $1 OR id = $1)
        AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
    [parentId, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
  );
  res.json({ ok: true });
});

// ── 일정 공유 멤버 조회 ────────────────────────────────────
app.get('/api/events/:id/shares', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await canAccessEvent(req, req.params.id))) return res.status(403).json({ error: 'No access' });
  const result = await pool.query(
    `SELECT u.uid, u.name, u.photo_url
     FROM event_shares es
     JOIN users u ON es.user_id = u.uid
     WHERE es.event_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true
     ORDER BY u.name`,
    [req.params.id]
  );
  res.json(result.rows);
});

// ══ 체크리스트 (일정 서브항목) ══════════════════════════════
app.get('/api/events/:id/checklist', authMiddleware, async (req, res) => {
  if (!(await canAccessEvent(req, req.params.id))) return res.status(403).json({ error: 'No access' });
  const result = await pool.query(
    'SELECT * FROM event_checklist WHERE event_id = $1 ORDER BY done DESC, sort_order, created_at, id', [req.params.id]
  );
  res.json(result.rows);
});

app.post('/api/events/:id/checklist', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await canAccessEvent(req, req.params.id))) return res.status(403).json({ error: 'No access' });
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM event_checklist WHERE event_id=$1', [req.params.id]);
  const result = await pool.query(
    'INSERT INTO event_checklist (event_id, title, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, title.trim(), maxOrder.rows[0].next]
  );
  await normalizeChecklistSortOrders(req.params.id);
  const itemResult = await pool.query('SELECT * FROM event_checklist WHERE id = $1', [result.rows[0].id]);
  await syncChecklistDrivenEventState(req.params.id);
  res.json({ item: itemResult.rows[0] || null, event: await getEventRowById(req.params.id) });
});

app.put('/api/events/:eventId/checklist/:itemId', authMiddleware, async (req, res) => {
  if (!(await canAccessEvent(req, req.params.eventId))) return res.status(403).json({ error: 'No access' });
  const { done, title } = req.body;
  const updates = [];
  const vals = [];
  let idx = 1;
  if (done !== undefined) { updates.push(`done=$${idx++}`); vals.push(done); }
  if (title !== undefined) { updates.push(`title=$${idx++}`); vals.push(title); }
  if (!updates.length) return res.status(400).json({ error: 'No updates provided' });
  vals.push(req.params.itemId);
  const itemIdIdx = idx++;
  vals.push(req.params.eventId);
  await pool.query(`UPDATE event_checklist SET ${updates.join(',')} WHERE id=$${itemIdIdx} AND event_id=$${idx}`, vals);
  await normalizeChecklistSortOrders(req.params.eventId);
  const result = await pool.query('SELECT * FROM event_checklist WHERE id = $1', [req.params.itemId]);
  await syncChecklistDrivenEventState(req.params.eventId);
  res.json({ item: result.rows[0] || null, event: await getEventRowById(req.params.eventId) });
});

app.delete('/api/events/:eventId/checklist/:itemId', authMiddleware, async (req, res) => {
  if (!(await canAccessEvent(req, req.params.eventId))) return res.status(403).json({ error: 'No access' });
  await pool.query('DELETE FROM event_checklist WHERE id = $1 AND event_id = $2', [req.params.itemId, req.params.eventId]);
  await normalizeChecklistSortOrders(req.params.eventId);
  await syncChecklistDrivenEventState(req.params.eventId);
  res.json({ ok: true, id: req.params.itemId, event: await getEventRowById(req.params.eventId) });
});

// 체크리스트 요약 (캘린더 표시용)
app.get('/api/events/checklist-summary', authMiddleware, async (req, res) => {
  const result = isExternalCalendarUser(req)
    ? await pool.query(
      `SELECT ec.event_id, COUNT(*) as total, COUNT(*) FILTER (WHERE ec.done=true) as completed
       FROM event_checklist ec
       JOIN events e ON e.id = ec.event_id
       LEFT JOIN event_shares es ON es.event_id = e.id AND es.user_id = $1
       WHERE e.deleted = false AND (e.owner_id = $1 OR es.user_id = $1)
         AND (e.workspace_id = $2 OR (e.workspace_id IS NULL AND $2 = $3))
         AND NOT ${INTERNAL_CALENDAR_RULE_EVENT_SQL}
         ${eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 2 })}
       GROUP BY ec.event_id`,
      [req.uid, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    )
    : await pool.query(
      `SELECT ec.event_id, COUNT(*) as total, COUNT(*) FILTER (WHERE ec.done=true) as completed
       FROM event_checklist ec
       JOIN events e ON e.id = ec.event_id
       WHERE (e.workspace_id = $1 OR (e.workspace_id IS NULL AND $1 = $2))
         ${eventHiddenPredicate(req, { eventAlias: 'e', workspaceParameter: 1 })}
       GROUP BY ec.event_id`,
      [requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
  const summary = {};
  result.rows.forEach(r => { summary[r.event_id] = { total: parseInt(r.total), completed: parseInt(r.completed) }; });
  res.json(summary);
});

// ══ 통계 대시보드 (admin/manager) ══════════════════════════════
app.get('/api/stats/daily', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role) && !req.userDoc?.can_view_all_reports) return res.status(403).json({ error: 'Not authorized' });
  const { date } = req.query;
  const d = date || new Date().toISOString().slice(0,10);
  let templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (!templates.rows[0]) return res.json({ date: d, reports: [], totals: {}, submitted: 0, total: 0 });
  const tid = templates.rows[0].id;

  const groupFilter = req.userDoc.role === 'admin' ? '' : ` AND u.group_id = '${req.userDoc.group_id}'`;
  const reports = await pool.query(
    `SELECT r.*, u.group_id FROM reports r JOIN users u ON r.author_id = u.uid WHERE r.report_date = $1 AND r.template_id = $2${groupFilter} ORDER BY r.author_name`, [d, tid]
  );
  const totals = {}, collection = {};
  for (const r of reports.rows) {
    const entries = await pool.query(
      'SELECT re.value, rf.field_name, rf.is_amount, rf.is_latest_only, rf.field_group FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id WHERE re.report_id = $1 AND (rf.is_amount = true OR rf.is_latest_only = true OR rf.field_group = $2)', [r.id, '수금/미수']
    );
    entries.rows.forEach(e => {
      const v = parseInt(e.value?.replace(/[^0-9]/g,'')||'0');
      if (e.field_group === '수금/미수') {
        if (e.is_latest_only) collection[r.author_name + '_' + e.field_name] = v;
        else collection[e.field_name] = (collection[e.field_name]||0) + v;
      } else if (e.is_amount) {
        totals[e.field_name] = (totals[e.field_name]||0) + v;
      }
    });
  }
  // 미수잔액 합산 (각 사람 최신값)
  let totalOutstanding = 0;
  Object.entries(collection).forEach(([k,v]) => { if(k.includes('미수잔액')) totalOutstanding += v; });
  collection['미수잔액_합계'] = totalOutstanding;

  const allUsers = req.userDoc.role === 'admin'
    ? await pool.query('SELECT COUNT(*) FROM users WHERE approved = true')
    : await pool.query('SELECT COUNT(*) FROM users WHERE approved = true AND group_id = $1', [req.userDoc.group_id]);
  res.json({ date: d, reports: reports.rows, totals, collection, submitted: reports.rows.length, total: parseInt(allUsers.rows[0].count) });
});

app.get('/api/stats/weekly', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role) && !req.userDoc?.can_view_all_reports) return res.status(403).json({ error: 'Not authorized' });
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay()+6)%7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  const ms = monday.toISOString().slice(0,10), ss = sunday.toISOString().slice(0,10);
  let templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (!templates.rows[0]) return res.json({ period: ms+'~'+ss, byAuthor: {}, totals: {} });
  const tid = templates.rows[0].id;
  const groupFilter = req.userDoc.role === 'admin' ? '' : ` AND u.group_id = '${req.userDoc.group_id}'`;
  const reports = await pool.query(
    `SELECT r.* FROM reports r JOIN users u ON r.author_id = u.uid WHERE r.report_date >= $1 AND r.report_date <= $2 AND r.template_id = $3${groupFilter} ORDER BY r.author_name`, [ms, ss, tid]
  );
  const byAuthor = {}, grandTotals = {};
  for (const r of reports.rows) {
    if (!byAuthor[r.author_name]) byAuthor[r.author_name] = { count: 0, totals: {} };
    byAuthor[r.author_name].count++;
    const entries = await pool.query(
      'SELECT re.value, rf.field_name, rf.is_latest_only FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id WHERE re.report_id = $1 AND (rf.is_amount = true OR rf.is_latest_only = true)', [r.id]
    );
    entries.rows.forEach(e => {
      const v = parseInt(e.value?.replace(/[^0-9]/g,'')||'0');
      if (e.is_latest_only) {
        // 미수잔액 등: 합산 안 함, 마지막 값만 덮어쓰기
        byAuthor[r.author_name].totals[e.field_name] = v;
        grandTotals[e.field_name] = (grandTotals[e.field_name]||0) - (byAuthor[r.author_name]._prev?.[e.field_name]||0) + v;
        if (!byAuthor[r.author_name]._prev) byAuthor[r.author_name]._prev = {};
        byAuthor[r.author_name]._prev[e.field_name] = v;
      } else {
        byAuthor[r.author_name].totals[e.field_name] = (byAuthor[r.author_name].totals[e.field_name]||0) + v;
        grandTotals[e.field_name] = (grandTotals[e.field_name]||0) + v;
      }
    });
  }
  res.json({ period: ms+' ~ '+ss, byAuthor, totals: grandTotals, reportCount: reports.rows.length });
});

app.get('/api/stats/monthly', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role) && !req.userDoc?.can_view_all_reports) return res.status(403).json({ error: 'Not authorized' });
  const { month } = req.query;
  const m = month || new Date().toISOString().slice(0,7);
  let templates = await pool.query('SELECT id FROM report_templates LIMIT 1');
  if (!templates.rows[0]) return res.json({ month: m, byAuthor: {}, totals: {} });
  const tid = templates.rows[0].id;
  const groupFilter = req.userDoc.role === 'admin' ? '' : ` AND u.group_id = '${req.userDoc.group_id}'`;
  const reports = await pool.query(
    `SELECT r.* FROM reports r JOIN users u ON r.author_id = u.uid WHERE r.report_date LIKE $1 AND r.template_id = $2${groupFilter} ORDER BY r.author_name`, [m+'%', tid]
  );
  const byAuthor = {}, grandTotals = {};
  for (const r of reports.rows) {
    if (!byAuthor[r.author_name]) byAuthor[r.author_name] = { count: 0, totals: {} };
    byAuthor[r.author_name].count++;
    const entries = await pool.query(
      'SELECT re.value, rf.field_name, rf.is_latest_only FROM report_entries re JOIN report_fields rf ON re.field_id = rf.id WHERE re.report_id = $1 AND (rf.is_amount = true OR rf.is_latest_only = true)', [r.id]
    );
    entries.rows.forEach(e => {
      const v = parseInt(e.value?.replace(/[^0-9]/g,'')||'0');
      if (e.is_latest_only) {
        // 미수잔액 등: 합산 안 함, 마지막 값만 덮어쓰기
        byAuthor[r.author_name].totals[e.field_name] = v;
        grandTotals[e.field_name] = (grandTotals[e.field_name]||0) - (byAuthor[r.author_name]._prev?.[e.field_name]||0) + v;
        if (!byAuthor[r.author_name]._prev) byAuthor[r.author_name]._prev = {};
        byAuthor[r.author_name]._prev[e.field_name] = v;
      } else {
        byAuthor[r.author_name].totals[e.field_name] = (byAuthor[r.author_name].totals[e.field_name]||0) + v;
        grandTotals[e.field_name] = (grandTotals[e.field_name]||0) + v;
      }
    });
  }
  res.json({ month: m, byAuthor, totals: grandTotals, reportCount: reports.rows.length });
});

// ── 기본 공유 멤버 ───────────────────────────────────────────
app.get('/api/default-shares', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT share_with_id FROM default_share_members WHERE user_id = $1', [req.uid]);
  res.json(result.rows.map(r => r.share_with_id));
});

app.post('/api/default-shares', authMiddleware, async (req, res) => {
  const { memberIds } = req.body;
  await pool.query('DELETE FROM default_share_members WHERE user_id = $1', [req.uid]);
  if (memberIds && memberIds.length) {
    for (const mid of memberIds) {
      await pool.query('INSERT INTO default_share_members (user_id, share_with_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.uid, mid]);
    }
  }
  res.json({ ok: true });
});

// ── 보고서 리마인더 자동 생성 ─────────────────────────────────
const REPORT_REMINDER_TITLES = [
  '📝 일일 보고서 작성',
  '📋 업무보고 작성',
  '📊 주간 보고서 작성',
  '📈 월간 보고서 작성'
];

function getKstDateParts(now = Date.now()) {
  const kst = new Date(now + (9 * 60 * 60 * 1000));
  return {
    date: `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`,
    dayOfWeek: kst.getUTCDay(),
    dayOfMonth: kst.getUTCDate()
  };
}

async function softDeleteEventIds(ids, workspaceId = PEAK_WORKSPACE_ID) {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await pool.query(
      `UPDATE events SET deleted = true
        WHERE id = ANY($1::text[])
          AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))`,
      [ids.slice(i, i + BATCH_SIZE), workspaceId, PEAK_WORKSPACE_ID]
    );
  }
}

async function syncTodayReportReminders(now = Date.now()) {
  const { date, dayOfWeek, dayOfMonth } = getKstDateParts(now);
  const [usersResult, holidayResult, existingResult] = await Promise.all([
    pool.query(
      `SELECT u.uid, u.name, g.group_type
       FROM users u
       LEFT JOIN groups g ON u.group_id = g.id
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = u.uid
        AND pwm.workspace_id = $1
        AND pwm.active = TRUE
        AND pwm.is_default = TRUE
        AND pwm.role <> 'oversight'
       WHERE u.approved = true
         AND COALESCE(u.is_active, true) = true
         AND u.role != 'admin'
         AND COALESCE(u.chat_only, false) = false
         AND COALESCE(u.external_calendar_only, false) = false`,
      [PEAK_WORKSPACE_ID]
    ),
    pool.query('SELECT 1 FROM holidays WHERE holiday_date = $1 LIMIT 1', [date]),
    pool.query(
      `SELECT id, owner_id, date, title, done, created_at
       FROM events
       WHERE deleted = false AND title = ANY($1::text[])
         AND (workspace_id = $2 OR (workspace_id IS NULL AND $2 = $3))
       ORDER BY owner_id, date, title, done DESC, created_at, id`,
      [REPORT_REMINDER_TITLES, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
    )
  ]);

  const isHoliday = holidayResult.rows.length > 0;
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const expected = [];
  if (!isHoliday) {
    for (const user of usersResult.rows) {
      const isSales = user.group_type !== 'support';
      if (!isWeekend) {
        expected.push({
          ownerId: user.uid,
          ownerName: user.name,
          title: isSales ? '📝 일일 보고서 작성' : '📋 업무보고 작성'
        });
      }
      if (dayOfWeek === 1 && isSales) {
        expected.push({ ownerId: user.uid, ownerName: user.name, title: '📊 주간 보고서 작성' });
      }
      if (dayOfMonth === 1 && isSales) {
        expected.push({ ownerId: user.uid, ownerName: user.name, title: '📈 월간 보고서 작성' });
      }
    }
  }

  const reminderKey = (ownerId, reminderDate, title) => `${ownerId}|${reminderDate}|${title}`;
  const expectedKeys = new Set(expected.map(row => reminderKey(row.ownerId, date, row.title)));
  const keptKeys = new Set();
  const deleteIds = [];
  for (const row of existingResult.rows) {
    const key = reminderKey(row.owner_id, row.date, row.title);
    if (!expectedKeys.has(key) || keptKeys.has(key)) {
      deleteIds.push(row.id);
      continue;
    }
    keptKeys.add(key);
  }
  await softDeleteEventIds(deleteIds, PEAK_WORKSPACE_ID);

  const missing = expected.filter(row => !keptKeys.has(reminderKey(row.ownerId, date, row.title)));
  if (missing.length) {
    const values = [];
    const params = [];
    missing.forEach((row, index) => {
      const base = index * 5;
      values.push(`($${base + 1},'todo',$${base + 2},$${base + 3},'personal',$${base + 4},$${base + 5},'보고서')`);
      params.push(PEAK_WORKSPACE_ID, row.title, date, row.ownerId, row.ownerName);
    });
    await pool.query(
      `INSERT INTO events (workspace_id,type,title,date,scope,owner_id,owner_name,todo_cat)
       VALUES ${values.join(',')}
       ON CONFLICT DO NOTHING`,
      params
    );
  }

  return { date, created: missing.length, removed: deleteIds.length, expected: expected.length };
}

async function ensureReportReminderInfrastructure() {
  try {
    const result = await syncTodayReportReminders();
    const indexResult = await pool.query(
      `SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'idx_events_report_reminder_unique'`
    );
    if (!indexResult.rows.length) {
      try {
        await pool.query(
          `CREATE UNIQUE INDEX idx_events_report_reminder_unique
           ON events (owner_id, date, title)
           WHERE deleted = false
             AND title IN ('📝 일일 보고서 작성','📋 업무보고 작성','📊 주간 보고서 작성','📈 월간 보고서 작성')`
        );
      } catch (indexErr) {
        console.error('Report reminder unique index unavailable (needs DBA):', indexErr.message);
      }
    }
    console.log(`[report-reminders] date=${result.date} created=${result.created} removed=${result.removed}`);
  } catch (err) {
    console.error('Report reminder infrastructure unavailable:', err.message);
  }
}

// Admin page boot keeps today's reminders in sync. The work is rate-limited
// because the server also runs it once at startup and shortly after midnight.
const AUTO_REMINDERS_COOLDOWN_MS = 60 * 60 * 1000;
let lastAutoRemindersRunAt = 0;

app.post('/api/reports/auto-reminders', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const now = Date.now();
  if (now - lastAutoRemindersRunAt < AUTO_REMINDERS_COOLDOWN_MS) {
    return res.json({ ok: true, created: 0, skipped: 'cooldown' });
  }
  lastAutoRemindersRunAt = now;

  try {
    const result = await syncTodayReportReminders(now);
    res.json({ ok: true, ...result });
  } catch (err) {
    // If anything blew up, clear the cooldown so a retry can actually
    // retry instead of silently no-op'ing for an hour.
    lastAutoRemindersRunAt = 0;
    console.error('auto-reminders failed:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ══ 경영지원팀 업무보고 ═══════════════════════════════════════
app.get('/api/work-reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { date } = req.query;
  if (req.userDoc.role === 'admin' || req.userDoc.can_view_all_reports) {
    const result = await pool.query(
      'SELECT * FROM work_reports WHERE ($1::text IS NULL OR report_date = $1) ORDER BY report_date DESC, created_at DESC',
      [date||null]
    );
    res.json(result.rows);
  } else if (req.userDoc.role === 'manager') {
    // 같은 그룹 팀원 업무보고
    const result = await pool.query(
      `SELECT wr.* FROM work_reports wr JOIN users u ON wr.author_id = u.uid
       WHERE (wr.author_id = $1 OR u.group_id = $2) AND ($3::text IS NULL OR wr.report_date = $3) ORDER BY wr.report_date DESC`,
      [req.uid, req.userDoc.group_id, date||null]
    );
    res.json(result.rows);
  } else {
    // 본인 것만
    const result = await pool.query(
      'SELECT * FROM work_reports WHERE author_id = $1 AND ($2::text IS NULL OR report_date = $2) ORDER BY report_date DESC',
      [req.uid, date||null]
    );
    res.json(result.rows);
  }
});

app.post('/api/work-reports', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { reportDate, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  const result = await pool.query(
    `INSERT INTO work_reports (author_id, author_name, report_date, content)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (author_id, report_date) DO UPDATE SET content=$4, created_at=NOW()
     RETURNING *`,
    [req.uid, req.userName, reportDate, content.trim()]
  );
  // 캘린더 업무보고 작성 할일 자동 완료
  await pool.query(
    `UPDATE events SET done = true
      WHERE owner_id = $1 AND date = $2 AND title = '📋 업무보고 작성' AND deleted = false
        AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
    [req.uid, reportDate, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
  );
  // admin에게 업무보고 확인 할일 추가
  const admins = await pool.query(
    `SELECT u.uid, u.name
       FROM users u
       JOIN peakos_workspace_memberships pwm
         ON pwm.user_uid = u.uid
        AND pwm.workspace_id = $2
        AND pwm.active = TRUE
        AND pwm.is_default = TRUE
        AND pwm.role <> 'oversight'
      WHERE u.role = 'admin' AND u.uid != $1`,
    [req.uid, PEAK_WORKSPACE_ID]
  );
  for (const a of admins.rows) {
    const exists = await pool.query(
      `SELECT 1 FROM events
        WHERE owner_id=$1 AND date=$2 AND title LIKE $3 AND deleted=false
          AND (workspace_id = $4 OR (workspace_id IS NULL AND $4 = $5))`,
      [a.uid, reportDate, `📋 ${req.userName}%업무보고%`, PEAK_WORKSPACE_ID, PEAK_WORKSPACE_ID]
    );
    if (!exists.rows[0]) {
      await pool.query(
        `INSERT INTO events (workspace_id,type,title,date,scope,owner_id,owner_name,todo_cat)
         VALUES ($1,'todo',$2,$3,'personal',$4,$5,'보고서')`,
        [PEAK_WORKSPACE_ID, `📋 ${req.userName} 업무보고 확인`, reportDate, a.uid, a.name||'']
      );
    }
  }
  res.json(result.rows[0]);
});

// ── 팀원 보고서 제출 현황 (팀장/admin 캘린더용) ──────────────
app.get('/api/reports/team-status', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.userDoc?.role)) return res.status(403).json({ error: 'Manager or Admin only' });
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().slice(0,10);
  let teamUsers;
  if (req.userDoc.role === 'admin') {
    teamUsers = await pool.query('SELECT uid, name, email, group_id FROM users WHERE approved = true AND uid != $1', [req.uid]);
  } else {
    teamUsers = await pool.query('SELECT uid, name, email, group_id FROM users WHERE approved = true AND group_id = $1 AND uid != $2', [req.userDoc.group_id, req.uid]);
  }
  const submitted = await pool.query('SELECT author_id FROM reports WHERE report_date = $1', [targetDate]);
  const workSubmitted = await pool.query('SELECT author_id FROM work_reports WHERE report_date = $1', [targetDate]);
  const submittedIds = [...submitted.rows.map(r => r.author_id), ...workSubmitted.rows.map(r => r.author_id)];
  const result = teamUsers.rows.map(u => ({
    uid: u.uid, name: u.name, email: u.email, group_id: u.group_id,
    submitted: submittedIds.includes(u.uid)
  }));
  res.json(result);
});

// ── 외부 API: 아이디어 추가 (API 키 인증) ────────────────────
// Credential material must never live in source. This endpoint is optional
// and fails closed until an operator injects a rotated secret.
function externalIdeaAuthorizationMatches(value, configuredKey = process.env.PEAKOS_EXTERNAL_IDEA_API_KEY) {
  const key = String(configuredKey || '').trim();
  if (key.length < 32) return false;
  const supplied = String(value || '');
  const expected = `Bearer ${key}`;
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}
const EXTERNAL_OWNER_UID = 'AWTTuoILg6TkwkkHTvIoqsb8BST2';
const EXTERNAL_OWNER_NAME = '패션TV봉이';

app.post('/api/add-idea', async (req, res) => {
  const configuredKey = String(process.env.PEAKOS_EXTERNAL_IDEA_API_KEY || '').trim();
  if (configuredKey.length < 32) {
    return res.status(503).json({
      code: 'EXTERNAL_IDEA_API_DISABLED',
      error: '외부 아이디어 등록 API가 설정되지 않았습니다.',
    });
  }
  const authHeader = req.headers.authorization;
  if (!externalIdeaAuthorizationMatches(authHeader, configuredKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const { title, summary, detail, url, category, date } = req.body;
  if (!summary && !title) return res.status(400).json({ error: 'title or summary required' });
  try {
    const result = await pool.query(
      `INSERT INTO ideas (title, summary, detail, url, category, date, scope, owner_id, owner_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [title || '', summary || '', detail || '', url || '', category || 'AI도구', date || new Date().toISOString().slice(0,10), 'personal', EXTERNAL_OWNER_UID, EXTERNAL_OWNER_NAME]
    );
    res.json({ ok: true, idea: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ 공지사항 / 상품 안내 ══════════════════════════════════════

// 작성 권한 체크 헬퍼
async function canWriteNotice(req) {
  if (req.userDoc?.role === 'admin') return true;
  const r = await pool.query('SELECT 1 FROM notice_writers WHERE user_uid = $1', [req.uid]);
  return r.rows.length > 0;
}

function normalizeNoticeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map(att => {
      const url = String(att?.url || '').trim();
      if (!url.startsWith('/uploads/')) return null;
      const name = path.basename(String(att?.name || att?.originalName || att?.storedName || 'image'));
      return {
        url,
        name,
        storedName: path.basename(String(att?.storedName || url.split('/').pop() || '')),
        mimeType: String(att?.mimeType || '').trim() || null,
        size: Number(att?.size) > 0 ? Number(att.size) : null
      };
    })
    .filter(Boolean);
}

function parseNoticeContent(rawContent) {
  const fallback = { text: String(rawContent || ''), attachments: [] };
  if (typeof rawContent !== 'string' || !rawContent.trim()) return fallback;
  try {
    const parsed = JSON.parse(rawContent);
    if (!parsed || parsed._noticeFormat !== 'rich-v1') return fallback;
    return {
      text: String(parsed.text || ''),
      attachments: normalizeNoticeAttachments(parsed.attachments)
    };
  } catch (err) {
    return fallback;
  }
}

function serializeNoticeContent(text, attachments = []) {
  const safeText = String(text || '');
  const safeAttachments = normalizeNoticeAttachments(attachments);
  if (!safeAttachments.length) return safeText;
  return JSON.stringify({
    _noticeFormat: 'rich-v1',
    text: safeText,
    attachments: safeAttachments
  });
}

function expandNoticeRow(row) {
  const { text, attachments } = parseNoticeContent(row?.content);
  return {
    ...row,
    content_text: text,
    attachments
  };
}

function deleteNoticeFiles(attachments = []) {
  normalizeNoticeAttachments(attachments).forEach(att => {
    const storedName = att.storedName || path.basename(att.url || '');
    if (!storedName) return;
    const filePath = path.join(uploadDir, storedName);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (err) { console.error('Notice file cleanup failed:', err.message); }
    }
  });
}

// 목록 조회 (전원)
app.get('/api/notices', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const cat = req.query.category || 'all';
    let q = 'SELECT * FROM notices WHERE deleted = false';
    const params = [];
    if (cat !== 'all') { q += ' AND category = $1'; params.push(cat); }
    q += ' ORDER BY pinned DESC, created_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows.map(expandNoticeRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 읽지 않은 공지 수 (must be before :id route)
app.get('/api/notices/unread/count', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM notices n WHERE n.deleted = false AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_uid = $1)`,
      [req.uid]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 읽지 않은 공지 목록 (팝업용)
app.get('/api/notices/unread/list', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const result = await pool.query(
      `SELECT n.* FROM notices n WHERE n.deleted = false AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_uid = $1) ORDER BY n.pinned DESC, n.created_at DESC`,
      [req.uid]
    );
    res.json(result.rows.map(expandNoticeRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 읽음 일괄 처리
app.post('/api/notices/mark-read', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: true });
    for (const id of ids) {
      await pool.query('INSERT INTO notice_reads (notice_id, user_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.uid]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 작성 권한 여부 체크 (must be before :id route)
app.get('/api/notices/can-write', authMiddleware, async (req, res) => {
  const allowed = await canWriteNotice(req);
  res.json({ canWrite: allowed });
});

// 단일 조회
app.get('/api/notices/:id', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const result = await pool.query('SELECT * FROM notices WHERE id = $1 AND deleted = false', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    // 읽음 처리
    await pool.query('INSERT INTO notice_reads (notice_id, user_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.uid]);
    res.json(expandNoticeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notices/upload', authMiddleware, upload.array('images', 10), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const allowed = await canWriteNotice(req);
  if (!allowed) return res.status(403).json({ error: '작성 권한이 없습니다' });
  if (!req.files?.length) return res.status(400).json({ error: 'No images' });
  const attachments = req.files.map(file => ({
    url: '/uploads/' + file.filename,
    name: path.basename(decodeMultipartFilename(file.originalname || file.filename)),
    storedName: file.filename,
    mimeType: file.mimetype || null,
    size: file.size || null
  }));
  res.json({ attachments: normalizeNoticeAttachments(attachments) });
});

// 작성
app.post('/api/notices', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const allowed = await canWriteNotice(req);
  if (!allowed) return res.status(403).json({ error: '작성 권한이 없습니다' });
  try {
    const { category, title, content, pinned, productName, attachments } = req.body;
    const serializedContent = serializeNoticeContent(content, attachments);
    const result = await pool.query(
      `INSERT INTO notices (category, title, content, pinned, product_name, author_id, author_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [category || 'notice', title, serializedContent, pinned || false, productName || null, req.uid, req.userName]
    );
    // 작성자는 자동 읽음 처리
    await pool.query('INSERT INTO notice_reads (notice_id, user_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [result.rows[0].id, req.uid]);
    // FCM 푸시: 전체에게 알림 (작성자 제외)
    const icon = category === 'product' ? '📦' : '📢';
    sendPushToAll(
      `${icon} ${category === 'product' ? '상품 안내' : '공지사항'}`,
      title,
      req.uid,
      {
        kind: 'notice',
        link: '/?page=notice',
        tag: category === 'product' ? 'notice-product' : 'notice-general',
        page: 'notice'
      }
    );
    res.json(expandNoticeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 수정
app.put('/api/notices/:id', authMiddleware, async (req, res) => {
  const allowed = await canWriteNotice(req);
  if (!allowed) return res.status(403).json({ error: '수정 권한이 없습니다' });
  try {
    const { title, content, pinned, productName, attachments } = req.body;
    const current = await pool.query('SELECT content FROM notices WHERE id = $1 AND deleted = false', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });
    const previousAttachments = parseNoticeContent(current.rows[0].content).attachments;
    const serializedContent = serializeNoticeContent(content, attachments);
    const result = await pool.query(
      `UPDATE notices SET title=$1, content=$2, pinned=$3, product_name=$4, updated_at=NOW() WHERE id=$5 AND deleted=false RETURNING *`,
      [title, serializedContent, pinned || false, productName || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const currentAttachments = normalizeNoticeAttachments(attachments);
    const currentNames = new Set(currentAttachments.map(att => att.storedName || path.basename(att.url || '')));
    const removedAttachments = previousAttachments.filter(att => !currentNames.has(att.storedName || path.basename(att.url || '')));
    deleteNoticeFiles(removedAttachments);
    res.json(expandNoticeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 삭제
app.delete('/api/notices/:id', authMiddleware, async (req, res) => {
  const allowed = await canWriteNotice(req);
  if (!allowed) return res.status(403).json({ error: '삭제 권한이 없습니다' });
  try {
    const current = await pool.query('SELECT content FROM notices WHERE id = $1 AND deleted = false', [req.params.id]);
    if (current.rows[0]) deleteNoticeFiles(parseNoticeContent(current.rows[0].content).attachments);
    await pool.query('UPDATE notices SET deleted=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 작성자 권한 관리 (admin only)
app.get('/api/notice-writers', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await pool.query('SELECT * FROM notice_writers ORDER BY created_at');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notice-writers', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { userUid, userName } = req.body;
    const result = await pool.query(
      'INSERT INTO notice_writers (user_uid, user_name, granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_uid) DO NOTHING RETURNING *',
      [userUid, userName, req.uid]
    );
    res.json(result.rows[0] || { already: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/notice-writers/:uid', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM notice_writers WHERE user_uid = $1', [req.params.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ 일과표 (Timetable) ════════════════════════════════════════

// 일과표 조회 (날짜별) + 미완료 자동 이월
app.get('/api/timetable', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    // 미완료 자동 이월: 이전 날짜의 미완료 항목을 오늘로 복사
    const today = new Date().toISOString().slice(0, 10);
    if (date === today) {
      const overdue = await pool.query(
        `SELECT * FROM timetable_entries WHERE owner_id = $1 AND date < $2 AND done = false`,
        [req.uid, today]
      );
      for (const entry of overdue.rows) {
        // 이미 이월된 게 있는지 체크
        const exists = await pool.query(
          `SELECT 1 FROM timetable_entries WHERE owner_id = $1 AND date = $2 AND title = $3 AND carried_from = $4`,
          [req.uid, today, entry.title, entry.date]
        );
        if (!exists.rows.length) {
          await pool.query(
            `INSERT INTO timetable_entries (owner_id, date, start_time, end_time, title, event_id, sort_order, carried_from)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [req.uid, today, entry.start_time, entry.end_time, entry.title, entry.event_id, entry.sort_order, entry.date]
          );
        }
      }
    }
    const result = await pool.query(
      'SELECT * FROM timetable_entries WHERE owner_id = $1 AND date = $2 ORDER BY start_time, sort_order',
      [req.uid, date]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 캘린더 일정 불러오기용 (must be before :id routes)
app.get('/api/timetable/available-events', authMiddleware, async (req, res) => {
  console.log('[available-events] uid:', req.uid, 'date:', req.query.date, 'approved:', req.userDoc?.approved);
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const result = await pool.query(
      `SELECT e.* FROM events e
       WHERE e.owner_id = $1 AND e.date = $2 AND e.deleted = false
       AND (e.workspace_id = $3 OR (e.workspace_id IS NULL AND $3 = $4))
       AND NOT EXISTS (SELECT 1 FROM timetable_entries t WHERE t.event_id = e.id AND t.owner_id = $1 AND t.date = $2)
       ORDER BY e.time, e.created_at`,
      [req.uid, date, requestWorkspaceId(req), PEAK_WORKSPACE_ID]
    );
    console.log('[available-events] found:', result.rows.length);
    res.json(result.rows);
  } catch (err) { console.error('[available-events] ERROR:', err.message); res.status(500).json({ error: err.message }); }
});

// 일과표 항목 추가
app.post('/api/timetable', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  try {
    const { date, startTime, endTime, title, eventId } = req.body;
    const result = await pool.query(
      `INSERT INTO timetable_entries (owner_id, date, start_time, end_time, title, event_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.uid, date, startTime, endTime, title, eventId || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 일과표 체크 토글 (+ 캘린더 양방향 동기화)
app.put('/api/timetable/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const entry = await pool.query('SELECT * FROM timetable_entries WHERE id = $1 AND owner_id = $2', [req.params.id, req.uid]);
    if (!entry.rows.length) return res.status(404).json({ error: 'Not found' });
    const e = entry.rows[0];
    const newDone = !e.done;
    await pool.query('UPDATE timetable_entries SET done = $1 WHERE id = $2', [newDone, req.params.id]);
    // 캘린더 연동: event_id가 있으면 캘린더도 동기화
    if (e.event_id) {
      await pool.query('UPDATE events SET done = $1 WHERE id = $2 AND owner_id = $3', [newDone, e.event_id, req.uid]);
    }
    res.json({ ok: true, done: newDone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 일과표 항목 수정
app.put('/api/timetable/:id', authMiddleware, async (req, res) => {
  try {
    const { startTime, endTime, title } = req.body;
    const result = await pool.query(
      'UPDATE timetable_entries SET start_time=$1, end_time=$2, title=$3 WHERE id=$4 AND owner_id=$5 RETURNING *',
      [startTime, endTime, title, req.params.id, req.uid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 일과표 항목 삭제
app.delete('/api/timetable/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM timetable_entries WHERE id = $1 AND owner_id = $2', [req.params.id, req.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ 전날까지 미완료 할일 알림 (매일 오전 10시) ═══════════════
scheduleCron('* * * * *', async () => {
  try {
    await processEventReminderSweep();
  } catch (e) {
    console.error('[CRON] 일정 리마인더 에러:', e.message);
  }
}, { timezone: 'Asia/Seoul' });

scheduleCron('5 0 * * *', async () => {
  try {
    const result = await syncTodayReportReminders();
    console.log(`[CRON] 보고서 할 일 정리 완료 date=${result.date} created=${result.created} removed=${result.removed}`);
  } catch (e) {
    console.error('[CRON] 보고서 할 일 정리 에러:', e.message);
  }
}, { timezone: 'Asia/Seoul' });

// ══ 전날까지 미완료 할일 알림 (매일 오전 10시) ═══════════════
scheduleCron('0 10 * * *', async () => {
  console.log('[CRON] 미완료 할일 알림 전송 시작');
  try {
    const today = new Date().toISOString().slice(0, 10);
    // 각 사용자별 미완료 할일 수 조회
    const users = await pool.query(
      `SELECT u.uid, u.name, pwm.workspace_id
         FROM users u
         JOIN peakos_workspace_memberships pwm
           ON pwm.user_uid = u.uid
          AND pwm.active = TRUE
          AND pwm.is_default = TRUE
          AND pwm.role <> 'oversight'
        WHERE u.approved = true AND u.is_active != false`,
    );
    for (const user of users.rows) {
      const overdue = await pool.query(
        `SELECT COUNT(*) FROM events
          WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date < $2
            AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
        [user.uid, today, user.workspace_id, PEAK_WORKSPACE_ID]
      );
      const count = parseInt(overdue.rows[0].count);
      if (count > 0) {
        // 상위 3개 제목 가져오기
        const top = await pool.query(
          `SELECT title FROM events
            WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date < $2
              AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))
            ORDER BY date LIMIT 3`,
          [user.uid, today, user.workspace_id, PEAK_WORKSPACE_ID]
        );
        const titles = top.rows.map(r => r.title).join(', ');
        const extra = count > 3 ? ` 외 ${count - 3}건` : '';
        await sendPushToUser(user.uid, `⚠️ 전날까지 미완료 ${count}건`, `${titles}${extra}`, {
          kind: 'overdue-morning',
          link: '/?page=calendar&tab=list&filter=incomplete',
          tag: 'overdue-todos',
          page: 'calendar',
          tab: 'list',
          filter: 'incomplete'
        });
      }
    }
    console.log('[CRON] 미완료 할일 알림 전송 완료');
  } catch(e) { console.error('[CRON] 에러:', e.message); }
}, { timezone: 'Asia/Seoul' });

// ══ 오늘 미완료 할일 알림 (평일 오후 7시) ═══════════════════
scheduleCron('0 19 * * 1-5', async () => {
  console.log('[CRON] 오늘 미완료 할일 알림 전송 시작');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const users = await pool.query(
      `SELECT u.uid, pwm.workspace_id
         FROM users u
         JOIN peakos_workspace_memberships pwm
           ON pwm.user_uid = u.uid
          AND pwm.active = TRUE
          AND pwm.is_default = TRUE
          AND pwm.role <> 'oversight'
        WHERE u.approved = true AND u.is_active != false`,
    );
    for (const user of users.rows) {
      const pending = await pool.query(
        `SELECT COUNT(*) FROM events
          WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date = $2
            AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))`,
        [user.uid, today, user.workspace_id, PEAK_WORKSPACE_ID]
      );
      const count = parseInt(pending.rows[0].count);
      if (count > 0) {
        const top = await pool.query(
          `SELECT title FROM events
            WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date = $2
              AND (workspace_id = $3 OR (workspace_id IS NULL AND $3 = $4))
            ORDER BY time NULLS FIRST, created_at LIMIT 3`,
          [user.uid, today, user.workspace_id, PEAK_WORKSPACE_ID]
        );
        const titles = top.rows.map(r => r.title).join(', ');
        const extra = count > 3 ? ` 외 ${count - 3}건` : '';
        await sendPushToUser(user.uid, `📌 오늘 미완료 ${count}건`, `${titles}${extra}`, {
          kind: 'today-evening',
          link: '/?page=calendar&tab=list&filter=today_incomplete',
          tag: 'today-todos-evening',
          page: 'calendar',
          tab: 'list',
          filter: 'today_incomplete'
        });
      }
    }
    console.log('[CRON] 오늘 미완료 할일 알림 전송 완료');
  } catch (e) {
    console.error('[CRON] 저녁 알림 에러:', e.message);
  }
}, { timezone: 'Asia/Seoul' });

// ══ FCM 토큰 관리 ══════════════════════════════════════
app.get('/api/fcm/status', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS token_count, MAX(created_at) AS last_registered_at FROM fcm_tokens WHERE user_uid = $1',
      [req.uid]
    );
    res.json({
      tokenCount: parseInt(result.rows[0]?.token_count || '0', 10),
      lastRegisteredAt: result.rows[0]?.last_registered_at || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fcm/test', authMiddleware, async (req, res) => {
  try {
    const tokens = await pool.query('SELECT token FROM fcm_tokens WHERE user_uid = $1', [req.uid]);
    if (!tokens.rows.length) return res.status(400).json({ error: '등록된 기기 토큰이 없습니다.' });

    let sentCount = 0;
    let failedCount = 0;
    const body = `테스트 시각 ${new Date().toLocaleString('ko-KR')}`;
    const message = buildWebPushMessage('🔔 피크마케팅 푸시 테스트', body, {
      kind: 'chat',
      link: '/?page=more',
      tag: 'fcm-test',
      page: 'more'
    });

    for (const row of tokens.rows) {
      try {
        await sendFirebaseMessage({ ...message, token: row.token });
        sentCount += 1;
      } catch (e) {
        failedCount += 1;
        if (isInvalidFcmTokenError(e)) {
          await pool.query('DELETE FROM fcm_tokens WHERE token = $1', [row.token]);
        } else {
          console.error('FCM test token error:', e.code || e.message);
        }
      }
    }

    res.json({ tokenCount: tokens.rows.length, sentCount, failedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fcm/register', authMiddleware, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    await pool.query(
      'INSERT INTO fcm_tokens (user_uid, token) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_uid = $1, created_at = NOW()',
      [req.uid, token]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = Number(process.env.PORT || 4100);

// ── PEAK OS 추가 이메일 인증 ────────────────────────────────
// OS_EMAIL_OTP_MODE=off/all 또는 OS_EMAIL_OTP_REQUIRED_UIDS를 반드시
// 명시한다. 메일 transport가 없더라도 서버는 기동하되 대상 사용자의
// 발송 요청은 안전하게 503으로 거부한다.
const peakosOsEmailMailer = createEmailMailerFromEnv(process.env);
peakosOsEmailAuth = registerOsEmailAuth({
  app,
  authMiddleware,
  pool,
  mailer: peakosOsEmailMailer,
  hmacSecret: process.env.PEAKOS_OS_AUTH_HMAC_SECRET,
});

registerPeakosWorkspaceRoutes({
  app,
  authMiddleware,
  requireOsSession: peakosOsEmailAuth.requireOsSession,
  service: peakosWorkspaceService,
});

// PEAK OS 정산·통장 API는 화면을 숨기는 것에 의존하지 않는다.
// 파일럿 대상이면 Firebase 인증 뒤 서버 발급 OS 세션까지 매 요청 확인한다.
app.use(
  '/api/peakos',
  authMiddleware,
  peakosOsEmailAuth.requireOsSession,
  peakosWorkspaceService.requireSelectedWorkspace(),
);

// Until a PEAK OS route explicitly includes workspace_id in every read/write,
// branch requests fail closed. This is intentionally stricter than returning
// Peak data. Prices, workspace documents, and the settlement module below are
// explicitly workspace-scoped; banking/reporting routes remain blocked until
// their query modules are fully migrated.
app.use('/api/peakos', (req, res, next) => {
  if (req.workspace?.id === PEAK_WORKSPACE_ID) return next();
  const routePath = String(req.path || '');
  if (/^\/prices(?:\/|$)/.test(routePath)
      || /^\/company-documents(?:\/|$)/.test(routePath)
      || /^\/intake(?:\/|$)/.test(routePath)
      || /^\/monthly(?:\/|$)/.test(routePath)
      || /^\/monthly-settlement(?:\/|$)/.test(routePath)
      || /^\/settlement-completion(?:\/|$)/.test(routePath)
      || /^\/vendor-reconciliations(?:\/|$)/.test(routePath)
      || /^\/commission-(?:rules|estimates|calculations)(?:\/|$)/.test(routePath)
      || /^\/company-resources(?:\/|$)/.test(routePath)
      || /^\/finance-requests(?:\/|$)/.test(routePath)
      || /^\/sales-leads(?:\/|$)/.test(routePath)
      || /^\/attendance(?:\/|$)/.test(routePath)
      || /^\/todos(?:\/|$)/.test(routePath)
      || /^\/final-execution(?:\/|$)/.test(routePath)) return next();
  return res.status(403).json({
    code: 'PEAKOS_WORKSPACE_SURFACE_NOT_MIGRATED',
    error: '이 기능은 지사 워크스페이스 격리 적용 후 사용할 수 있습니다.',
  });
});

registerPeakosAttendanceRoutes({
  app,
  pool,
  readMiddlewares: [
    peakosWorkspaceService.requireWorkspace({
      area: 'settlements', action: 'read', requireHeader: true,
    }),
  ],
  writeMiddlewares: [
    peakosWorkspaceService.requireWorkspace({
      area: 'settlements', action: 'write', requireHeader: true,
    }),
  ],
  logger: console,
});


// ─────────────────────────────────────────────────────────────
// PEAK OS 정산 — 브라우저 초안을 계정·workspace 기준 서버 저장으로 옮긴다.
// direct member는 자기 workspace만 쓰고, 본사 oversight는 지사 원장을 읽기만 한다.
// 화면 쪽 권한과 같은 기준을 서버에서도 다시 막는다.
// ─────────────────────────────────────────────────────────────
const PEAKOS_MONTHLY_OWNERS = PEAKOS_ACCESS_POLICY.monthlyOwners;
const peakosAccess = createPeakosAccess({ userPool: pool });
const peakosName = req => peakosAccess.name(req);
const peakosApprovedActive = req => peakosAccess.approvedActive(req);
const peakosCanSeeAll = req => peakosAccess.canSeeAll(req);
const peakosCanSeeTeam = req => peakosAccess.canSeeTeam(req);
const peakosCanSeeMonthly = (req, view) => peakosAccess.canSeeMonthly(req, view);
const peakosCanManageMonthly = (req, view) => peakosAccess.canManageMonthly(req, view);
const peakosCanSeeFinalExecution = req => peakosAccess.canSeeFinalExecution(req);
const peakosCanSeeFinanceOperations = req => peakosAccess.canSeeFinanceOperations(req);
const peakosCanSeeFinalSettlement = req => peakosAccess.canSeeFinalSettlement(req);
const peakosIsNonPeakSettlementManager = req => (
  req.workspace?.id
  && req.workspace.id !== PEAK_WORKSPACE_ID
  && req.workspace.headquartersOversight !== true
  && req.workspace.permissions?.settlements === 'write'
  && ['admin', 'manager'].includes(req.workspace.role)
);
const peakosCanSeeWorkspaceSettlementAll = req => (
  peakosCanSeeFinalSettlement(req) || peakosIsNonPeakSettlementManager(req)
);
const peakosCanSeeWorkspaceFinalExecution = req => (
  peakosCanSeeFinalExecution(req) || peakosIsNonPeakSettlementManager(req)
);
const peakosCanSeeTeamFinance = req => (
  peakosCanSeeFinanceOperations(req) && peakosCanSeeTeam(req)
);
const peakosCanPreviewAccounts = req => peakosAccess.canPreviewAccounts(req);
const peakosCanViewStructuredProjectPortfolio = req => (
  peakosAccess.canViewStructuredProjectPortfolio(req)
);
const peakosCanCreateStructuredProject = req => (
  peakosAccess.canCreateStructuredProject(req)
);
function peakosOwnedMonthlyViews(req) {
  return Object.keys(PEAKOS_MONTHLY_OWNERS).filter(view => peakosCanManageMonthly(req, view));
}
const peakosCanReadOwnerUid = (req, ownerUid) => peakosAccess.canReadOwnerUid(req, ownerUid);
const peakosBankCanRead = req => peakosAccess.canReadBank(req);
const peakosBankCanViewBalances = req => peakosAccess.canViewBankBalances(req);
const peakosCanReviewFinance = req => peakosAccess.canReviewFinance(req);
const peakosCanSeeTaxPurchase = req => peakosAccess.canSeeTaxPurchase(req);

// OS report metrics are never exposed through the legacy Firebase-only
// `/api/reports/*` surface. The protected alias requires the email session,
// selected workspace, and settlements read permission established above.
app.get(
  '/api/peakos/reports/sales-summary',
  peakosWorkspaceService.requireWorkspace({
    area: 'settlements', action: 'read', requireHeader: true,
  }),
  handlePeakosSalesSummary,
);

// Both the canonical and protected-alias URLs are OS-only. Rechecking the
// email session and explicit workspace here keeps `/api/new-projects` from
// becoming a Firebase-only second-factor bypass.
registerPeakosNewProjectRoutes({
  app,
  pool,
  readMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'projects', action: 'read', requireHeader: true }),
  ],
  writeMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'projects', action: 'write', requireHeader: true }),
  ],
  peakWorkspaceId: PEAK_WORKSPACE_ID,
  isPortfolioViewer: peakosCanViewStructuredProjectPortfolio,
  isPortfolioCreator: peakosCanCreateStructuredProject,
  notifyUser: sendPushToUser,
});

// PEAK OS personal todos intentionally use a standalone, self-owned store.
// Both reads and writes require the OS email session and an explicitly
// selected direct workspace; the calendar permission is rechecked here even
// though authMiddleware also classifies this protected path as calendar data.
registerPeakosTodoRoutes({
  app,
  pool,
  readMiddlewares: [
    peakosWorkspaceService.requireWorkspace({ area: 'calendar', action: 'read', requireHeader: true }),
  ],
  writeMiddlewares: [
    peakosWorkspaceService.requireWorkspace({ area: 'calendar', action: 'write', requireHeader: true }),
  ],
});

// 아이디어 창구는 워크스페이스 구성원 누구나 쓴다. 상태 변경만 관리자 몫이다.
registerPeakosIdeaRoutes({
  app,
  pool,
  isManager: req => ['admin', 'manager'].includes(String(req?.workspace?.role || '')),
  readMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'projects', action: 'read', requireHeader: true }),
  ],
  writeMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'projects', action: 'write', requireHeader: true }),
  ],
});

// 개발비는 등록된 다섯 사람만 본다. 그 판단은 라우트 안에서 DB로 하고,
// 여기서는 로그인·워크스페이스만 확인한다.
registerPeakosDevExpenseRoutes({
  app,
  pool,
  readMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'read', requireHeader: true }),
  ],
  writeMiddlewares: [
    authMiddleware,
    peakosOsEmailAuth.requireOsSession,
    peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'read', requireHeader: true }),
  ],
});

app.use(
  '/api/peakos/company-documents',
  peakosWorkspaceService.requireWorkspace({ area: 'documents', action: 'read', requireHeader: true }),
  (req, res, next) => {
    if (req.workspace?.id === PEAK_WORKSPACE_ID) return next();
    if (String(req.method).toUpperCase() !== 'GET') {
      return res.status(403).json({
        code: 'PEAKOS_WORKSPACE_READ_ONLY',
        error: '지사 자료 업로드는 전용 비공개 저장소 쓰기 기능 연결 후 사용할 수 있습니다.',
      });
    }
    const contentMatch = String(req.path || '').match(/^\/([A-Za-z0-9:_-]{1,160})\/content\/?$/);
    if (contentMatch) {
      req.params = { ...req.params, id: contentMatch[1] };
      return peakosWorkspaceDocumentService.content(req, res);
    }
    if (req.path === '/' || req.path === '') {
      return peakosWorkspaceDocumentService.list(req, res);
    }
    return res.status(404).json({
      code: 'WORKSPACE_DOCUMENT_NOT_FOUND',
      error: '이 워크스페이스에는 해당 자료가 없습니다.',
    });
  },
);

registerPeakosCompanyDocuments({
  app,
  root: process.env.PEAKOS_COMPANY_DOCUMENT_ROOT || undefined,
  canRead: peakosCanSeeAll,
  logger: console,
});

async function peakosAfterBankSync(context) {
  // 거래 원장 자체를 durable work queue로 사용한다. 매 동기화 때 조회기간과
  // 무관하게 남아 있는 모든 UNMATCHED/PROPOSED를 재시도하므로 일시 장애가
  // 하루 조회창 밖으로 밀려 영구 누락되지 않는다.
  const base = { pool, accountId: context.accountId, requestId: context.requestId };
  const intake = await reconcileAccountTransactions(base);
  const credit = await reconcileCreditRequests(base);
  return { intake, credit };
}

const peakosIbkCollector = createIbkQuickCollector({
  enabled: process.env.PEAKOS_IBK_ENABLED === 'true',
});
const peakosIbkSchedulerEnabled = process.env.PEAKOS_IBK_SCHEDULER_ENABLED === 'true';
const peakosAutoReconciliationEnabled = AUTO_MATCH_MAX_AGE_DAYS > 0;

// 통장 원장은 대표·경영지원 지정 인원만 본다. collector는 아래 조립부에서
// 조회 전용 자식 worker만 주입하며, 정산/충전 후속 처리는 은행 원장 COMMIT
// 이후 별도 트랜잭션으로 실행한다.
const peakosBankService = registerPeakosBanking({
  app,
  authMiddleware,
  pool,
  canRead: peakosBankCanRead,
  canReadTaxPurchase: peakosCanSeeTaxPurchase,
  canViewBalances: peakosBankCanViewBalances,
  // 민감 두 통장과 잔액 권한을 가진 동일 4명만 수동 동기화한다.
  canSync: peakosBankCanViewBalances,
  getActor: req => ({ uid: req.uid, name: peakosName(req) }),
  collector: peakosIbkCollector,
  afterSync: peakosAfterBankSync,
  autoReconciliationEnabled: peakosAutoReconciliationEnabled,
});

let peakosScheduledSyncRunning = false;
function startPeakosBankScheduler() {
  if (!peakosIbkCollector || !peakosIbkSchedulerEnabled) return null;
  return scheduleCron('*/10 * * * *', async () => {
    if (peakosScheduledSyncRunning) return;
    peakosScheduledSyncRunning = true;
    try {
      for (const accountId of IBK_ACCOUNT_IDS) {
        try {
          const result = await peakosBankService.syncAccount({
            accountId,
            triggerType: 'SCHEDULED',
            actor: { uid: 'system:ibk-scheduler', name: 'IBK 자동동기화' },
            requestId: crypto.randomUUID(),
          });
          console.log(
            `[PEAK OS] IBK sync account=${accountId} fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} afterSync=${result.afterSync?.ok === true}`,
          );
        } catch (error) {
          const safeCode = /^[A-Z0-9_]{1,80}$/.test(String(error?.code || ''))
            ? error.code
            : 'BANK_SYNC_FAILED';
          console.error(`[PEAK OS] IBK sync account=${accountId} code=${safeCode}`);
        }
      }
    } finally {
      peakosScheduledSyncRunning = false;
    }
  }, { timezone: 'Asia/Seoul' });
}

registerPeakosCreditRequests({
  app,
  authMiddleware,
  pool,
  canReview: peakosBankCanViewBalances,
  // 일반 영업자는 본인 요청만 만들고 읽는다. 회사 충전금 장부와 전체
  // 요청 검토는 기존 UID 기반 재무 capability를 그대로 사용한다.
  canRequest: req => peakosApprovedActive(req)
    && (String(req.userDoc?.group_type || '').trim() === 'sales'
      || peakosCanSeeFinanceOperations(req)),
  getActor: req => ({ uid: req.uid, name: peakosName(req) }),
  readMiddlewares: [
    peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'read', requireHeader: true }),
  ],
  writeMiddlewares: [
    peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'write', requireHeader: true }),
  ],
});

registerPeakosSettlementRoutes({
  app,
  authMiddleware,
  pool,
  monthlyOwners: PEAKOS_MONTHLY_OWNERS,
  approvedActive: peakosApprovedActive,
  getName: peakosName,
  // Peak 전체 원장은 지정 계정만, 지점 전체 원장은 해당 지점의 direct
  // admin/manager만 조회·관리한다. HQ oversight는 module에서 GET-only다.
  canSeeAll: peakosCanSeeWorkspaceSettlementAll,
  canReadOwnerUid: peakosCanReadOwnerUid,
  canManageMonthly: peakosCanManageMonthly,
  canSeeMonthly: peakosCanSeeMonthly,
  canSeeFinalExecution: peakosCanSeeWorkspaceFinalExecution,
  canReviewFinance: peakosCanReviewFinance,
  canManageBankEligibility: peakosBankCanViewBalances,
  autoReconciliationEnabled: peakosAutoReconciliationEnabled,
  getWorkspaceId: req => requestWorkspaceId(req),
  logger: console,
});

registerPeakosVendorReconciliationRoutes({
  app,
  authMiddleware,
  pool,
  approvedActive: peakosApprovedActive,
  getName: peakosName,
  canReviewFinance: peakosCanReviewFinance,
  getWorkspaceId: req => requestWorkspaceId(req),
  logger: console,
});

// 비품·개발비·통장사본·기타 회사자료는 표시명 배열이 아니라 exact UID
// finance capability와 DB의 활성 direct workspace membership을 함께 확인한다.
// 파일은 public uploads 밖의 전용 보호 저장소에만 기록된다.
registerPeakosCompanyResourceRoutes({
  app,
  authMiddleware,
  pool,
  canSeeFinanceOperations: peakosCanSeeFinanceOperations,
  canReviewFinance: peakosCanReviewFinance,
  getName: peakosName,
  logger: console,
});

registerPeakosSettlementCompletionRoutes({
  app,
  authMiddleware,
  pool,
  approvedActive: peakosApprovedActive,
  getName: peakosName,
  // 원본 owner와 workspace manager/admin/oversight는 정책 모듈이 직접
  // 판정하고, Peak의 지정 최종실행 열람자만 이 capability로 추가한다.
  canSeeAll: peakosCanSeeWorkspaceFinalExecution,
  getWorkspaceId: req => requestWorkspaceId(req),
  logger: console,
});

// 수당률은 기본값을 추정하지 않는다. 현재 workspace의 명시적 승인 규칙만
// 서버가 원본 접수·공급사 대사 근거와 함께 재계산해 별도 예상 수당으로 낸다.
registerPeakosCommissionRoutes({
  app,
  authMiddleware,
  pool,
  getName: peakosName,
  getWorkspaceId: req => requestWorkspaceId(req),
  logger: console,
});

// 전 계정 공통 월 정산은 기존 개인 원장과 플랫폼 원장을 섞어 쓰지 않고
// 동일 응답의 독립된 두 섹션으로 제공한다. `/api/peakos` 전역 게이트가
// Firebase + OS 이메일 세션 + 명시 workspace를 이미 검증했으며, 라우트는
// direct 활성 계정의 req.uid만 사용해 admin/manager도 v1에서는 본인만 본다.
registerPeakosPlatformMonthlySettlementRoutes({
  app,
  pool,
  peakWorkspaceId: PEAK_WORKSPACE_ID,
  getWorkspaceId: req => requestWorkspaceId(req),
  logger: console,
});


// 단가표는 회사 공용. 읽기는 전원, 쓰기는 지정 인원만.
app.get('/api/peakos/prices', authMiddleware, peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'read', requireHeader: true }), async (req, res) => {
  if (!peakosApprovedActive(req)) {
    return res.status(403).json({ error: '승인된 활성 계정만 단가표를 볼 수 있습니다.' });
  }
  try {
    // 회사 원가는 지정된 인원에게만 내려보낸다. 그 밖에는 서버 밖으로 나가지 않는다.
    const showCost = peakosCanSeeFinalSettlement(req)
      || (!req.workspace?.headquartersOversight && ['admin', 'manager'].includes(req.workspace?.role));
    const result = await pool.query(
      `SELECT *,
              (is_base AND (cost IS DISTINCT FROM default_cost
                OR unit IS DISTINCT FROM default_unit)) AS edited
         FROM peakos_price
        WHERE workspace_id = $1
        ORDER BY a, b, c`,
      [requestWorkspaceId(req)],
    );
    res.json(result.rows.map(row => ({
      key: row.key, a: row.a, b: row.b, c: row.c,
      cost: showCost && row.cost !== null ? Number(row.cost) : null,
      unit: row.unit === null ? null : Number(row.unit),
      custom: row.is_custom, edited: row.edited === true, updatedBy: row.updated_by || ''
    })));
  } catch (err) {
    console.error('peakos price read error:', err.message);
    res.status(500).json({ error: '단가표를 불러오지 못했습니다.' });
  }
});

app.put('/api/peakos/prices', authMiddleware, peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'write', requireHeader: true }), async (req, res) => {
  if (!peakosCanSeeFinalSettlement(req)
      && !(!req.workspace?.headquartersOversight && ['admin', 'manager'].includes(req.workspace?.role))) {
    return res.status(403).json({ error: '단가표는 지정된 인원만 고칠 수 있습니다.' });
  }
  const { key, a, b, c, cost, unit, custom } = req.body || {};
  if (!key || !a || !b || !c) return res.status(400).json({ error: '분류를 모두 채워 주세요.' });
  const num = value => (value === '' || value === null || value === undefined ? null : Number(value));
  const rawParts = [String(a), String(b), String(c)];
  if (rawParts[0].length > 80 || rawParts[1].length > 80 || rawParts[2].length > 120
      || rawParts.some(value => /[\u0000-\u001f\u007f|]/u.test(value))) {
    return res.status(400).json({ error: '단가표 분류에 허용되지 않은 문자나 길이가 있습니다.' });
  }
  const canonicalKey = peakosPriceKey(
    rawParts[0],
    rawParts[1],
    rawParts[2],
  );
  if (String(key) !== canonicalKey) {
    return res.status(400).json({ error: '단가표 키와 분류가 일치하지 않습니다.' });
  }
  const normalizedCost = num(cost);
  const normalizedUnit = num(unit);
  if ((normalizedCost !== null && (!Number.isSafeInteger(normalizedCost)
        || normalizedCost < 0 || normalizedCost > 1_000_000_000_000))
      || (normalizedUnit !== null && (!Number.isSafeInteger(normalizedUnit)
        || normalizedUnit < 0 || normalizedUnit > 1_000_000_000_000))) {
    return res.status(400).json({ error: '원가와 단가를 올바른 숫자로 입력해 주세요.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT key, a, b, c, is_base, is_custom FROM peakos_price WHERE workspace_id = $1 AND key = $2 FOR UPDATE',
      [requestWorkspaceId(req), canonicalKey],
    );
    if (existing.rows[0]
        && (existing.rows[0].a !== rawParts[0]
          || existing.rows[0].b !== rawParts[1]
          || existing.rows[0].c !== rawParts[2])) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '기존 단가표 키의 분류 정보와 충돌합니다.' });
    }
    if (!existing.rows[0] && custom !== true) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '새 상품은 사용자 추가 상품으로만 등록할 수 있습니다.' });
    }
    if (!existing.rows[0] && rawParts.some(value => value !== value.trim())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '새 상품 분류 앞뒤의 공백을 제거해 주세요.' });
    }
    await client.query(
      `INSERT INTO peakos_price (workspace_id, key, a, b, c, cost, unit, is_custom, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (workspace_id, key) DO UPDATE SET cost = EXCLUDED.cost, unit = EXCLUDED.unit,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [requestWorkspaceId(req), canonicalKey, rawParts[0], rawParts[1], rawParts[2],
       normalizedCost, normalizedUnit, existing.rows[0]?.is_custom === true || custom === true, peakosName(req)]
    );
    await client.query('COMMIT');
    res.json({ saved: canonicalKey });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('peakos price write error:', err.message);
    res.status(500).json({ error: '단가표를 저장하지 못했습니다.' });
  } finally {
    client.release();
  }
});

app.delete('/api/peakos/prices/:key', authMiddleware, peakosWorkspaceService.requireWorkspace({ area: 'settlements', action: 'write', requireHeader: true }), async (req, res) => {
  if (!peakosCanSeeFinalSettlement(req)
      && !(!req.workspace?.headquartersOversight && ['admin', 'manager'].includes(req.workspace?.role))) {
    return res.status(403).json({ error: '단가표는 지정된 인원만 고칠 수 있습니다.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT key, is_base, is_custom FROM peakos_price WHERE workspace_id = $1 AND key = $2 FOR UPDATE',
      [requestWorkspaceId(req), req.params.key],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '단가표 항목을 찾지 못했습니다.' });
    }
    if (found.rows[0].is_base) {
      await client.query(
        `UPDATE peakos_price
            SET cost = default_cost, unit = default_unit,
                updated_by = $3, updated_at = NOW()
          WHERE workspace_id = $1 AND key = $2`,
        [requestWorkspaceId(req), req.params.key, peakosName(req)],
      );
      await client.query('COMMIT');
      return res.json({ reset: req.params.key });
    }
    if (!found.rows[0].is_custom) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '기본·시스템 단가표 항목은 삭제할 수 없습니다.' });
    }
    await client.query(
      'DELETE FROM peakos_price WHERE workspace_id = $1 AND key = $2',
      [requestWorkspaceId(req), req.params.key],
    );
    await client.query('COMMIT');
    res.json({ deleted: req.params.key });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('peakos price delete error:', err.message);
    res.status(500).json({ error: '단가표를 지우지 못했습니다.' });
  } finally {
    client.release();
  }
});

// 충전금 — 회사 돈이라 지정 인원만.
app.get('/api/peakos/credit', authMiddleware, async (req, res) => {
  if (!peakosCanSeeFinanceOperations(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 볼 수 있습니다.' });
  try {
    const result = await pool.query('SELECT * FROM peakos_credit ORDER BY date DESC, created_at DESC');
    res.json(result.rows.map(row => ({
      id: row.id, date: String(row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date).slice(0, 10),
      client: row.client || '', product: row.product || '', vendor: row.vendor || '',
      kind: row.kind, paid: Number(row.paid) || 0, point: Number(row.point) || 0,
      memo: row.memo || '', ownerName: row.owner_name || ''
    })));
  } catch (err) {
    console.error('peakos credit read error:', err.message);
    res.status(500).json({ error: '충전금을 불러오지 못했습니다.' });
  }
});

app.post('/api/peakos/credit', authMiddleware, async (req, res) => {
  if (!peakosCanSeeFinanceOperations(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 기입할 수 있습니다.' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body];
  if (!rows.length || rows.length > 500) return res.status(400).json({ error: '한 번에 1~500건까지 저장할 수 있습니다.' });
  try {
    for (const body of rows) {
      if (!body.id || !body.date) return res.status(400).json({ error: 'id와 일자는 반드시 있어야 합니다.' });
      await pool.query(
        `INSERT INTO peakos_credit (id, owner_uid, owner_name, date, client, product, vendor, kind, paid, point, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, client = EXCLUDED.client,
           product = EXCLUDED.product, vendor = EXCLUDED.vendor, kind = EXCLUDED.kind,
           paid = EXCLUDED.paid, point = EXCLUDED.point, memo = EXCLUDED.memo`,
        [String(body.id).slice(0, 80), req.uid, peakosName(req), String(body.date).slice(0, 10),
         String(body.client || '').slice(0, 200), String(body.product || '').slice(0, 80),
         String(body.vendor || '').slice(0, 120),
         ['charge', 'use', 'refund'].includes(body.kind) ? body.kind : 'charge',
         Number(body.paid) || 0, Number(body.point) || 0, String(body.memo || '').slice(0, 500)]
      );
    }
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('peakos credit write error:', err.message);
    res.status(500).json({ error: '충전금을 저장하지 못했습니다.' });
  }
});

app.delete('/api/peakos/credit/:id', authMiddleware, async (req, res) => {
  if (!peakosCanSeeFinanceOperations(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 지울 수 있습니다.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 자동 승인기는 먼저 request 행을 잠근다. 같은 행을 여기서도 잠가
    // 승인 직후 생성된 장부가 수동 삭제로 사라지는 경쟁 상태를 막는다.
    const request = await client.query(
      'SELECT status FROM peakos_credit_requests WHERE id = $1 FOR UPDATE',
      [req.params.id],
    );
    if (request.rows[0]?.status === 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '통장 입금으로 자동 승인된 충전금은 요청·거래 감사기록과 함께 보존해야 합니다.' });
    }
    const deleted = await client.query(
      'DELETE FROM peakos_credit WHERE id = $1 RETURNING id',
      [req.params.id],
    );
    if (!deleted.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '충전금 장부에서 찾지 못했습니다.' });
    }
    await client.query('COMMIT');
    res.json({ deleted: deleted.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('peakos credit delete error:', err.message);
    res.status(500).json({ error: '충전금을 지우지 못했습니다.' });
  } finally {
    client.release();
  }
});

// 자금 현황판 — 회사에 하나. 대표·김대호·박종원만.
app.get('/api/peakos/fund', authMiddleware, async (req, res) => {
  if (!peakosCanSeeTeamFinance(req)) return res.status(403).json({ error: '자금 현황은 지정된 인원만 볼 수 있습니다.' });
  try {
    const result = await pool.query(
      'SELECT board, updated_by, updated_at FROM peakos_fund WHERE workspace_id = $1 AND id = 1',
      [requestWorkspaceId(req)],
    );
    res.json(result.rows[0]?.board || null);
  } catch (err) {
    console.error('peakos fund read error:', err.message);
    res.status(500).json({ error: '자금 현황을 불러오지 못했습니다.' });
  }
});

app.put('/api/peakos/fund', authMiddleware, async (req, res) => {
  if (!peakosCanSeeTeamFinance(req)) return res.status(403).json({ error: '자금 현황은 지정된 인원만 고칠 수 있습니다.' });
  const board = req.body?.board;
  if (!board || typeof board !== 'object') return res.status(400).json({ error: '보낼 내용이 없습니다.' });
  try {
    await pool.query(
      `INSERT INTO peakos_fund (workspace_id, id, board, updated_by, updated_at) VALUES ($1, 1, $2, $3, now())
       ON CONFLICT (workspace_id, id) DO UPDATE SET board = EXCLUDED.board, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [requestWorkspaceId(req), JSON.stringify(board), peakosName(req)]
    );
    res.json({ saved: true });
  } catch (err) {
    console.error('peakos fund write error:', err.message);
    res.status(500).json({ error: '자금 현황을 저장하지 못했습니다.' });
  }
});

async function startServer() {
  try {
    await peakosAccess.load();
    // Fail before any startup helper can write when the operator-owned
    // workspace migration has not been applied. This is a SELECT-only
    // readiness check; application startup never attempts owner DDL here.
    await ensurePeakosWorkspaceInfrastructure(pool);
    await ensurePeakosCompanyResourceInfrastructure(pool);
    // Attendance is operator-migrated as well. Verify its exact tenant/time/
    // audit contract before any legacy startup helper can perform writes.
    await ensurePeakosAttendanceInfrastructure(pool);
    await ensurePeakosEventVisibilityInfrastructure(pool);
    await ensurePeakosEventChecklistDirectiveInfrastructure(pool);
    await ensureEventTimeRangeInfrastructure(pool);
    await ensurePeakosNewProjectInfrastructure(pool);
    await ensurePeakosTodoInfrastructure(pool);
    await ensurePeakosSalesLeadInfrastructure(pool, {
      encryptionSecret: process.env.PEAKOS_SALES_PII_ENCRYPTION_SECRET,
    });
    await ensureReminderInfrastructure();
    await ensureChatPerformanceIndexes();
    await ensureChatRoomGroupInfrastructure();
    await ensureServiceRequestInfrastructure();
    await ensureIdeaInfrastructure();
    await ensureExternalCalendarInfrastructure();
    await ensureProjectInfrastructure();
    await ensureReportReminderInfrastructure();
    await ensurePeakosCoreInfrastructure(pool);
    await ensurePeakosBankInfrastructure(pool);
    await ensurePeakosBankReconciliationInfrastructure(pool);
    await ensureSettlementImportInfrastructure(pool);
    await ensureSettlementCompletionInfrastructure(pool);
    await ensurePeakosVendorReconciliationInfrastructure(pool);
    await ensurePeakosCommissionInfrastructure(pool);
    await ensurePeakosPlatformSettlementInfrastructure(pool);
    const peakosPlatformSettlementSyncService = createPlatformSettlementSyncService({
      pool,
      env: process.env,
      fetchImpl: globalThis.fetch,
      importMonthlySnapshot: importPlatformMonthlyAggregateSnapshot,
      calculateSnapshotDigest: calculatePlatformMonthlyAggregateDigest,
      logger: {
        error(message, metadata = {}) {
          const provider = /^[a-z0-9_-]{1,40}$/.test(String(metadata.provider || ''))
            ? metadata.provider
            : 'unknown';
          const month = /^20\d{2}-(0[1-9]|1[0-2])$/.test(String(metadata.month || ''))
            ? metadata.month
            : 'unknown';
          const code = /^PLATFORM_[A-Z0-9_]{1,71}$/.test(String(metadata.code || ''))
            ? metadata.code
            : 'PLATFORM_CONNECTOR_SYNC_FAILED';
          console.error(`[PEAK OS] platform connector provider=${provider} month=${month} code=${code}`);
        },
      },
    });
    // 키가 제거된 공급사를 이전 ready 상태로 남겨 두지 않는다. 이 작업은
    // 공급사 호출 없이 DB의 연결 상태만 정리하며, 스케줄러 비활성화와
    // 무관하게 시작 시 한 번 실행한다.
    await peakosPlatformSettlementSyncService.reconcileConnectionStates();
    peakosPlatformSettlementSyncRuntime = createPlatformSettlementSyncRuntime({
      service: peakosPlatformSettlementSyncService,
      scheduleCron,
      enabled: process.env.PEAKOS_PLATFORM_SYNC_ENABLED === 'true',
      backgroundJobsEnabled,
      logger: console,
    });
    await ensurePeakosCreditRequestInfrastructure(pool);
    await ensurePeakosFinanceRequestInfrastructure(pool);
    await ensurePeakosTaxInvoiceEvidenceInfrastructure(pool);
    await ensureOsEmailAuthInfrastructure(pool);
    await peakosWorkspaceService.seedOversightMemberships();
    await ensurePeakosPriceCatalog(pool);
    await peakosOsEmailAuth.repository.purgeExpired(new Date());
    // `/api/peakos` 전역 게이트가 Firebase + OS 이메일 세션 + 명시적
    // workspace 헤더를 먼저 확인한다. 이 영역 미들웨어가 sales 권한을
    // 추가 확인하며, 라우트 내부 정책이 영업 그룹/조직 관리자/oversight
    // 범위와 PII 마스킹을 다시 강제한다.
    registerPeakosSalesLeadRoutes({
      app,
      pool,
      readMiddlewares: [
        peakosWorkspaceService.requireWorkspace({ area: 'sales', action: 'read', requireHeader: true }),
      ],
      writeMiddlewares: [
        peakosWorkspaceService.requireWorkspace({ area: 'sales', action: 'write', requireHeader: true }),
      ],
      encryptionSecret: process.env.PEAKOS_SALES_PII_ENCRYPTION_SECRET,
    });
    registerPeakosFinanceRequests({
      app,
      authMiddleware,
      pool,
      canReview: peakosCanReviewFinance,
      getActor: req => ({ uid: req.uid, name: peakosName(req) }),
      // 금융 계좌 암호화 키는 로그인 2차 인증 키와 수명주기가 달라야 한다.
      // 누락 시 서버가 fail-closed로 시작을 거부해 키 교체로 장부가 깨지는 일을 막는다.
      encryptionSecret: process.env.PEAKOS_FINANCE_ENCRYPTION_SECRET,
    });
    registerPeakosTaxInvoiceEvidenceRoutes({
      app,
      authMiddleware,
      pool,
      canReviewFinance: peakosCanReviewFinance,
      getName: req => peakosName(req),
      storageRoot: process.env.PEAKOS_TAX_INVOICE_EVIDENCE_ROOT || undefined,
    });
    startPeakosBankScheduler();
    peakosPlatformSettlementSyncRuntime.startScheduler();
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`Calendar API running on port ${PORT}`);
      if (process.env.PEAKOS_PLATFORM_SYNC_ON_STARTUP === 'true') {
        void peakosPlatformSettlementSyncRuntime.run('startup');
      }
    });
  } catch (err) {
    console.error('Server startup failed:', err.message);
    process.exit(1);
  }
}

startServer();
