'use strict';

const crypto = require('node:crypto');
const {
  TodoError,
  normalizeCreateBody,
  normalizeDate,
  normalizeDeleteBody,
  normalizeId,
  normalizePatchBody,
  normalizeReorderBody,
  todoAccess,
  validateTimeRange,
} = require('./peakos-todo-policy');
const {
  ensurePeakosTodoInfrastructure,
} = require('./peakos-todo-infrastructure');

const TODO_BASE_PATH = '/api/peakos/todos';
const TODO_COLUMNS = `workspace_id, id, owner_uid, owner_name_snapshot,
  title, todo_date, start_time, end_time, category, memo, done, sort_order,
  archived, archived_at, version, created_at, updated_at`;

function serializeDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function serializeTime(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value).slice(0, 5);
}

function mapTodo(row) {
  return Object.freeze({
    id: String(row.id),
    title: String(row.title || ''),
    date: serializeDate(row.todo_date),
    startTime: serializeTime(row.start_time),
    endTime: serializeTime(row.end_time),
    category: String(row.category || '일반'),
    memo: String(row.memo || ''),
    done: row.done === true,
    sortOrder: Number(row.sort_order || 0),
    version: Number(row.version || 1),
    ownerUid: String(row.owner_uid || ''),
    ownerName: String(row.owner_name_snapshot || ''),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  });
}

function notFound() {
  return new TodoError(404, 'TODO_NOT_FOUND', '할 일을 찾을 수 없습니다.');
}

function versionConflict() {
  return new TodoError(409, 'TODO_VERSION_CONFLICT', '할 일이 다른 기기에서 변경됐습니다. 새로고침 후 다시 시도해 주세요.');
}

function sendError(res, error) {
  const status = Number(error?.statusCode || error?.status) || 500;
  const code = String(error?.code || 'TODO_INTERNAL_ERROR');
  const message = status >= 500 ? '할 일을 처리하지 못했습니다.' : error.message;
  return res.status(status).json({ code, error: message });
}

function currentTimes(row) {
  return {
    startTime: serializeTime(row.start_time) || null,
    endTime: serializeTime(row.end_time) || null,
  };
}

function createPeakosTodoService({
  pool,
  ensureInfrastructure = ensurePeakosTodoInfrastructure,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('todo pool.query/pool.connect가 필요합니다.');
  }
  if (typeof ensureInfrastructure !== 'function' || typeof randomUUID !== 'function') {
    throw new TypeError('todo dependencies가 올바르지 않습니다.');
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

  async function list(req, dateValue, { carryOver = false } = {}) {
    const access = todoAccess(req, { action: 'read' });
    const date = normalizeDate(dateValue);
    await ready();
    // carryOver: 지난 날짜의 미완료 할 일도 함께 내려준다. 저장된 날짜는 그대로
    // 두고 목록에만 합쳐, 어느 날 일인지 화면에서 구분할 수 있게 한다.
    const result = await pool.query(
      carryOver
        ? `SELECT ${TODO_COLUMNS}
             FROM peakos_todos
            WHERE workspace_id = $1
              AND owner_uid = $2
              AND archived = FALSE
              AND (todo_date = $3::date OR (todo_date < $3::date AND done = FALSE))
            ORDER BY todo_date, sort_order, created_at, id`
        : `SELECT ${TODO_COLUMNS}
             FROM peakos_todos
            WHERE workspace_id = $1
              AND owner_uid = $2
              AND todo_date = $3::date
              AND archived = FALSE
            ORDER BY sort_order, created_at, id`,
      [access.workspaceId, access.uid, date],
    );
    const items = Object.freeze(result.rows.map(mapTodo));
    return Object.freeze({
      date,
      timeZone: 'Asia/Seoul',
      readOnly: !access.writable,
      capabilities: Object.freeze({
        create: access.writable,
        edit: access.writable,
        reorder: access.writable,
        archive: access.writable,
      }),
      items,
    });
  }

  async function create(req, rawBody) {
    const access = todoAccess(req, { action: 'write' });
    const body = normalizeCreateBody(rawBody);
    await ready();
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO peakos_todos
         (workspace_id, id, owner_uid, owner_name_snapshot, title, todo_date,
          start_time, end_time, category, memo, done, sort_order,
          last_action, last_changed_by_uid, last_changed_by_name_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::time,$8::time,$9,$10,$11,$12,
               'CREATE',$3,$4)
       RETURNING ${TODO_COLUMNS}`,
      [
        access.workspaceId, id, access.uid, access.name, body.title, body.date,
        body.startTime, body.endTime, body.category, body.memo, body.done, body.sortOrder,
      ],
    );
    return mapTodo(result.rows[0]);
  }

  async function patch(req, idValue, rawBody) {
    const access = todoAccess(req, { action: 'write' });
    const id = normalizeId(idValue);
    const body = normalizePatchBody(rawBody);
    await ready();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT ${TODO_COLUMNS}
           FROM peakos_todos
          WHERE workspace_id = $1 AND id = $2 AND owner_uid = $3 AND archived = FALSE
          FOR UPDATE`,
        [access.workspaceId, id, access.uid],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (Number(current.version) !== body.expectedVersion) throw versionConflict();
      const times = currentTimes(current);
      const next = {
        title: body.title === undefined ? current.title : body.title,
        date: body.date === undefined ? serializeDate(current.todo_date) : body.date,
        startTime: body.startTime === undefined ? times.startTime : body.startTime,
        endTime: body.endTime === undefined ? times.endTime : body.endTime,
        category: body.category === undefined ? current.category : body.category,
        memo: body.memo === undefined ? current.memo : body.memo,
        done: body.done === undefined ? current.done : body.done,
        sortOrder: body.sortOrder === undefined ? Number(current.sort_order) : body.sortOrder,
      };
      validateTimeRange(next.startTime, next.endTime);
      const updated = await client.query(
        `UPDATE peakos_todos
            SET title = $4, todo_date = $5::date, start_time = $6::time,
                end_time = $7::time, category = $8, memo = $9, done = $10,
                sort_order = $11, version = version + 1, last_action = 'UPDATE',
                last_changed_by_uid = $3, last_changed_by_name_snapshot = $12,
                updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND owner_uid = $3
            AND archived = FALSE AND version = $13
          RETURNING ${TODO_COLUMNS}`,
        [
          access.workspaceId, id, access.uid, next.title, next.date,
          next.startTime, next.endTime, next.category, next.memo, next.done,
          next.sortOrder, access.name, body.expectedVersion,
        ],
      );
      if (!updated.rows[0]) throw versionConflict();
      await client.query('COMMIT');
      return mapTodo(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function reorder(req, rawBody) {
    const access = todoAccess(req, { action: 'write' });
    const items = normalizeReorderBody(rawBody);
    await ready();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = items.map(item => item.id);
      const locked = await client.query(
        `SELECT ${TODO_COLUMNS}
           FROM peakos_todos
          WHERE workspace_id = $1 AND owner_uid = $2
            AND id = ANY($3::uuid[]) AND archived = FALSE
          ORDER BY id
          FOR UPDATE`,
        [access.workspaceId, access.uid, ids],
      );
      if (locked.rows.length !== items.length) throw notFound();
      const byId = new Map(locked.rows.map(row => [String(row.id), row]));
      if (items.some(item => Number(byId.get(item.id)?.version) !== item.expectedVersion)) {
        throw versionConflict();
      }
      const todos = [];
      for (const item of items) {
        const updated = await client.query(
          `UPDATE peakos_todos
              SET sort_order = $4, version = version + 1, last_action = 'REORDER',
                  last_changed_by_uid = $3, last_changed_by_name_snapshot = $5,
                  updated_at = NOW()
            WHERE workspace_id = $1 AND id = $2 AND owner_uid = $3
              AND archived = FALSE AND version = $6
            RETURNING ${TODO_COLUMNS}`,
          [
            access.workspaceId, item.id, access.uid, item.sortOrder,
            access.name, item.expectedVersion,
          ],
        );
        if (!updated.rows[0]) throw versionConflict();
        todos.push(mapTodo(updated.rows[0]));
      }
      await client.query('COMMIT');
      return Object.freeze(todos);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function archive(req, idValue, rawBody) {
    const access = todoAccess(req, { action: 'write' });
    const id = normalizeId(idValue);
    const body = normalizeDeleteBody(rawBody);
    await ready();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT version FROM peakos_todos
          WHERE workspace_id = $1 AND id = $2 AND owner_uid = $3 AND archived = FALSE
          FOR UPDATE`,
        [access.workspaceId, id, access.uid],
      );
      if (!locked.rows[0]) throw notFound();
      if (Number(locked.rows[0].version) !== body.expectedVersion) throw versionConflict();
      const updated = await client.query(
        `UPDATE peakos_todos
            SET archived = TRUE, archived_at = NOW(), version = version + 1,
                last_action = 'ARCHIVE', last_changed_by_uid = $3,
                last_changed_by_name_snapshot = $4, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND owner_uid = $3
            AND archived = FALSE AND version = $5
          RETURNING id, version`,
        [access.workspaceId, id, access.uid, access.name, body.expectedVersion],
      );
      if (!updated.rows[0]) throw versionConflict();
      await client.query('COMMIT');
      return Object.freeze({ deleted: String(updated.rows[0].id), version: Number(updated.rows[0].version) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ archive, create, list, patch, ready, reorder });
}

function registerPeakosTodoRoutes({
  app,
  pool,
  readMiddlewares = [],
  writeMiddlewares = [],
  ensureInfrastructure = ensurePeakosTodoInfrastructure,
  randomUUID,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('todo app이 필요합니다.');
  const service = createPeakosTodoService({ pool, ensureInfrastructure, randomUUID });

  function markPrivate(_req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    res.vary('X-PeakOS-Workspace');
    res.vary('Authorization');
    next();
  }

  app.get(TODO_BASE_PATH, ...readMiddlewares, markPrivate, async (req, res) => {
    try {
      return res.json(await service.list(req, req.query?.date, {
        carryOver: String(req.query?.carryOver || '') === '1',
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.post(TODO_BASE_PATH, ...writeMiddlewares, markPrivate, async (req, res) => {
    try {
      return res.status(201).json({ item: await service.create(req, req.body) });
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.post(`${TODO_BASE_PATH}/reorder`, ...writeMiddlewares, markPrivate, async (req, res) => {
    try {
      return res.json({ items: await service.reorder(req, req.body) });
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.patch(`${TODO_BASE_PATH}/:id`, ...writeMiddlewares, markPrivate, async (req, res) => {
    try {
      return res.json({ item: await service.patch(req, req.params.id, req.body) });
    } catch (error) {
      return sendError(res, error);
    }
  });
  app.delete(`${TODO_BASE_PATH}/:id`, ...writeMiddlewares, markPrivate, async (req, res) => {
    try {
      return res.json(await service.archive(req, req.params.id, req.body));
    } catch (error) {
      return sendError(res, error);
    }
  });
  return service;
}

module.exports = {
  TODO_BASE_PATH,
  TODO_COLUMNS,
  createPeakosTodoService,
  mapTodo,
  registerPeakosTodoRoutes,
  sendError,
};
