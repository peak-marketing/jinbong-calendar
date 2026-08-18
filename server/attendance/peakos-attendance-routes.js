'use strict';

const {
  AttendanceConflictError,
  AttendanceError,
  attendanceAccess,
  kstParts,
  monthRange,
  parseMonth,
  resolveReadScope,
} = require('./peakos-attendance-policy');
const {
  ensurePeakosAttendanceInfrastructure,
} = require('./peakos-attendance-infrastructure');

const ATTENDANCE_BASE_PATH = '/api/peakos/attendance';

const RECORD_COLUMNS = `attendance_row.id,
  attendance_row.workspace_id,
  attendance_row.user_id,
  attendance_row.user_name,
  attendance_row.attendance_date,
  attendance_row.check_in,
  attendance_row.check_out,
  attendance_row.check_in_at,
  attendance_row.check_out_at,
  attendance_row.group_id,
  attendance_row.row_version`;

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function isoInstant(value) {
  if (!value) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function serializeRecord(row) {
  const checkIn = String(row?.check_in || '');
  const checkOut = row?.check_out === null || row?.check_out === undefined
    ? null : String(row.check_out);
  const workedMinutes = row?.worked_minutes === null || row?.worked_minutes === undefined
    ? null : Math.max(0, finiteInteger(row.worked_minutes));
  return Object.freeze({
    id: String(row?.id || ''),
    userUid: String(row?.user_id || ''),
    userName: String(row?.user_name || ''),
    groupId: row?.group_id === null || row?.group_id === undefined ? null : String(row.group_id),
    date: String(row?.attendance_date || ''),
    checkIn,
    checkOut,
    checkInAt: isoInstant(row?.check_in_at),
    checkOutAt: isoInstant(row?.check_out_at),
    workedMinutes,
    isHoliday: row?.is_holiday === true,
    isLate: row?.is_holiday !== true && !!checkIn && checkIn > '10:10',
    version: Math.max(1, finiteInteger(row?.row_version, 1)),
  });
}

function serializeLegacyRecord(record) {
  return {
    id: record.id,
    user_id: record.userUid,
    user_name: record.userName,
    group_id: record.groupId,
    attendance_date: record.date,
    check_in: record.checkIn,
    check_out: record.checkOut,
    check_in_at: record.checkInAt,
    check_out_at: record.checkOutAt,
    worked_minutes: record.workedMinutes,
    is_holiday: record.isHoliday,
    is_late: record.isLate,
    row_version: record.version,
  };
}

function summarizeMembers(members, records) {
  const aggregate = new Map();
  for (const member of members) {
    aggregate.set(String(member.uid), {
      uid: String(member.uid),
      name: String(member.name || member.email || ''),
      groupId: member.group_id === null || member.group_id === undefined
        ? null : String(member.group_id),
      role: String(member.membership_role || 'member'),
      presentDays: 0,
      lateDays: 0,
      openDays: 0,
      workedMinutes: 0,
    });
  }
  for (const record of records) {
    if (!aggregate.has(record.userUid)) {
      aggregate.set(record.userUid, {
        uid: record.userUid,
        name: record.userName,
        groupId: record.groupId,
        role: 'historical',
        presentDays: 0,
        lateDays: 0,
        openDays: 0,
        workedMinutes: 0,
      });
    }
    const summary = aggregate.get(record.userUid);
    summary.presentDays += 1;
    if (record.isLate) summary.lateDays += 1;
    if (!record.checkOut) summary.openDays += 1;
    summary.workedMinutes += record.workedMinutes || 0;
  }
  return [...aggregate.values()].sort((left, right) => (
    left.name.localeCompare(right.name, 'ko') || left.uid.localeCompare(right.uid)
  ));
}

function createPeakosAttendanceService({
  pool,
  now = () => new Date(),
  ensureInfrastructure = ensurePeakosAttendanceInfrastructure,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('attendance pool is required');
  }
  if (typeof now !== 'function' || typeof ensureInfrastructure !== 'function') {
    throw new TypeError('attendance dependencies are invalid');
  }

  let readinessPromise = null;
  async function ready() {
    if (!readinessPromise) {
      readinessPromise = Promise.resolve(ensureInfrastructure(pool)).catch(error => {
        readinessPromise = null;
        throw error;
      });
    }
    return readinessPromise;
  }

  async function listMonth(req, { month, scope = 'self', targetUid } = {}) {
    await ready();
    const access = resolveReadScope(req, { scope, targetUid });
    const selectedMonth = parseMonth(month, now());
    const range = monthRange(selectedMonth);
    const params = [access.workspaceId, range.from, range.to];
    let ownerPredicate = '';
    if (access.scope === 'team' && access.role === 'manager') {
      params.push(access.groupId);
      ownerPredicate += `AND EXISTS (
        SELECT 1
          FROM peakos_workspace_memberships scoped_membership
          JOIN users scoped_user ON scoped_user.uid = scoped_membership.user_uid
         WHERE scoped_membership.workspace_id = attendance_row.workspace_id
           AND scoped_membership.user_uid = attendance_row.user_id
           AND scoped_membership.active = TRUE
           AND scoped_membership.role <> 'oversight'
           AND scoped_user.approved = TRUE
           AND COALESCE(scoped_user.is_active, TRUE) = TRUE
           AND scoped_user.group_id = $${params.length}
      )`;
    }
    if (access.scope === 'self' || access.targetUid) {
      params.push(access.targetUid || access.uid);
      ownerPredicate += `AND attendance_row.user_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT ${RECORD_COLUMNS},
              CASE WHEN attendance_row.check_out_at IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM
                     (attendance_row.check_out_at - attendance_row.check_in_at)) / 60)::integer
              END AS worked_minutes,
              EXISTS (
                SELECT 1 FROM holidays holiday
                 WHERE holiday.holiday_date::text = attendance_row.attendance_date
              ) AS is_holiday
         FROM attendance attendance_row
        WHERE attendance_row.workspace_id = $1
          AND attendance_row.attendance_date >= $2
          AND attendance_row.attendance_date < $3
          ${ownerPredicate}
        ORDER BY attendance_row.attendance_date, attendance_row.user_name, attendance_row.id`,
      params,
    );
    const records = result.rows.map(serializeRecord);

    let members = [];
    let summary = [];
    if (access.scope === 'team') {
      const memberParams = [access.workspaceId];
      let memberPredicate = '';
      if (access.role === 'manager') {
        memberParams.push(access.groupId);
        memberPredicate += `AND users.group_id = $${memberParams.length} `;
      }
      if (access.targetUid) {
        memberParams.push(access.targetUid);
        memberPredicate += `AND users.uid = $${memberParams.length}`;
      }
      const memberResult = await pool.query(
        `SELECT users.uid, users.name, users.email, users.group_id,
                membership.role AS membership_role
           FROM peakos_workspace_memberships membership
           JOIN users ON users.uid = membership.user_uid
          WHERE membership.workspace_id = $1
            AND membership.active = TRUE
            AND users.approved = TRUE
            AND COALESCE(users.is_active, TRUE) = TRUE
            AND COALESCE(users.chat_only, FALSE) = FALSE
            AND COALESCE(users.external_calendar_only, FALSE) = FALSE
            ${memberPredicate}
          ORDER BY users.name, users.uid`,
        memberParams,
      );
      members = memberResult.rows.map(member => Object.freeze({
        uid: String(member.uid),
        name: String(member.name || member.email || ''),
        groupId: member.group_id === null || member.group_id === undefined
          ? null : String(member.group_id),
        role: String(member.membership_role || 'member'),
      }));
      summary = summarizeMembers(memberResult.rows, records);
    }

    return Object.freeze({
      month: selectedMonth,
      timeZone: 'Asia/Seoul',
      scope: access.scope,
      targetUid: access.targetUid,
      canViewTeam: access.canViewTeam,
      readOnly: access.readOnly,
      records,
      members,
      summary,
    });
  }

  async function checkIn(req) {
    await ready();
    const access = attendanceAccess(req, { action: 'write' });
    const current = kstParts(now());
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`peakos-attendance:${access.workspaceId}:${access.uid}:${current.date}`],
      );
      const inserted = await client.query(
        `INSERT INTO attendance
           (workspace_id, user_id, user_name, attendance_date,
            check_in, check_in_at, check_out, check_out_at,
            group_id, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, 1)
         ON CONFLICT (workspace_id, user_id, attendance_date) DO NOTHING
         RETURNING ${RECORD_COLUMNS.replaceAll('attendance_row.', '')}`,
        [
          access.workspaceId,
          access.uid,
          access.name,
          current.date,
          current.time,
          current.instant,
          req?.userDoc?.group_id || null,
        ],
      );
      let row = inserted.rows[0];
      const alreadyRecorded = !row;
      if (!row) {
        const existing = await client.query(
          `SELECT ${RECORD_COLUMNS}
             FROM attendance attendance_row
            WHERE attendance_row.workspace_id = $1
              AND attendance_row.user_id = $2
              AND attendance_row.attendance_date = $3
            FOR SHARE`,
          [access.workspaceId, access.uid, current.date],
        );
        row = existing.rows[0];
        if (!row) throw new AttendanceConflictError('출근 기록을 확인하지 못했습니다.');
      } else {
        await client.query(
          `INSERT INTO peakos_attendance_events
             (workspace_id, attendance_id, event_type, actor_uid,
              actor_name_snapshot, occurred_at, record_version)
           VALUES ($1, $2, 'CHECK_IN', $3, $4, $5, $6)`,
          [access.workspaceId, row.id, access.uid, access.name, current.instant, row.row_version],
        );
      }
      await client.query('COMMIT');
      return Object.freeze({
        alreadyRecorded,
        record: serializeRecord(row),
        timeZone: 'Asia/Seoul',
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function checkOut(req) {
    await ready();
    const access = attendanceAccess(req, { action: 'write' });
    const current = kstParts(now());
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`peakos-attendance:${access.workspaceId}:${access.uid}:${current.date}`],
      );
      const existing = await client.query(
        `SELECT ${RECORD_COLUMNS}
           FROM attendance attendance_row
          WHERE attendance_row.workspace_id = $1
            AND attendance_row.user_id = $2
            AND attendance_row.attendance_date = $3
          FOR UPDATE`,
        [access.workspaceId, access.uid, current.date],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new AttendanceConflictError(
          '오늘 출근 기록이 없습니다. 먼저 출근을 등록해 주세요.',
          'ATTENDANCE_CHECK_IN_REQUIRED',
        );
      }
      if (row.check_out_at) {
        await client.query('COMMIT');
        return Object.freeze({
          alreadyRecorded: true,
          record: serializeRecord(row),
          timeZone: 'Asia/Seoul',
        });
      }

      const updated = await client.query(
        `UPDATE attendance
            SET check_out = $4,
                check_out_at = $5,
                row_version = row_version + 1
          WHERE workspace_id = $1
            AND user_id = $2
            AND attendance_date = $3
            AND check_out_at IS NULL
          RETURNING ${RECORD_COLUMNS.replaceAll('attendance_row.', '')}`,
        [access.workspaceId, access.uid, current.date, current.time, current.instant],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new AttendanceConflictError(
          '퇴근 기록이 다른 요청에서 변경되었습니다. 새로고침해 주세요.',
          'ATTENDANCE_STALE_WRITE',
        );
      }
      await client.query(
        `INSERT INTO peakos_attendance_events
           (workspace_id, attendance_id, event_type, actor_uid,
            actor_name_snapshot, occurred_at, record_version)
         VALUES ($1, $2, 'CHECK_OUT', $3, $4, $5, $6)`,
        [
          access.workspaceId, updatedRow.id, access.uid, access.name,
          current.instant, updatedRow.row_version,
        ],
      );
      await client.query('COMMIT');
      return Object.freeze({
        alreadyRecorded: false,
        record: serializeRecord(updatedRow),
        timeZone: 'Asia/Seoul',
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ checkIn, checkOut, listMonth, ready });
}

function sendAttendanceError(res, error, logger = console) {
  const statusCode = Number(error?.statusCode) || 500;
  if (!(error instanceof AttendanceError) && statusCode >= 500) {
    logger.error?.(`[attendance] code=${String(error?.code || 'ATTENDANCE_FAILED').slice(0, 80)}`);
  }
  res.status(statusCode).json({
    code: statusCode >= 500 ? (error?.code || 'ATTENDANCE_FAILED') : error.code,
    error: statusCode >= 500 ? '근태 정보를 처리하지 못했습니다.' : error.message,
  });
}

function registerPeakosAttendanceRoutes({
  app,
  pool,
  readMiddlewares = [],
  writeMiddlewares = [],
  now,
  ensureInfrastructure,
  logger = console,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('attendance app is required');
  }
  const service = createPeakosAttendanceService({ pool, now, ensureInfrastructure });
  const read = Array.isArray(readMiddlewares) ? readMiddlewares : [readMiddlewares];
  const write = Array.isArray(writeMiddlewares) ? writeMiddlewares : [writeMiddlewares];

  app.get(`${ATTENDANCE_BASE_PATH}/month`, ...read, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.vary('X-PeakOS-Workspace');
      res.vary('Authorization');
      const payload = await service.listMonth(req, {
        month: req.query?.month,
        scope: req.query?.scope,
        targetUid: req.query?.targetUid,
      });
      res.json(payload);
    } catch (error) {
      sendAttendanceError(res, error, logger);
    }
  });

  app.post(`${ATTENDANCE_BASE_PATH}/check-in`, ...write, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.vary('X-PeakOS-Workspace');
      res.vary('Authorization');
      res.json(await service.checkIn(req));
    } catch (error) {
      sendAttendanceError(res, error, logger);
    }
  });

  app.post(`${ATTENDANCE_BASE_PATH}/check-out`, ...write, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.vary('X-PeakOS-Workspace');
      res.vary('Authorization');
      res.json(await service.checkOut(req));
    } catch (error) {
      sendAttendanceError(res, error, logger);
    }
  });

  return service;
}

function createLegacyAttendanceHandlers({ service, logger = console } = {}) {
  if (!service) throw new TypeError('attendance service is required');
  const wrap = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendAttendanceError(res, error, logger);
    }
  };
  return Object.freeze({
    list: wrap(async (req, res) => {
      const targetUid = req.query?.userId || null;
      const scope = targetUid && targetUid !== req.uid ? 'team' : 'self';
      const payload = await service.listMonth(req, { month: req.query?.month, scope, targetUid });
      res.json(payload.records.map(serializeLegacyRecord));
    }),
    details: wrap(async (req, res) => {
      const targetUid = req.query?.userId || null;
      const access = attendanceAccess(req, { action: 'read' });
      const scope = targetUid && targetUid !== access.uid
        ? 'team'
        : (!targetUid && access.canViewTeam ? 'team' : 'self');
      const payload = await service.listMonth(req, { month: req.query?.month, scope, targetUid });
      res.json(payload.records.map(serializeLegacyRecord));
    }),
    summary: wrap(async (req, res) => {
      const payload = await service.listMonth(req, { month: req.query?.month, scope: 'team' });
      res.json(payload.summary.map(row => ({
        uid: row.uid,
        name: row.name,
        group_id: row.groupId,
        total_days: row.presentDays,
        late_days: row.lateDays,
        open_days: row.openDays,
        worked_minutes: row.workedMinutes,
      })));
    }),
    checkIn: wrap(async (req, res) => {
      const payload = await service.checkIn(req);
      res.json(serializeLegacyRecord(payload.record));
    }),
    checkOut: wrap(async (req, res) => {
      const payload = await service.checkOut(req);
      res.json(serializeLegacyRecord(payload.record));
    }),
  });
}

module.exports = {
  ATTENDANCE_BASE_PATH,
  createLegacyAttendanceHandlers,
  createPeakosAttendanceService,
  registerPeakosAttendanceRoutes,
  serializeLegacyRecord,
  serializeRecord,
  summarizeMembers,
};
