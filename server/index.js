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
      'CREATE INDEX IF NOT EXISTS idx_project_task_comments_task ON project_task_comments (project_id, task_id, created_at) WHERE deleted = false'
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

async function canAccessProject(req, projectId) {
  if (!projectId || !req.userDoc?.approved) return false;
  if (req.userDoc.role === 'admin') return true;
  const result = await pool.query(
    `SELECT 1 FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND (p.owner_id = $2 OR EXISTS (
         SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2
       ))`,
    [projectId, req.uid]
  );
  return !!result.rows[0];
}

async function canManageProject(req, projectId) {
  if (!projectId || !req.userDoc?.approved) return false;
  if (req.userDoc.role === 'admin') return true;
  const result = await pool.query(
    `SELECT 1 FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     WHERE p.id = $1
       AND COALESCE(pd.deleted, false) = false
       AND p.status IS DISTINCT FROM 'archived'
       AND p.owner_id = $2`,
    [projectId, req.uid]
  );
  return !!result.rows[0];
}

async function resolveProjectTaskAssignees(db, projectId, assignmentMode, assigneeUid = '') {
  if (assignmentMode === 'all') {
    const members = await db.query(
      `SELECT u.uid, u.name
       FROM project_members pm
       JOIN users u ON u.uid = pm.user_id
       WHERE pm.project_id = $1
         AND u.approved = true
         AND COALESCE(u.is_active, true) = true
       ORDER BY u.name`,
      [projectId]
    );
    return members.rows;
  }
  if (!assigneeUid) return [];
  const member = await db.query(
    `SELECT u.uid, u.name
     FROM project_members pm
     JOIN users u ON u.uid = pm.user_id
     WHERE pm.project_id = $1 AND pm.user_id = $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [projectId, assigneeUid]
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
       AND p.status IS DISTINCT FROM 'archived'`,
    [projectId]
  );
  if (!project.rows[0]) throw Object.assign(new Error('Project not found'), { statusCode: 404 });

  const event = await pool.query(
    `INSERT INTO events (type, title, date, time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date, sort_order, project_id)
     VALUES ('meeting',$1,$2,$3,'',$4,NULL,NULL,'team',$5,$6,NULL,NULL,$7,0,$8)
     RETURNING *`,
    [title, date, time || '', memo || `${project.rows[0].name} 프로젝트 회의`, req.uid, req.userName, endDate || null, projectId]
  );

  const members = await pool.query(
    `SELECT pm.user_id
     FROM project_members pm
     JOIN users u ON u.uid = pm.user_id
     WHERE pm.project_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [projectId]
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
    const targets = await pool.query(
      `SELECT DISTINCT target.uid
       FROM (
         SELECT pm.user_id AS uid FROM project_members pm WHERE pm.project_id = $1
         UNION
         SELECT p.owner_id AS uid FROM projects p WHERE p.id = $1
       ) target
       JOIN users u ON u.uid = target.uid
       WHERE target.uid IS NOT NULL
         AND target.uid != $2
         AND u.approved = true
         AND u.is_active != false`,
      [projectId, actorUid || '']
    );
    await Promise.all(targets.rows.map(row => sendPushToUser(
      row.uid,
      title,
      body,
      {
        kind: 'project',
        projectId,
        link: `/?page=project&projectId=${projectId}`,
        ...data
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
      '새 수정 요청',
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
    `SELECT id, title, type, date, time, reminder, owner_id, owner_name, done
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

    const recipients = new Set([event.owner_id, ...(shareMap.get(event.id) || [])]);
    for (const userUid of recipients) {
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
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = await verifyFirebaseToken(token);
    req.uid = decoded.uid;
    req.userName = decoded.name || decoded.email;
    req.userEmail = decoded.email;
    req.userPhoto = decoded.picture || '';
    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [req.uid]);
    req.userDoc = userRes.rows[0] || null;
    // Hard server-side enforcement of restricted account modes. The
    // client hides disallowed routes, but direct API calls must be
    // blocked here too.
    if (req.userDoc?.chat_only && !req.userDoc?.external_calendar_only && !isChatOnlyAllowedPath(req.path)) {
      return res.status(403).json({ error: 'This account is restricted to chat' });
    }
    if (req.userDoc?.external_calendar_only && !isExternalCalendarAllowedPath(req.path)) {
      return res.status(403).json({ error: 'This account is restricted to calendar and chat' });
    }
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
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
    || /^\/api\/users\/me$/.test(pathname)
    || /^\/api\/users\/register$/.test(pathname)
    || /^\/api\/users\/me\/notification-settings$/.test(pathname)
    || /^\/api\/users\/all-approved$/.test(pathname)
    || /^\/api\/fcm($|\/)/.test(pathname)
	    || /^\/api\/_debug($|\/)/.test(pathname);
}

function isExternalCalendarAllowedPath(pathname) {
  return isChatOnlyAllowedPath(pathname)
    || /^\/api\/events($|\/)/.test(pathname);
}

function isExternalCalendarUser(req) {
  return !!req.userDoc?.external_calendar_only;
}

const INTERNAL_CALENDAR_RULE_EVENT_SQL = `(COALESCE(e.todo_cat, '') = '보고서'
  OR COALESCE(e.title, '') LIKE '%보고서 작성%'
  OR COALESCE(e.title, '') LIKE '%보고서 확인%'
  OR COALESCE(e.title, '') LIKE '%업무보고 작성%')`;

async function canAccessEvent(req, eventId, { requireOwner = false } = {}) {
  if (!eventId) return false;
  const result = await pool.query(
    `SELECT e.owner_id,
            e.scope,
            owner_user.group_id AS owner_group_id,
            ${INTERNAL_CALENDAR_RULE_EVENT_SQL} AS is_internal_rule,
            EXISTS (SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $2) AS is_shared
     FROM events e
     LEFT JOIN users owner_user ON owner_user.uid = e.owner_id
     WHERE e.id = $1 AND e.deleted = false`,
    [eventId, req.uid]
  );
  const event = result.rows[0];
  if (!event) return false;
  if (isExternalCalendarUser(req) && event.is_internal_rule) return false;
  if (event.owner_id === req.uid) return true;
  if (requireOwner) return false;
  if (req.userDoc?.role === 'admin') return true;
  if (req.userDoc?.role === 'manager'
      && event.scope === 'team'
      && event.owner_group_id
      && event.owner_group_id === req.userDoc.group_id) return true;
  return !!event.is_shared;
}

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
  res.json(await attachEventReminderPreference(req.userDoc));
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
  const { role, groupId, chatOnly } = req.body || {};
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
  if (typeof chatOnly === 'boolean') {
    // Safety: refuse chat_only on an existing admin account even if
    // the approving admin ticked the box by mistake.
    const target = await pool.query('SELECT role FROM users WHERE uid = $1', [req.params.uid]);
    const isAdminTarget = target.rows[0]?.role === 'admin' || role === 'admin';
    if (chatOnly && !isAdminTarget) {
      sets.push(`chat_only = $${params.length + 1}`);
      params.push(true);
    } else if (!chatOnly) {
      sets.push(`chat_only = $${params.length + 1}`);
      params.push(false);
    }
  }
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE uid = $1`, params);
  res.json({ ok: true });
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
    const params = [req.uid];
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
	         AND (e.project_id IS NULL OR (COALESCE(epd.deleted, false) = false AND ep.status IS DISTINCT FROM 'archived'))
	         AND ${scopeWhere}${dateWhere}${externalRuleWhere}${sharedDoneWhere}
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

async function getNextTodoSortOrder(date, todoCat, scope, ownerId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
     FROM events
     WHERE deleted = false
       AND type = 'todo'
       AND date = $1
       AND scope = $2
       AND (($3::text IS NULL AND todo_cat IS NULL) OR todo_cat = $3)
       AND ($2 <> 'personal' OR owner_id = $4)`,
    [date, scope || 'personal', todoCat || null, ownerId || null]
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
  const { type, title, date, time, url, memo, todoCat, reminder, scope, repeatType, repeatEnd, shareWith, endDate, checklist } = req.body;
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
    const repeatDates = buildRepeatDates(date, repeatType, repeatEnd);
    let validShareIds = [];
    if (resolvedScope === 'team' && requestedShareIds.length) {
      const shareUsers = await pool.query(
        `SELECT uid FROM users
         WHERE uid = ANY($1::text[])
           AND approved = true
           AND COALESCE(is_active, true) = true`,
        [requestedShareIds]
      );
      validShareIds = shareUsers.rows.map(row => row.uid);
      if (validShareIds.length !== requestedShareIds.length) {
        return res.status(400).json({ error: '공유할 수 없는 사용자가 포함되어 있습니다.' });
      }
    }

    const sortOrder = type === 'todo' ? await getNextTodoSortOrder(date, todoCat, resolvedScope, req.uid) : 0;
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO events (type, title, date, time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [type, title, date, time||'', url||'', memo||'', todoCat||null, reminder||null, resolvedScope, req.uid, req.userName, repeatType||null, repeatEnd||null, endDate||null, sortOrder]
    );
    const parent = result.rows[0];
    const eventIds = [parent.id];
    if (repeatDates.length) {
      await client.query('UPDATE events SET repeat_parent_id = $1 WHERE id = $1', [parent.id]);
      const children = await client.query(
        `INSERT INTO events
           (type,title,date,time,url,memo,todo_cat,reminder,scope,owner_id,owner_name,repeat_type,repeat_end,repeat_parent_id,end_date,sort_order)
         SELECT $1,$2,repeat_date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0
         FROM unnest($15::text[]) AS repeat_dates(repeat_date)
         RETURNING id`,
        [type, title, time||'', url||'', memo||'', todoCat||null, reminder||null, resolvedScope,
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
  const { type, title, date, time, url, memo, todoCat, reminder, scope, done, deleted, kanbanStatus, kanbanOrder, endDate, shareWith } = req.body;
  const shouldSyncShares = Array.isArray(shareWith) || scope === 'personal';
  const requestedShareIds = Array.from(new Set((Array.isArray(shareWith) ? shareWith : [])
    .map(uid => String(uid || '').trim())
    .filter(uid => uid && uid !== req.uid)));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const ev = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!ev.rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) {
      throw Object.assign(new Error('Not owner'), { statusCode: 403 });
    }
    const resolvedScope = scope || ev.rows[0].scope || 'personal';
    if (isExternalCalendarUser(req) && resolvedScope === 'team') {
      throw Object.assign(new Error('외부 캘린더 계정은 개인 일정만 등록할 수 있습니다'), { statusCode: 403 });
    }

    let validShareIds = [];
    if (shouldSyncShares && resolvedScope === 'team' && requestedShareIds.length) {
      const shareUsers = await client.query(
        `SELECT uid FROM users
         WHERE uid = ANY($1::text[])
           AND approved = true
           AND COALESCE(is_active, true) = true`,
        [requestedShareIds]
      );
      validShareIds = shareUsers.rows.map(row => row.uid);
      if (validShareIds.length !== requestedShareIds.length) {
        throw Object.assign(new Error('공유할 수 없는 사용자가 포함되어 있습니다.'), { statusCode: 400 });
      }
    }
    const oldShares = shouldSyncShares
      ? await client.query('SELECT user_id FROM event_shares WHERE event_id = $1', [req.params.id])
      : { rows: [] };
    const oldShareIds = new Set(oldShares.rows.map(row => row.user_id));

    const result = await client.query(
      `UPDATE events SET type=COALESCE($1,type), title=COALESCE($2,title), date=COALESCE($3,date),
       time=COALESCE($4,time), url=COALESCE($5,url), memo=COALESCE($6,memo),
       todo_cat=COALESCE($7,todo_cat), reminder=COALESCE($8,reminder), scope=COALESCE($9,scope),
       done=COALESCE($10,done), deleted=COALESCE($11,deleted),
       kanban_status=COALESCE($12,kanban_status), kanban_order=COALESCE($13,kanban_order),
       end_date=COALESCE($14,end_date)
       WHERE id=$15 RETURNING *`,
      [type, title, date, time, url, memo, todoCat, reminder, scope, done, deleted, kanbanStatus, kanbanOrder, endDate, req.params.id]
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
    'SELECT * FROM custom_event_types WHERE owner_id = $1 ORDER BY sort_order, created_at',
    [req.uid]
  );
  res.json(result.rows);
});

app.post('/api/event-types', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, icon, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO custom_event_types (owner_id, name, icon, color) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.uid, name, icon || '📌', color || '#3B82F6']
  );
  res.json(result.rows[0]);
});

app.delete('/api/event-types/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM custom_event_types WHERE id = $1 AND owner_id = $2', [req.params.id, req.uid]);
  res.json({ ok: true });
});

// ── Custom Todo Categories (사용자별 할 일 카테고리) ──────────
app.get('/api/todo-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const result = await pool.query(
    'SELECT * FROM custom_todo_cats WHERE owner_id = $1 ORDER BY sort_order, created_at',
    [req.uid]
  );
  res.json(result.rows);
});

app.post('/api/todo-cats', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await pool.query(
    'INSERT INTO custom_todo_cats (owner_id, name, color) VALUES ($1,$2,$3) RETURNING *',
    [req.uid, name, color || '#3B82F6']
  );
  res.json(result.rows[0]);
});

app.delete('/api/todo-cats/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM custom_todo_cats WHERE id = $1 AND owner_id = $2', [req.params.id, req.uid]);
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
     ),
     member_counts AS (
       SELECT crm.room_id, COUNT(*)::int AS member_count
       FROM chat_room_members crm
       JOIN my_rooms mr ON mr.id = crm.room_id
       JOIN users member_user ON member_user.uid = crm.user_id
         AND member_user.approved = true
         AND COALESCE(member_user.is_active, true) = true
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
    [req.uid]
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
       )
       SELECT crg.*,
              COUNT(mr.id)::int AS room_count
       FROM chat_room_groups crg
       LEFT JOIN chat_room_group_links crgl ON crgl.group_id = crg.id
       LEFT JOIN my_rooms mr ON mr.id = crgl.room_id
       WHERE crg.deleted = false
       GROUP BY crg.id
       ORDER BY crg.sort_order, crg.created_at`,
      [req.uid]
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
      `INSERT INTO chat_room_groups (id, name, color, sort_order, created_by)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM chat_room_groups),$4)
       RETURNING *`,
      [crypto.randomUUID(), name, color || '#007AFF', req.uid]
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
       RETURNING *`,
      [name, color || '#007AFF', req.params.id]
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
    await pool.query('UPDATE chat_room_groups SET deleted=true, updated_at=NOW() WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM chat_room_group_links WHERE group_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseJsonSafely(value) {
  try { return JSON.parse(value); } catch (err) { return null; }
}

async function getChatRoomById(roomId) {
  const result = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
  return result.rows[0] || null;
}

async function isChatRoomMember(roomId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
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
     JOIN users u ON u.uid = crm.user_id
     WHERE crm.room_id = $1
       AND crm.user_id != $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [roomId, senderUid]
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
      const validUsers = await pool.query(
        `SELECT uid FROM users
         WHERE uid = ANY($1::text[])
           AND approved = true
           AND COALESCE(is_active, true) = true
           AND ($2::boolean = false OR role = 'admin')`,
        [requestedMemberIds, restrictedDirectory]
      );
      validMemberIds = validUsers.rows.map(row => row.uid);
      if (validMemberIds.length !== requestedMemberIds.length) {
        return res.status(400).json({ error: '초대할 수 없는 사용자가 포함되어 있습니다.' });
      }
    }
    const room = await pool.query(
      'INSERT INTO chat_rooms (name, creator_id) VALUES ($1, $2) RETURNING *',
      [name, req.uid]
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
      const group = await pool.query('SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false', [groupId]);
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

  const room = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.roomId]);
  if (!room.rows[0]) return res.status(404).json({ error: 'Not found' });

  const member = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.uid]
  );
  if (!member.rows[0]) return res.status(403).json({ error: 'Not a member' });

  const canManage = room.rows[0].creator_id === req.uid || req.userDoc?.role === 'admin';
  if (!canManage) return res.status(403).json({ error: '생성자 또는 관리자만 수정할 수 있습니다.' });

  const updated = await pool.query(
    'UPDATE chat_rooms SET name = $1 WHERE id = $2 RETURNING *',
    [name, req.params.roomId]
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
     WHERE cr.id = ANY($2::text[])`,
    [req.uid, ids]
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

    const group = await pool.query('SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false', [groupId]);
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
    const room = await getChatRoomById(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Not found' });
    const member = await isChatRoomMember(req.params.roomId, req.uid);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    if (!canManageChatRoom(room, req) && !canManageChatRoomGroups(req)) {
      return res.status(403).json({ error: '생성자, 관리자 또는 그룹 관리자만 이동할 수 있습니다.' });
    }
    const groupId = String(req.body?.groupId || req.body?.group_id || '').trim();
    if (!groupId) {
      await pool.query('DELETE FROM chat_room_group_links WHERE room_id=$1', [req.params.roomId]);
      return res.json({ ok: true, group_id: null });
    }
    const group = await pool.query('SELECT id FROM chat_room_groups WHERE id=$1 AND deleted=false', [groupId]);
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
  const member = await isChatRoomMember(req.params.roomId, req.uid);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const result = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url,
      (u.uid = cr.creator_id) as is_creator
     FROM chat_room_members crm
     JOIN users u ON crm.user_id = u.uid
     JOIN chat_rooms cr ON cr.id = crm.room_id
     WHERE crm.room_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true
     ORDER BY (u.uid = cr.creator_id) DESC, u.name`,
    [req.params.roomId]
  );
  res.json(result.rows);
});

app.post('/api/chat-rooms/:roomId/members', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { userId } = req.body;
  const room = await getChatRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const member = await isChatRoomMember(req.params.roomId, req.uid);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!canManageChatRoom(room, req)) return res.status(403).json({ error: '생성자 또는 관리자만 멤버를 추가할 수 있습니다.' });
  const user = await pool.query(
    'SELECT uid FROM users WHERE uid = $1 AND approved = true AND COALESCE(is_active, true) = true',
    [userId]
  );
  if (!user.rows[0]) return res.status(400).json({ error: '초대할 수 없는 사용자입니다.' });
  await pool.query(
    'INSERT INTO chat_room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.params.roomId, userId]
  );
  res.json({ ok: true });
});

app.delete('/api/chat-rooms/:roomId/members/:userId', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const room = await getChatRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const member = await isChatRoomMember(req.params.roomId, req.uid);
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

  const room = await getChatRoomById(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });

  const requesterMember = await isChatRoomMember(req.params.roomId, req.uid);
  if (!requesterMember) return res.status(403).json({ error: 'Not a member' });

  const manager = canManageChatRoom(room, req);
  if (normalizedAssignee !== req.uid && !manager) {
    return res.status(403).json({ error: '다른 담당자의 일정은 방 생성자 또는 관리자만 등록할 수 있습니다.' });
  }

  const assigneeMember = await isChatRoomMember(req.params.roomId, normalizedAssignee);
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
    `INSERT INTO events (type, title, date, time, url, memo, todo_cat, reminder, scope, owner_id, owner_name, repeat_type, repeat_end, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
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
     JOIN users u ON u.uid = crm.user_id
     WHERE crm.room_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [req.params.roomId]
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
     WHERE cr.id = ANY($2::text[])`,
    [req.uid, ids]
  );
  const roomMap = new Map(result.rows.map(room => [String(room.id), room]));
  const forbidden = ids.filter(id => {
    const room = roomMap.get(String(id));
    return !room || room.creator_id !== req.uid;
  });
  if (forbidden.length) return res.status(403).json({ error: '생성자가 아닌 채팅방이 포함되어 있습니다.' });

  await pool.query(
    'UPDATE chat_rooms SET delete_requested = true, delete_requested_by = $1 WHERE id = ANY($2::text[])',
    [req.uid, ids]
  );
  res.json({ ok: true, updated: ids.length });
});

// ── 채팅방 삭제 요청 (생성자만) ──────────────────────────────
app.post('/api/chat-rooms/:roomId/request-delete', authMiddleware, async (req, res) => {
  const room = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [req.params.roomId]);
  if (!room.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (room.rows[0].creator_id !== req.uid) return res.status(403).json({ error: '생성자만 삭제 요청 가능' });
  await pool.query('UPDATE chat_rooms SET delete_requested = true, delete_requested_by = $1 WHERE id = $2', [req.uid, req.params.roomId]);
  res.json({ ok: true });
});

// ── 채팅방 삭제 승인 (admin만) ───────────────────────────────
app.delete('/api/chat-rooms/:roomId', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
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
  await pool.query('DELETE FROM chat_room_group_links WHERE room_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM chat WHERE room_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM chat_room_members WHERE room_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM chat_rooms WHERE id = ANY($1::text[])', [ids]);
  res.json({ ok: true, deleted: ids.length });
});

// ── 삭제 요청된 채팅방 목록 (admin) ─────────────────────────
app.get('/api/chat-rooms/delete-requests', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await pool.query(
    `SELECT cr.*, u.name as requester_name FROM chat_rooms cr JOIN users u ON cr.delete_requested_by = u.uid WHERE cr.delete_requested = true`
  );
  res.json(result.rows);
});

// ── 채팅방 삭제 요청 거절 ────────────────────────────────────
app.post('/api/chat-rooms/:roomId/reject-delete', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  await pool.query('UPDATE chat_rooms SET delete_requested = false, delete_requested_by = null WHERE id = $1', [req.params.roomId]);
  res.json({ ok: true });
});

// ── Chat Messages (방별 메시지) ─────────────────────────────
app.get('/api/chat-rooms/:roomId/typing', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  res.json({ users: getLiveChatTypingUsers(req.params.roomId, req.uid) });
});

app.post('/api/chat-rooms/:roomId/typing', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  if (!(await isChatRoomMember(req.params.roomId, req.uid))) {
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
  const member = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.uid]
  );
  if (!member.rows[0]) return res.status(403).json({ error: 'Not a member' });
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
  const member = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.uid]
  );
  if (!member.rows[0]) return res.status(403).json({ error: 'Not a member' });
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
     JOIN users u ON u.uid = crm.user_id
     WHERE crm.room_id = $1
       AND crm.user_id != $2
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true`,
    [req.params.roomId, req.uid]
  );
  const roomInfo = await pool.query('SELECT name FROM chat_rooms WHERE id = $1', [req.params.roomId]);
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
  const member = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.uid]
  );
  if (!member.rows[0]) return res.status(403).json({ error: 'Not a member' });
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
  const { lastMsgId } = req.body;
  await pool.query(
    `INSERT INTO chat_read_status (room_id, user_id, last_read_msg_id, last_read_at)
     VALUES ($1,$2,$3,NOW()) ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_msg_id=$3, last_read_at=NOW()`,
    [req.params.roomId, req.uid, lastMsgId]
  );
  res.json({ ok: true });
});

// 메시지별 안 읽은 수 조회
app.get('/api/chat-rooms/:roomId/unread-counts', authMiddleware, async (req, res) => {
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
    [req.params.roomId]
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
       WHERE crm.user_id = $1
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
    [req.uid]
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
  const comment = await pool.query('SELECT * FROM event_comments WHERE id = $1', [req.params.commentId]);
  if (!comment.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && comment.rows[0].uid !== req.uid) return res.status(403).json({ error: 'Not owner' });
  await pool.query('DELETE FROM event_comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
});

// ── 승인된 유저 목록 (채팅방 멤버 초대용) ─────────────────────
app.get('/api/users/all-approved', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  // A chat_only user should not see the rest of the member directory
  // when picking who to add to a chat room — only themselves and the
  // admin accounts, so they can at most talk to an admin. The admin
  // can invite whoever they need into the room afterwards.
  if (req.userDoc.chat_only || req.userDoc.external_calendar_only) {
    const result = await pool.query(
      `SELECT u.uid, u.name, u.email, u.photo_url, u.group_id, g.name AS group_name
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.approved = true
         AND COALESCE(u.is_active, true) = true
         AND (u.uid = $1 OR u.role = 'admin')
       ORDER BY u.role DESC, u.name`,
      [req.uid]
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url, u.group_id, g.name AS group_name
     FROM users u
     LEFT JOIN groups g ON g.id = u.group_id
     WHERE u.approved = true AND COALESCE(u.is_active, true) = true
     ORDER BY g.created_at NULLS LAST, u.name`
  );
  res.json(result.rows);
});

// ── 파일 첨부 (채팅) ──────────────────────────────────────────
app.post('/api/chat-rooms/:roomId/upload-file', authMiddleware, uploadFile.single('file'), async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const member = await pool.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [req.params.roomId, req.uid]
  );
  if (!member.rows[0]) return res.status(403).json({ error: 'Not a member' });
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
        'SELECT * FROM events WHERE deleted = false AND date >= $1 AND date <= $2 ORDER BY date, time',
        [monStr, sunStr]
      );
    } else if (req.userDoc.role === 'manager') {
      evQuery = await pool.query(
        `SELECT e.*
         FROM events e
         LEFT JOIN users owner_user ON owner_user.uid = e.owner_id
         WHERE e.deleted = false
           AND e.date >= $1 AND e.date <= $2
           AND (
             e.owner_id = $3
             OR EXISTS (SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $3)
             OR (e.scope = 'team' AND owner_user.group_id = $4)
           )
           AND NOT (e.scope = 'team' AND e.done = true AND e.owner_id <> $3)
         ORDER BY e.date, e.time`,
        [monStr, sunStr, req.uid, req.userDoc.group_id || null]
      );
    } else {
      evQuery = await pool.query(
        `SELECT e.* FROM events e
         WHERE e.deleted = false
           AND e.date >= $1 AND e.date <= $2
           AND (e.owner_id = $3 OR EXISTS (
             SELECT 1 FROM event_shares es WHERE es.event_id = e.id AND es.user_id = $3
           ))
           AND NOT (e.scope = 'team' AND e.done = true AND e.owner_id <> $3)
         ORDER BY e.date, e.time`,
        [monStr, sunStr, req.uid]
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
      `UPDATE events SET done = true WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false`,
      [req.uid, reportDate]
    );

    // admin + 같은 그룹 팀장에게 캘린더 알림
    const targets = await pool.query(
      `SELECT uid, name FROM users WHERE uid != $1 AND (role = 'admin' OR (role = 'manager' AND group_id = $2))`,
      [req.uid, req.userDoc.group_id]
    );
    for (const a of targets.rows) {
      const exists = await pool.query(
        `SELECT 1 FROM events WHERE type='todo' AND owner_id=$1 AND date=$2 AND title LIKE $3 AND deleted=false`,
        [a.uid, reportDate, `📄 ${req.userName}%보고서%`]
      );
      if (!exists.rows[0]) {
        await pool.query(
          `INSERT INTO events (type, title, date, scope, owner_id, owner_name, todo_cat)
           VALUES ('todo', $1, $2, 'personal', $3, $4, '보고서')`,
          [`📄 ${req.userName} 보고서 확인`, reportDate, a.uid, a.name || '']
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
           WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false`,
          [report.author_id, report.report_date]
        );
      }
    }
    await client.query(
      `UPDATE events SET done = true
       WHERE owner_id = $1 AND date = $2 AND title = '📝 일일 보고서 작성' AND deleted = false`,
      [report.author_id, reportDate]
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

// 계정 권한에 따라 조회 가능한 보고서 범위를 좁힌다. weekly-summary와 동일 기준.
function salesSummaryScope(req, params) {
  if (req.userDoc.role === 'admin' || req.userDoc.can_view_all_reports) {
    return { clause: '', scope: 'all' };
  }
  if (req.userDoc.role === 'manager') {
    params.push(req.uid, req.userDoc.group_id);
    return { clause: ` AND (r.author_id = $${params.length - 1} OR u.group_id = $${params.length})`, scope: 'group' };
  }
  params.push(req.uid);
  return { clause: ` AND r.author_id = $${params.length}`, scope: 'self' };
}

app.get('/api/reports/sales-summary', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });

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
});

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
  const { groupId } = req.body;
  await pool.query('UPDATE users SET group_id = $1 WHERE uid = $2', [groupId, req.params.uid]);
  res.json({ ok: true });
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
    await client.query('DELETE FROM fcm_tokens WHERE user_uid = $1', [req.params.uid]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/users/:uid/activate', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  await pool.query('UPDATE users SET is_active = true, approved = true WHERE uid = $1', [req.params.uid]);
  res.json({ ok: true });
});

app.put('/api/users/:uid/role', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { role } = req.body;
  if (!['member','manager','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await pool.query('UPDATE users SET role = $1 WHERE uid = $2', [role, req.params.uid]);
  res.json({ ok: true });
});

// Toggle chat-only restriction. A chat_only user's client hides every
// non-chat page; this endpoint persists the flag and the paired server
// guard below also denies non-chat API paths so the policy can't be
// sidestepped by calling the API directly.
app.put('/api/users/:uid/chat-only', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const chatOnly = !!req.body?.chatOnly;
  // An admin would be locked out of the admin panel by this flag, so
  // refuse it on admin accounts instead of silently bricking them.
  const target = await pool.query('SELECT role FROM users WHERE uid = $1', [req.params.uid]);
  if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
  if (target.rows[0].role === 'admin' && chatOnly) {
    return res.status(400).json({ error: 'admin 계정은 chat-only로 제한할 수 없습니다' });
  }
  await pool.query('UPDATE users SET chat_only = $1 WHERE uid = $2', [chatOnly, req.params.uid]);
  res.json({ ok: true });
});

app.put('/api/users/:uid/external-calendar-only', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const externalCalendarOnly = !!req.body?.externalCalendarOnly;
  const target = await pool.query('SELECT role FROM users WHERE uid = $1', [req.params.uid]);
  if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
  if (target.rows[0].role === 'admin' && externalCalendarOnly) {
    return res.status(400).json({ error: 'admin 계정은 외부 캘린더 계정으로 제한할 수 없습니다' });
  }
  await pool.query(
    `UPDATE users
     SET external_calendar_only = $1,
         chat_only = CASE WHEN $1 THEN false ELSE chat_only END,
         can_view_all_attendance = CASE WHEN $1 THEN false ELSE can_view_all_attendance END,
         can_view_all_reports = CASE WHEN $1 THEN false ELSE can_view_all_reports END,
         can_manage_team = CASE WHEN $1 THEN false ELSE can_manage_team END,
         viewable_groups = CASE WHEN $1 THEN ARRAY[]::text[] ELSE viewable_groups END
     WHERE uid = $2`,
    [externalCalendarOnly, req.params.uid]
  );
  res.json({ ok: true });
});

// ══ 출근 보고서 ═══════════════════════════════════════════════
app.get('/api/attendance', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const { month, userId } = req.query; // month: '2026-04'
  let query, params;
  if (req.userDoc.role === 'admin') {
    if (userId) {
      query = 'SELECT * FROM attendance WHERE user_id = $1 AND attendance_date LIKE $2 ORDER BY attendance_date';
      params = [userId, (month || new Date().toISOString().slice(0,7)) + '%'];
    } else {
      // 같은 그룹만
      query = `SELECT a.* FROM attendance a JOIN users u ON a.user_id = u.uid
        WHERE ($1::text IS NULL OR u.group_id = $1) AND a.attendance_date LIKE $2 ORDER BY a.attendance_date, u.name`;
      params = [req.userDoc.group_id, (month || new Date().toISOString().slice(0,7)) + '%'];
    }
  } else {
    query = 'SELECT * FROM attendance WHERE user_id = $1 AND attendance_date LIKE $2 ORDER BY attendance_date';
    params = [req.uid, (month || new Date().toISOString().slice(0,7)) + '%'];
  }
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/attendance/check-in', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const kstNow = new Date(new Date().getTime() + 9*60*60*1000);
  const today = kstNow.toISOString().slice(0, 10);
  const now = `${String(kstNow.getUTCHours()).padStart(2,'0')}:${String(kstNow.getUTCMinutes()).padStart(2,'0')}`;
  const result = await pool.query(
    `INSERT INTO attendance (user_id, user_name, attendance_date, check_in, group_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, attendance_date) DO UPDATE SET check_in = $4
     RETURNING *`,
    [req.uid, req.userName, today, now, req.userDoc.group_id]
  );
  res.json(result.rows[0]);
});

app.post('/api/attendance/check-out', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const result = await pool.query(
    'UPDATE attendance SET check_out = $1 WHERE user_id = $2 AND attendance_date = $3 RETURNING *',
    [now, req.uid, today]
  );
  res.json(result.rows[0] || { error: 'No check-in found' });
});

// 상세 출근 데이터 (시간+지각)
app.get('/api/attendance/details', authMiddleware, async (req, res) => {
  const { month, userId } = req.query;
  const m = month || new Date().toISOString().slice(0,7);
  let query, params;
  if (userId) {
    query = 'SELECT * FROM attendance WHERE user_id = $1 AND attendance_date LIKE $2 ORDER BY attendance_date';
    params = [userId, m+'%'];
  } else if (req.userDoc.role === 'admin' || req.userDoc.can_view_all_attendance) {
    query = 'SELECT * FROM attendance WHERE attendance_date LIKE $1 ORDER BY user_name, attendance_date';
    params = [m+'%'];
  } else if (req.userDoc.role === 'manager') {
    query = `SELECT a.* FROM attendance a JOIN users u ON a.user_id = u.uid WHERE u.group_id = $1 AND a.attendance_date LIKE $2 ORDER BY a.user_name, a.attendance_date`;
    params = [req.userDoc.group_id, m+'%'];
  } else {
    query = 'SELECT * FROM attendance WHERE user_id = $1 AND attendance_date LIKE $2 ORDER BY attendance_date';
    params = [req.uid, m+'%'];
  }
  const result = await pool.query(query, params);
  // 휴무일 목록 가져오기
  const holidays = await pool.query('SELECT holiday_date FROM holidays');
  const holidayDates = new Set(holidays.rows.map(h => h.holiday_date));
  // 지각 계산 (10:10 이후, 휴무일 제외)
  const data = result.rows.map(r => ({
    ...r,
    is_holiday: holidayDates.has(r.attendance_date),
    is_late: r.check_in && r.check_in > '10:10' && !holidayDates.has(r.attendance_date)
  }));
  res.json(data);
});

app.get('/api/attendance/monthly-summary', authMiddleware, async (req, res) => {
  if (req.userDoc?.role !== 'admin' && !req.userDoc?.can_view_all_attendance && req.userDoc?.role !== 'manager') return res.status(403).json({ error: 'Not authorized' });
  const { month } = req.query;
  const m = month || new Date().toISOString().slice(0, 7);
  const showAll = req.userDoc.role === 'admin';
  const vGroups = req.userDoc.viewable_groups || [];
  const hasViewableGroups = req.userDoc.can_view_all_attendance && vGroups.length > 0;
  const seeAll = req.userDoc.can_view_all_attendance && vGroups.length === 0;

  let groupFilter, params;
  if (showAll || seeAll) {
    groupFilter = '($2::text IS NULL OR true)';
    params = [m + '%', null];
  } else if (hasViewableGroups) {
    // 본인 그룹 + viewable_groups
    const allGroups = [req.userDoc.group_id, ...vGroups].filter(Boolean);
    groupFilter = `u.group_id = ANY($2::text[])`;
    params = [m + '%', allGroups];
  } else {
    groupFilter = 'u.group_id = $2';
    params = [m + '%', req.userDoc.group_id];
  }
  const result = await pool.query(
    `SELECT u.uid, u.name, u.email, u.group_id, COUNT(a.id) as total_days,
      MIN(a.check_in) as earliest_in, MAX(a.check_out) as latest_out
     FROM users u LEFT JOIN attendance a ON u.uid = a.user_id AND a.attendance_date LIKE $1
     WHERE u.approved = true AND ${groupFilter}
     GROUP BY u.uid, u.name, u.email, u.group_id ORDER BY u.name`,
    params
  );
  res.json(result.rows);
});

// ══ 프로젝트 ══════════════════════════════════════════════════
app.get('/api/projects', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const params = [];
  let where = "COALESCE(pd.deleted, false) = false AND p.status IS DISTINCT FROM 'archived'";
  if (req.userDoc.role !== 'admin') {
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
            COUNT(DISTINCT pc.id) FILTER (WHERE pc.deleted = false)::int AS comment_count,
            MAX(pc.created_at) FILTER (WHERE pc.deleted = false) AS last_comment_at,
            COALESCE(STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name), '') AS member_names
     FROM projects p
     LEFT JOIN project_details pd ON pd.project_id = p.id
     LEFT JOIN users owner_user ON owner_user.uid = p.owner_id
     LEFT JOIN project_members pm ON pm.project_id = p.id
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
  res.json({ canManageAll: req.userDoc.role === 'admin', projects: result.rows });
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
    const id = crypto.randomUUID();
    const project = await pool.query(
      `INSERT INTO projects (id, name, description, owner_id, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, name, description, req.uid, status]
    );
    await pool.query(
      `INSERT INTO project_details (project_id, owner_name, deadline, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (project_id) DO UPDATE SET owner_name=EXCLUDED.owner_name, deadline=EXCLUDED.deadline, updated_at=NOW()`,
      [id, req.userName || req.userEmail || '사용자', deadline]
    );
    await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, req.uid]);
    const uniqueMemberIds = [...new Set(memberIds.map(uid => String(uid || '').trim()).filter(Boolean))];
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
       AND p.status IS DISTINCT FROM 'archived'`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  const members = await pool.query(
    `SELECT u.uid, u.name, u.email, u.photo_url,
            CASE WHEN u.uid = p.owner_id THEN 'manager' ELSE 'member' END AS role
     FROM project_members pm
     JOIN users u ON pm.user_id = u.uid
     JOIN projects p ON p.id = pm.project_id
     WHERE pm.project_id = $1
       AND u.approved = true
       AND COALESCE(u.is_active, true) = true
     ORDER BY CASE WHEN u.uid = p.owner_id THEN 0 ELSE 1 END, u.name`,
    [req.params.id]
  );
  const tasks = await pool.query(
    `SELECT
       pt.*,
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
     LEFT JOIN project_task_assignees pta ON pta.task_id = pt.id
     WHERE pt.project_id = $1
     GROUP BY pt.id
     ORDER BY pt.sort_order, pt.created_at`,
    [req.params.id]
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
  const events = await pool.query('SELECT * FROM events WHERE project_id = $1 AND deleted = false ORDER BY date', [req.params.id]);
  res.json({
    ...result.rows[0],
    canManage: await canManageProject(req, req.params.id),
    members: members.rows,
    tasks: tasks.rows,
    updates: updates.rows,
    comments: comments.rows,
    taskComments: taskComments.rows,
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
      result = await pool.query(
        `UPDATE projects SET ${sets.join(', ')}
         WHERE id = $1 AND status IS DISTINCT FROM 'archived'
         RETURNING *`,
        params
      );
    } else {
      result = await pool.query(
        `SELECT * FROM projects WHERE id = $1 AND status IS DISTINCT FROM 'archived'`,
        [req.params.id]
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
  const { eventId } = req.body;
  await pool.query('UPDATE events SET project_id = $1 WHERE id = $2', [req.params.id, eventId]);
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
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: '업무명을 입력하세요' });
  const description = String(req.body.description || '').trim().slice(0, 3000);
  const status = normalizeProjectTaskStatus(req.body.status);
  const dueDate = String(req.body.dueDate || req.body.due_date || '').trim().slice(0, 10);
  const assignmentMode = req.body.assigneeMode === 'all' ? 'all' : 'single';
  const assigneeUid = String(req.body.assigneeUid || req.body.assignee_uid || '').trim();
  let assignees;
  try {
    assignees = await resolveProjectTaskAssignees(pool, req.params.id, assignmentMode, assigneeUid);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const primaryAssignee = assignmentMode === 'single' ? assignees[0] : null;
  const result = await pool.query(
    `INSERT INTO project_tasks
     (id, project_id, title, description, assignee_uid, assignee_name, assignment_mode, status, due_date, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT COALESCE(MAX(sort_order),0)+1 FROM project_tasks WHERE project_id=$2),$10)
     RETURNING *`,
    [
      crypto.randomUUID(),
      req.params.id,
      title,
      description,
      primaryAssignee?.uid || null,
      assignmentMode === 'all' ? '모두' : primaryAssignee?.name || null,
      assignmentMode,
      status,
      dueDate,
      req.uid
    ]
  );
  await syncProjectTaskAssignees(pool, req.params.id, result.rows[0].id, assignees);
  if (status === 'done' && assignees.length) {
    await pool.query(
      `UPDATE project_task_assignees
       SET completed = true, completed_at = NOW()
       WHERE project_id = $1 AND task_id = $2`,
      [req.params.id, result.rows[0].id]
    );
  }
  await touchProject(req.params.id);
  res.json({
    ...result.rows[0],
    assignees: assignees.map(assignee => ({
      uid: assignee.uid,
      name: assignee.name,
      completed: status === 'done',
      completedAt: status === 'done' ? new Date().toISOString() : null
    })),
    assignee_count: assignees.length,
    completed_assignee_count: status === 'done' ? assignees.length : 0
  });
});

app.put('/api/projects/:id/tasks/:taskId', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const previous = await pool.query(
    `SELECT pt.*, p.name AS project_name
     FROM project_tasks pt
     JOIN projects p ON p.id = pt.project_id
     WHERE pt.id = $1 AND pt.project_id = $2`,
    [req.params.taskId, req.params.id]
  );
  if (!previous.rows[0]) return res.status(404).json({ error: 'Task not found' });
  const sets = ['updated_at = NOW()'];
  const params = [req.params.taskId, req.params.id];
  const addSet = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (req.body.title !== undefined) {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: '업무명을 입력하세요' });
    addSet('title', title);
  }
  if (req.body.description !== undefined) addSet('description', String(req.body.description || '').trim().slice(0, 3000));
  if (req.body.status !== undefined) addSet('status', normalizeProjectTaskStatus(req.body.status));
  if (req.body.dueDate !== undefined || req.body.due_date !== undefined) addSet('due_date', String(req.body.dueDate ?? req.body.due_date ?? '').trim().slice(0, 10));
  let assignmentUpdate = null;
  if (
    req.body.assigneeMode !== undefined
    || req.body.assigneeUid !== undefined
    || req.body.assignee_uid !== undefined
  ) {
    const assignmentMode = req.body.assigneeMode === 'all' ? 'all' : 'single';
    const assigneeUid = String(req.body.assigneeUid ?? req.body.assignee_uid ?? '').trim();
    let assignees;
    try {
      assignees = await resolveProjectTaskAssignees(pool, req.params.id, assignmentMode, assigneeUid);
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    const primaryAssignee = assignmentMode === 'single' ? assignees[0] : null;
    addSet('assignment_mode', assignmentMode);
    addSet('assignee_uid', primaryAssignee?.uid || null);
    addSet('assignee_name', assignmentMode === 'all' ? '모두' : primaryAssignee?.name || null);
    assignmentUpdate = { assignmentMode, assignees };
  }
  const result = await pool.query(
    `UPDATE project_tasks SET ${sets.join(', ')}
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
  if (assignmentUpdate) {
    await syncProjectTaskAssignees(
      pool,
      req.params.id,
      req.params.taskId,
      assignmentUpdate.assignees
    );
  }
  const before = previous.rows[0];
  const after = result.rows[0];
  if (after.status === 'done') {
    await pool.query(
      `UPDATE project_task_assignees
       SET completed = true, completed_at = COALESCE(completed_at, NOW())
       WHERE project_id = $1 AND task_id = $2`,
      [req.params.id, req.params.taskId]
    );
  } else if (['review', 'done'].includes(before.status) && after.status === 'doing' && after.assignment_mode === 'all') {
    await pool.query(
      `UPDATE project_task_assignees
       SET completed = false, completed_at = NULL
       WHERE project_id = $1 AND task_id = $2`,
      [req.params.id, req.params.taskId]
    );
  }
  await touchProject(req.params.id);
  if (req.body.status !== undefined && before.status !== after.status) {
    const actor = req.userName || req.userEmail || '사용자';
    let title = '업무 상태 변경';
    let body = `${before.project_name} · ${after.title}: ${projectTaskStatusLabel(after.status)}`;
    if (after.status === 'review') {
      title = '업무 검토요청';
      body = `${actor}님이 "${after.title}" 업무 검토를 요청했습니다.`;
    } else if (after.status === 'done') {
      title = '업무 완료 처리';
      body = `${actor}님이 "${after.title}" 업무를 완료 처리했습니다.`;
    } else if (before.status === 'review' && after.status === 'doing') {
      title = '업무 다시 진행';
      body = `${actor}님이 "${after.title}" 업무를 다시 진행으로 변경했습니다.`;
    }
    await notifyProjectMembers(
      req.params.id,
      req.uid,
      title,
      body,
      { taskId: req.params.taskId, link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}` }
    );
  }
  res.json(result.rows[0]);
});

app.put('/api/projects/:id/tasks/:taskId/completion', authMiddleware, async (req, res) => {
  if (!await canAccessProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
  const task = await pool.query(
    `SELECT pt.*, p.name AS project_name
     FROM project_tasks pt
     JOIN projects p ON p.id = pt.project_id
     WHERE pt.id = $1 AND pt.project_id = $2`,
    [req.params.taskId, req.params.id]
  );
  if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });
  if (task.rows[0].assignment_mode !== 'all') {
    return res.status(400).json({ error: '모두 담당 업무만 개인별 완료 체크할 수 있습니다' });
  }
  const assigned = await pool.query(
    `SELECT 1
     FROM project_task_assignees
     WHERE project_id = $1 AND task_id = $2 AND user_uid = $3`,
    [req.params.id, req.params.taskId, req.uid]
  );
  if (!assigned.rows[0]) {
    return res.status(403).json({ error: '이 업무의 담당자만 완료 체크할 수 있습니다' });
  }
  const completed = req.body.completed !== false;
  await pool.query(
    `UPDATE project_task_assignees
     SET completed = $4,
         completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END
     WHERE project_id = $1 AND task_id = $2 AND user_uid = $3`,
    [req.params.id, req.params.taskId, req.uid, completed]
  );
  const progress = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE completed)::int AS completed
     FROM project_task_assignees
     WHERE project_id = $1 AND task_id = $2`,
    [req.params.id, req.params.taskId]
  );
  const total = Number(progress.rows[0]?.total || 0);
  const completedCount = Number(progress.rows[0]?.completed || 0);
  const beforeStatus = task.rows[0].status;
  let nextStatus = beforeStatus;
  if (total > 0 && completedCount === total && !['review', 'done'].includes(beforeStatus)) {
    nextStatus = 'review';
  } else if (completedCount < total && ['review', 'done'].includes(beforeStatus)) {
    nextStatus = 'doing';
  } else if (completedCount > 0 && beforeStatus === 'todo') {
    nextStatus = 'doing';
  }
  if (nextStatus !== beforeStatus) {
    await pool.query(
      'UPDATE project_tasks SET status = $3, updated_at = NOW() WHERE project_id = $1 AND id = $2',
      [req.params.id, req.params.taskId, nextStatus]
    );
  }
  await touchProject(req.params.id);
  if (nextStatus === 'review' && beforeStatus !== 'review') {
    await notifyProjectMembers(
      req.params.id,
      req.uid,
      '업무 전체 완료',
      `"${task.rows[0].title}" 담당자 ${total}명이 모두 완료해 검토를 요청했습니다.`,
      { taskId: req.params.taskId, link: `/?page=project&projectId=${req.params.id}&taskId=${req.params.taskId}` }
    );
  }
  res.json({
    taskId: req.params.taskId,
    completed,
    completedCount,
    total,
    percent: total ? Math.round((completedCount / total) * 100) : 0,
    status: nextStatus
  });
});

app.delete('/api/projects/:id/tasks/:taskId', authMiddleware, async (req, res) => {
  if (!await canManageProject(req, req.params.id)) return res.status(403).json({ error: 'Not authorized' });
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

// ══ 피크마케팅 서비스 수정 요청 ═══════════════════════════════
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
        updated.status === 'done' ? '수정 요청 완료' : '수정 요청 상태 변경',
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
     WHERE owner_id = $1 AND date = $2 AND title = '📈 월간 보고서 작성' AND deleted = false`,
    [req.uid, getMonthlyReportTodoDate(month)]
  );
  console.log(`[monthly-submit] uid=${req.uid} name=${req.userName} requested=${requestedMonth} month=${month} reports=${autoSummary.reportCount || 0}`);
  res.json(result.rows[0]);
});

// ── 할 일 순서/카테고리 변경 ───────────────────────────────
app.post('/api/events/reorder', authMiddleware, async (req, res) => {
  const { items } = req.body; // [{id, sortOrder, todoCat}]
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });
  for (const item of items) {
    if (isExternalCalendarUser(req)) {
      await pool.query(
        'UPDATE events SET sort_order = $1, todo_cat = COALESCE($2, todo_cat) WHERE id = $3 AND owner_id = $4',
        [item.sortOrder, item.todoCat || null, item.id, req.uid]
      );
    } else {
      await pool.query(
        'UPDATE events SET sort_order = $1, todo_cat = COALESCE($2, todo_cat) WHERE id = $3',
        [item.sortOrder, item.todoCat || null, item.id]
      );
    }
  }
  res.json({ ok: true });
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
  const ev = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) return res.status(403).json({ error: 'Not owner' });
  const parentId = ev.rows[0].repeat_parent_id || ev.rows[0].id;
  const { fromDate } = req.body;
  await pool.query(
    'UPDATE events SET deleted = true WHERE (repeat_parent_id = $1 OR id = $1) AND date >= $2',
    [parentId, fromDate]
  );
  res.json({ ok: true });
});

app.post('/api/events/:id/delete-repeat-all', authMiddleware, async (req, res) => {
  if (!req.userDoc?.approved) return res.status(403).json({ error: 'Not approved' });
  const ev = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.userDoc.role !== 'admin' && ev.rows[0].owner_id !== req.uid) return res.status(403).json({ error: 'Not owner' });
  const parentId = ev.rows[0].repeat_parent_id || ev.rows[0].id;
  await pool.query(
    'UPDATE events SET deleted = true WHERE repeat_parent_id = $1 OR id = $1',
    [parentId]
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
         AND NOT ${INTERNAL_CALENDAR_RULE_EVENT_SQL}
       GROUP BY ec.event_id`,
      [req.uid]
    )
    : await pool.query(
      `SELECT event_id, COUNT(*) as total, COUNT(*) FILTER (WHERE done=true) as completed
       FROM event_checklist GROUP BY event_id`
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

async function softDeleteEventIds(ids) {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await pool.query(
      'UPDATE events SET deleted = true WHERE id = ANY($1::text[])',
      [ids.slice(i, i + BATCH_SIZE)]
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
       WHERE u.approved = true
         AND COALESCE(u.is_active, true) = true
         AND u.role != 'admin'
         AND COALESCE(u.chat_only, false) = false
         AND COALESCE(u.external_calendar_only, false) = false`
    ),
    pool.query('SELECT 1 FROM holidays WHERE holiday_date = $1 LIMIT 1', [date]),
    pool.query(
      `SELECT id, owner_id, date, title, done, created_at
       FROM events
       WHERE deleted = false AND title = ANY($1::text[])
       ORDER BY owner_id, date, title, done DESC, created_at, id`,
      [REPORT_REMINDER_TITLES]
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
  await softDeleteEventIds(deleteIds);

  const missing = expected.filter(row => !keptKeys.has(reminderKey(row.ownerId, date, row.title)));
  if (missing.length) {
    const values = [];
    const params = [];
    missing.forEach((row, index) => {
      const base = index * 4;
      values.push(`('todo',$${base + 1},$${base + 2},'personal',$${base + 3},$${base + 4},'보고서')`);
      params.push(row.title, date, row.ownerId, row.ownerName);
    });
    await pool.query(
      `INSERT INTO events (type,title,date,scope,owner_id,owner_name,todo_cat)
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
    `UPDATE events SET done = true WHERE owner_id = $1 AND date = $2 AND title = '📋 업무보고 작성' AND deleted = false`,
    [req.uid, reportDate]
  );
  // admin에게 업무보고 확인 할일 추가
  const admins = await pool.query("SELECT uid, name FROM users WHERE role = 'admin' AND uid != $1", [req.uid]);
  for (const a of admins.rows) {
    const exists = await pool.query(
      `SELECT 1 FROM events WHERE owner_id=$1 AND date=$2 AND title LIKE $3 AND deleted=false`,
      [a.uid, reportDate, `📋 ${req.userName}%업무보고%`]
    );
    if (!exists.rows[0]) {
      await pool.query(
        `INSERT INTO events (type,title,date,scope,owner_id,owner_name,todo_cat) VALUES ('todo',$1,$2,'personal',$3,$4,'보고서')`,
        [`📋 ${req.userName} 업무보고 확인`, reportDate, a.uid, a.name||'']
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
const EXTERNAL_API_KEY = '4210786b72641a28115b3c12e70d3d6b4fa9f939fa910ef41e2f81a32cc04425';
const EXTERNAL_OWNER_UID = 'AWTTuoILg6TkwkkHTvIoqsb8BST2';
const EXTERNAL_OWNER_NAME = '패션TV봉이';

app.post('/api/add-idea', async (req, res) => {
  // API 키 검증
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== 'Bearer ' + EXTERNAL_API_KEY) {
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
       AND NOT EXISTS (SELECT 1 FROM timetable_entries t WHERE t.event_id = e.id AND t.owner_id = $1 AND t.date = $2)
       ORDER BY e.time, e.created_at`,
      [req.uid, date]
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
    const users = await pool.query('SELECT uid, name FROM users WHERE approved = true AND is_active != false');
    for (const user of users.rows) {
      const overdue = await pool.query(
        "SELECT COUNT(*) FROM events WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date < $2",
        [user.uid, today]
      );
      const count = parseInt(overdue.rows[0].count);
      if (count > 0) {
        // 상위 3개 제목 가져오기
        const top = await pool.query(
          "SELECT title FROM events WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date < $2 ORDER BY date LIMIT 3",
          [user.uid, today]
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
    const users = await pool.query('SELECT uid FROM users WHERE approved = true AND is_active != false');
    for (const user of users.rows) {
      const pending = await pool.query(
        "SELECT COUNT(*) FROM events WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date = $2",
        [user.uid, today]
      );
      const count = parseInt(pending.rows[0].count);
      if (count > 0) {
        const top = await pool.query(
          "SELECT title FROM events WHERE owner_id = $1 AND deleted = false AND type = 'todo' AND done = false AND date = $2 ORDER BY time NULLS FIRST, created_at LIMIT 3",
          [user.uid, today]
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


// ─────────────────────────────────────────────────────────────
// PEAK OS 정산 — 브라우저 초안을 계정 기준 서버 저장으로 옮긴다.
// 본사(hq)만 쓰며 지사(대구·전주)는 별도 체계를 따로 만든다.
// 화면 쪽 권한과 같은 기준을 서버에서도 다시 막는다.
// ─────────────────────────────────────────────────────────────
const PEAKOS_FINAL_VIEWERS = ['김진봉', '패션TV봉이', '손명아', '김대호', '박종원', '전현우'];
const PEAKOS_TEAM_VIEWERS = ['김진봉', '패션TV봉이', '김대호', '박종원'];
const PEAKOS_MONTHLY_OWNERS = { 'monthly-guarantee': '김지홍', 'monthly-manage': '박우진' };

function peakosName(req) {
  return String(req.userDoc?.name || req.userName || '').trim();
}
function peakosIsAdmin(req) {
  return req.userDoc?.role === 'admin';
}
function peakosCanSeeAll(req) {
  return peakosIsAdmin(req) || PEAKOS_FINAL_VIEWERS.includes(peakosName(req));
}
function peakosCanSeeTeam(req) {
  return peakosIsAdmin(req) || PEAKOS_TEAM_VIEWERS.includes(peakosName(req));
}
function peakosCanSeeMonthly(req, view) {
  return peakosCanSeeAll(req) || peakosName(req) === PEAKOS_MONTHLY_OWNERS[view];
}

const PEAKOS_INTAKE_COLUMNS = [
  'id', 'owner_uid', 'owner_name', 'date', 'client', 'a', 'b', 'c', 'unit', 'qty', 'sell', 'cost',
  'memo', 'kind', 'ref_of', 'supplier', 'manager', 'final_only', 'paid', 'paid_amount', 'payer',
  'paid_date', 'paid_memo', 'paid_auto', 'vendor_paid', 'vendor_paid_date', 'vendor_bank',
  'vendor_by', 'vendor_memo'
];

function peakosIntakeRow(body, req) {
  const num = value => (value === '' || value === null || value === undefined ? null : Number(value));
  return {
    id: String(body.id || '').slice(0, 80),
    owner_uid: req.uid,
    owner_name: peakosName(req),
    date: String(body.date || '').slice(0, 10),
    client: String(body.client || '').slice(0, 200),
    a: String(body.a || '').slice(0, 80),
    b: String(body.b || '').slice(0, 80),
    c: String(body.c || '').slice(0, 120),
    unit: num(body.unit) ?? 0,
    qty: num(body.qty) ?? 0,
    sell: num(body.sell) ?? 0,
    cost: num(body.cost),
    memo: String(body.memo || '').slice(0, 500),
    kind: ['normal', 'reserve', 'use', 'refund'].includes(body.kind) ? body.kind : 'normal',
    ref_of: String(body.refOf || '').slice(0, 80),
    supplier: String(body.supplier || '').slice(0, 120),
    manager: String(body.manager || '').slice(0, 80),
    final_only: Boolean(body.finalOnly),
    paid: ['none', 'paid', 'partial', 'wrong'].includes(body.paid) ? body.paid : 'none',
    paid_amount: num(body.paidAmount) ?? 0,
    payer: String(body.payer || '').slice(0, 120),
    paid_date: String(body.paidDate || '').slice(0, 10),
    paid_memo: String(body.paidMemo || '').slice(0, 500),
    paid_auto: Boolean(body.paidAuto),
    vendor_paid: Boolean(body.vendorPaid),
    vendor_paid_date: String(body.vendorPaidDate || '').slice(0, 10),
    vendor_bank: String(body.vendorBank || '').slice(0, 80),
    vendor_by: String(body.vendorBy || '').slice(0, 80),
    vendor_memo: String(body.vendorMemo || '').slice(0, 500)
  };
}

function peakosIntakeOut(row) {
  return {
    id: row.id,
    owner: row.owner_uid,
    ownerName: row.owner_name || '',
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    client: row.client || '',
    a: row.a || '', b: row.b || '', c: row.c || '',
    unit: Number(row.unit) || 0,
    qty: Number(row.qty) || 0,
    sell: Number(row.sell) || 0,
    cost: row.cost === null ? null : Number(row.cost),
    memo: row.memo || '',
    kind: row.kind,
    refOf: row.ref_of || '',
    supplier: row.supplier || '',
    manager: row.manager || '',
    finalOnly: row.final_only,
    paid: row.paid,
    paidAmount: Number(row.paid_amount) || 0,
    payer: row.payer || '',
    paidDate: row.paid_date || '',
    paidMemo: row.paid_memo || '',
    paidAuto: row.paid_auto,
    vendorPaid: row.vendor_paid,
    vendorPaidDate: row.vendor_paid_date || '',
    vendorBank: row.vendor_bank || '',
    vendorBy: row.vendor_by || '',
    vendorMemo: row.vendor_memo || ''
  };
}

// 접수 조회. scope=mine 은 내 것, all 은 전 영업자(지정 인원만).
app.get('/api/peakos/intake', authMiddleware, async (req, res) => {
  try {
    const wantsAll = req.query.scope === 'all';
    if (wantsAll && !peakosCanSeeAll(req)) {
      return res.status(403).json({ error: '전체 접수는 지정된 인원만 볼 수 있습니다.' });
    }
    const result = wantsAll
      ? await pool.query('SELECT * FROM peakos_intake ORDER BY date DESC, created_at DESC')
      : await pool.query('SELECT * FROM peakos_intake WHERE owner_uid = $1 ORDER BY date DESC, created_at DESC', [req.uid]);
    res.json(result.rows.map(peakosIntakeOut));
  } catch (err) {
    console.error('peakos intake read error:', err.message);
    res.status(500).json({ error: '접수를 불러오지 못했습니다.' });
  }
});

// 저장은 통째로 덮어쓰지 않고 건별로 넣거나 고친다.
app.post('/api/peakos/intake', authMiddleware, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body];
  if (!rows.length || rows.length > 500) {
    return res.status(400).json({ error: '한 번에 1~500건까지 저장할 수 있습니다.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const body of rows) {
      const row = peakosIntakeRow(body, req);
      if (!row.id || !row.date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'id와 일자는 반드시 있어야 합니다.' });
      }
      // 남의 건을 덮어쓰지 못하게 막는다.
      const own = await client.query('SELECT owner_uid FROM peakos_intake WHERE id = $1', [row.id]);
      if (own.rows[0] && own.rows[0].owner_uid !== req.uid) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '다른 사람의 접수는 고칠 수 없습니다.' });
      }
      const cols = PEAKOS_INTAKE_COLUMNS;
      const values = cols.map(col => row[col]);
      const holders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const updates = cols.filter(col => col !== 'id' && col !== 'owner_uid')
        .map(col => `${col} = EXCLUDED.${col}`).join(', ');
      await client.query(
        `INSERT INTO peakos_intake (${cols.join(', ')}) VALUES (${holders})
         ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()`,
        values
      );
    }
    await client.query('COMMIT');
    res.json({ saved: rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('peakos intake write error:', err.message);
    res.status(500).json({ error: '접수를 저장하지 못했습니다.' });
  } finally {
    client.release();
  }
});

app.delete('/api/peakos/intake/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM peakos_intake WHERE id = $1 AND owner_uid = $2 RETURNING id',
      [req.params.id, req.uid]
    );
    if (!result.rows[0]) return res.status(404).json({ error: '내 접수에서 찾지 못했습니다.' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error('peakos intake delete error:', err.message);
    res.status(500).json({ error: '접수를 지우지 못했습니다.' });
  }
});

// 단가표는 회사 공용. 읽기는 전원, 쓰기는 지정 인원만.
app.get('/api/peakos/prices', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM peakos_price ORDER BY a, b, c');
    res.json(result.rows.map(row => ({
      key: row.key, a: row.a, b: row.b, c: row.c,
      cost: row.cost === null ? null : Number(row.cost),
      unit: row.unit === null ? null : Number(row.unit),
      custom: row.is_custom, updatedBy: row.updated_by || ''
    })));
  } catch (err) {
    console.error('peakos price read error:', err.message);
    res.status(500).json({ error: '단가표를 불러오지 못했습니다.' });
  }
});

app.put('/api/peakos/prices', authMiddleware, async (req, res) => {
  if (!peakosCanSeeAll(req)) {
    return res.status(403).json({ error: '단가표는 지정된 인원만 고칠 수 있습니다.' });
  }
  const { key, a, b, c, cost, unit, custom } = req.body || {};
  if (!key || !a || !b || !c) return res.status(400).json({ error: '분류를 모두 채워 주세요.' });
  const num = value => (value === '' || value === null || value === undefined ? null : Number(value));
  try {
    await pool.query(
      `INSERT INTO peakos_price (key, a, b, c, cost, unit, is_custom, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (key) DO UPDATE SET cost = EXCLUDED.cost, unit = EXCLUDED.unit,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [String(key).slice(0, 300), String(a).slice(0, 80), String(b).slice(0, 80), String(c).slice(0, 120),
       num(cost), num(unit), Boolean(custom), peakosName(req)]
    );
    res.json({ saved: key });
  } catch (err) {
    console.error('peakos price write error:', err.message);
    res.status(500).json({ error: '단가표를 저장하지 못했습니다.' });
  }
});

app.delete('/api/peakos/prices/:key', authMiddleware, async (req, res) => {
  if (!peakosCanSeeAll(req)) {
    return res.status(403).json({ error: '단가표는 지정된 인원만 고칠 수 있습니다.' });
  }
  try {
    await pool.query('DELETE FROM peakos_price WHERE key = $1', [req.params.key]);
    res.json({ deleted: req.params.key });
  } catch (err) {
    console.error('peakos price delete error:', err.message);
    res.status(500).json({ error: '단가표를 지우지 못했습니다.' });
  }
});

// 충전금 — 회사 돈이라 지정 인원만.
app.get('/api/peakos/credit', authMiddleware, async (req, res) => {
  if (!peakosCanSeeAll(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 볼 수 있습니다.' });
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
  if (!peakosCanSeeAll(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 기입할 수 있습니다.' });
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
  if (!peakosCanSeeAll(req)) return res.status(403).json({ error: '충전금은 지정된 인원만 지울 수 있습니다.' });
  try {
    await pool.query('DELETE FROM peakos_credit WHERE id = $1', [req.params.id]);
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error('peakos credit delete error:', err.message);
    res.status(500).json({ error: '충전금을 지우지 못했습니다.' });
  }
});

// 월보장 / 월관리 — 본인과 지정 인원만.
app.get('/api/peakos/monthly/:view', authMiddleware, async (req, res) => {
  const view = req.params.view;
  if (!PEAKOS_MONTHLY_OWNERS[view]) return res.status(404).json({ error: '없는 화면입니다.' });
  if (!peakosCanSeeMonthly(req, view)) return res.status(403).json({ error: '열람 권한이 없습니다.' });
  try {
    const result = await pool.query('SELECT * FROM peakos_monthly WHERE view = $1 ORDER BY created_at', [view]);
    res.json(result.rows.map(row => ({
      id: row.id, kind: row.kind, parentId: row.parent_id || '',
      date: String(row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date).slice(0, 10),
      client: row.client || '', a: row.a || '', b: row.b || '', c: row.c || '',
      amount: Number(row.amount) || 0, qty: Number(row.qty) || 0,
      period: row.period || '', memo: row.memo || ''
    })));
  } catch (err) {
    console.error('peakos monthly read error:', err.message);
    res.status(500).json({ error: '정산을 불러오지 못했습니다.' });
  }
});

app.post('/api/peakos/monthly/:view', authMiddleware, async (req, res) => {
  const view = req.params.view;
  if (!PEAKOS_MONTHLY_OWNERS[view]) return res.status(404).json({ error: '없는 화면입니다.' });
  if (!peakosCanSeeMonthly(req, view)) return res.status(403).json({ error: '열람 권한이 없습니다.' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body];
  if (!rows.length || rows.length > 500) return res.status(400).json({ error: '한 번에 1~500건까지 저장할 수 있습니다.' });
  try {
    for (const body of rows) {
      if (!body.id || !body.date) return res.status(400).json({ error: 'id와 일자는 반드시 있어야 합니다.' });
      await pool.query(
        `INSERT INTO peakos_monthly (id, view, owner_uid, owner_name, kind, parent_id, date, client, a, b, c, amount, qty, period, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id,
           date = EXCLUDED.date, client = EXCLUDED.client, a = EXCLUDED.a, b = EXCLUDED.b, c = EXCLUDED.c,
           amount = EXCLUDED.amount, qty = EXCLUDED.qty, period = EXCLUDED.period, memo = EXCLUDED.memo`,
        [String(body.id).slice(0, 80), view, req.uid, peakosName(req),
         body.kind === 'run' ? 'run' : 'sale', String(body.parentId || '').slice(0, 80),
         String(body.date).slice(0, 10), String(body.client || '').slice(0, 200),
         String(body.a || '').slice(0, 80), String(body.b || '').slice(0, 80), String(body.c || '').slice(0, 120),
         Number(body.amount) || 0, Number(body.qty) || 0,
         String(body.period || '').slice(0, 120), String(body.memo || '').slice(0, 500)]
      );
    }
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('peakos monthly write error:', err.message);
    res.status(500).json({ error: '정산을 저장하지 못했습니다.' });
  }
});

app.delete('/api/peakos/monthly/:view/:id', authMiddleware, async (req, res) => {
  const view = req.params.view;
  if (!PEAKOS_MONTHLY_OWNERS[view]) return res.status(404).json({ error: '없는 화면입니다.' });
  if (!peakosCanSeeMonthly(req, view)) return res.status(403).json({ error: '열람 권한이 없습니다.' });
  try {
    // 판매 건을 지우면 붙어 있던 실행 건도 같이 지운다.
    await pool.query('DELETE FROM peakos_monthly WHERE view = $1 AND (id = $2 OR parent_id = $2)', [view, req.params.id]);
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error('peakos monthly delete error:', err.message);
    res.status(500).json({ error: '정산을 지우지 못했습니다.' });
  }
});

// 자금 현황판 — 회사에 하나. 대표·김대호·박종원만.
app.get('/api/peakos/fund', authMiddleware, async (req, res) => {
  if (!peakosCanSeeTeam(req)) return res.status(403).json({ error: '자금 현황은 지정된 인원만 볼 수 있습니다.' });
  try {
    const result = await pool.query('SELECT board, updated_by, updated_at FROM peakos_fund WHERE id = 1');
    res.json(result.rows[0]?.board || null);
  } catch (err) {
    console.error('peakos fund read error:', err.message);
    res.status(500).json({ error: '자금 현황을 불러오지 못했습니다.' });
  }
});

app.put('/api/peakos/fund', authMiddleware, async (req, res) => {
  if (!peakosCanSeeTeam(req)) return res.status(403).json({ error: '자금 현황은 지정된 인원만 고칠 수 있습니다.' });
  const board = req.body?.board;
  if (!board || typeof board !== 'object') return res.status(400).json({ error: '보낼 내용이 없습니다.' });
  try {
    await pool.query(
      `INSERT INTO peakos_fund (id, board, updated_by, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET board = EXCLUDED.board, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(board), peakosName(req)]
    );
    res.json({ saved: true });
  } catch (err) {
    console.error('peakos fund write error:', err.message);
    res.status(500).json({ error: '자금 현황을 저장하지 못했습니다.' });
  }
});

async function startServer() {
  try {
    await ensureReminderInfrastructure();
    await ensureChatPerformanceIndexes();
    await ensureChatRoomGroupInfrastructure();
    await ensureServiceRequestInfrastructure();
    await ensureIdeaInfrastructure();
    await ensureExternalCalendarInfrastructure();
    await ensureProjectInfrastructure();
    await ensureReportReminderInfrastructure();
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`Calendar API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Server startup failed:', err.message);
    process.exit(1);
  }
}

startServer();
