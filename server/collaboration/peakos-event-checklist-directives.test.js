'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS,
  DIRECTIVE_REQUIRED_CONSTRAINTS,
  DIRECTIVE_REQUIRED_INDEXES,
  DIRECTIVE_REQUIRED_TRIGGERS,
  DIRECTIVE_SCHEMA_READINESS_SQL,
  DIRECTIVE_TABLE_PRIVILEGES,
  DIRECTIVE_TRIGGER_FUNCTION_SOURCES,
  MIGRATION_PATH,
  createPeakosEventChecklistDirectiveHandlers,
  ensurePeakosEventChecklistDirectiveInfrastructure,
  listEligibleInstructors,
  listInstructionInbox,
  assertInstructorCanReceiveEvent,
  registerPeakosEventChecklistDirectiveRoutes,
  resolveCanonicalInstructor,
} = require('./peakos-event-checklist-directives');

const EVENT_ID = 'event-1';
const ITEM_ID = 'item-1';

function request({
  uid = 'owner-uid',
  role = 'member',
  workspaceRole = 'member',
  body = {},
  params = {},
  query = {},
  externalCalendarOnly = false,
  chatOnly = false,
} = {}) {
  return {
    uid,
    userName: '클라이언트 이름',
    userDoc: {
      uid,
      name: '인증된 이름',
      approved: true,
      is_active: true,
      role,
      external_calendar_only: externalCalendarOnly,
      chat_only: chatOnly,
    },
    workspace: { id: 'ws_peak', slug: 'peak', role: workspaceRole },
    body,
    params,
    query,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function mutationPool({
  eventOwner = 'owner-uid',
  projectId = null,
  directiveFailure = false,
  eligibleInstructor = true,
  instructorExternal = false,
  instructorChatOnly = false,
  eventInternalRule = false,
  seeded = false,
  timeline = [],
} = {}) {
  const state = {
    inserted: seeded,
    directive: seeded ? {
      instructor_uid: 'instructor-uid',
      instructor_name_snapshot: '서버 지시자',
      directive_version: 1,
    } : null,
    item: seeded ? {
      id: ITEM_ID,
      event_id: EVENT_ID,
      title: '기존 지시',
      sort_order: 0,
      done: false,
      created_at: '2026-08-17T00:00:00.000Z',
    } : null,
    calls: [],
  };
  const event = {
    id: EVENT_ID,
    workspace_id: 'ws_peak',
    owner_id: eventOwner,
    owner_name: '일정 소유자',
    title: '영업 후속',
    date: '2026-08-17',
    time: '17:30',
    end_time: '19:00',
    deleted: false,
    project_id: projectId,
    is_internal_rule: eventInternalRule,
  };

  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      state.calls.push({ sql: text, values });
      if (text === 'BEGIN') { timeline.push('BEGIN'); return { rows: [] }; }
      if (text === 'COMMIT') { timeline.push('COMMIT'); return { rows: [] }; }
      if (text === 'ROLLBACK') {
        timeline.push('ROLLBACK');
        state.inserted = false;
        state.directive = null;
        state.item = null;
        return { rows: [] };
      }
      if (/SELECT event_row\.\*/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [event] };
      }
      if (/FROM peakos_workspace_memberships membership/.test(text) && /LIMIT 1/.test(text)) {
        const uid = String(values[1]);
        if (uid === 'owner-uid') {
          return { rows: [{
            uid, name: '서버 소유자', workspace_slug: 'peak',
            external_calendar_only: false, chat_only: false, user_role: 'member',
          }] };
        }
        if (uid === 'admin-uid') {
          return { rows: [{
            uid, name: '서버 관리자', workspace_slug: 'peak',
            external_calendar_only: false, chat_only: false, user_role: 'admin',
          }] };
        }
        if (uid === 'instructor-uid' && eligibleInstructor) {
          return { rows: [{
            uid, name: '서버 지시자', workspace_slug: 'peak',
            external_calendar_only: instructorExternal,
            chat_only: instructorChatOnly,
            user_role: 'member',
          }] };
        }
        return { rows: [] };
      }
      if (/COALESCE\(MAX\(sort_order\)/.test(text)) return { rows: [{ next: 0 }] };
      if (/INSERT INTO event_checklist/.test(text)) {
        state.inserted = true;
        state.item = {
          id: ITEM_ID,
          event_id: EVENT_ID,
          title: values[1],
          sort_order: values[2],
          done: false,
          created_at: '2026-08-17T00:00:00.000Z',
        };
        return { rows: [state.item] };
      }
      if (/INSERT INTO peakos_event_checklist_directives/.test(text)) {
        if (directiveFailure) throw Object.assign(new Error('directive failed'), { code: '23503' });
        state.directive = {
          instructor_uid: values[3],
          instructor_name_snapshot: values[4],
          directive_version: 1,
        };
        return { rows: [] };
      }
      if (/FOR UPDATE OF checklist/.test(text)) {
        return { rows: state.inserted ? [{ ...state.item, ...state.directive }] : [] };
      }
      if (/UPDATE event_checklist\s+SET title = CASE/.test(text)) {
        if (values[2]) state.item.title = values[3];
        if (values[4]) state.item.done = values[5];
        return { rows: [] };
      }
      if (/DELETE FROM peakos_event_checklist_directives/.test(text)) {
        state.directive = null;
        return { rows: [] };
      }
      if (/DELETE FROM event_checklist/.test(text)) {
        state.inserted = false;
        state.item = null;
        state.directive = null;
        return { rows: [] };
      }
      if (/WITH ranked AS/.test(text)) return { rows: [] };
      if (/COUNT\(\*\) AS total/.test(text) && /FROM event_checklist/.test(text)) {
        return { rows: [{
          total: state.inserted ? '1' : '0',
          completed: state.inserted && state.item.done ? '1' : '0',
        }] };
      }
      if (/UPDATE events/.test(text) && /RETURNING \*/.test(text)) {
        return { rows: [{
          ...event,
          done: values[1] === true,
          kanban_status: values[2],
        }] };
      }
      if (/FROM event_checklist checklist/.test(text)
          && /LEFT JOIN peakos_event_checklist_directives/.test(text)
          && !/FOR UPDATE OF checklist/.test(text)) {
        return { rows: state.inserted ? [{ ...state.item, ...state.directive }] : [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() { timeline.push('RELEASE'); },
  };
  return {
    state,
    pool: {
      query: (...args) => client.query(...args),
      connect: async () => client,
    },
  };
}

function handlers(pool, notifyUser = async () => {}) {
  return createPeakosEventChecklistDirectiveHandlers({
    pool,
    workspaceIdForRequest: req => req.workspace.id,
    eventHiddenPredicate: () => '',
    canAccessEvent: async () => true,
    notifyUser,
  });
}

test('migration is additive, typed for the live text keys, and never creates an event share', () => {
  const source = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(source, /event_id TEXT NOT NULL/);
  assert.match(source, /checklist_item_id TEXT NOT NULL/);
  assert.match(source, /REFERENCES events\(id\)[\s\S]*ON UPDATE RESTRICT ON DELETE CASCADE/);
  assert.match(source, /REFERENCES event_checklist\(id\)[\s\S]*ON UPDATE RESTRICT ON DELETE CASCADE/);
  assert.match(source, /peakos_event_checklist_directive_assert_parent/);
  assert.match(source, /peakos_events_checklist_directive_workspace_guard/);
  assert.match(source, /peakos_event_checklist_directive_event_guard/);
  assert.match(source, /event_row\.project_id IS NOT NULL/);
  assert.match(source, /NEW\.project_id IS NOT NULL/);
  assert.match(source, /BEFORE UPDATE OF workspace_id, project_id ON events/);
  assert.match(source, /FROM public\.events event_row[\s\S]*FOR UPDATE OF event_row, checklist_row/);
  assert.match(source, /SECURITY INVOKER[\s\S]*SET search_path = pg_catalog, public/);
  assert.match(source, /REVOKE ALL PRIVILEGES ON TABLE public\.peakos_event_checklist_directives FROM PUBLIC, %I/);
  assert.match(source, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.peakos_event_checklist_directives TO %I/);
  assert.match(source, /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I/);
  assert.match(source, /'TRUNCATE', 'REFERENCES', 'TRIGGER'/);
  assert.match(source, /has_table_privilege\([\s\S]*privilege_name/);
  assert.match(source, /has_function_privilege\(application_role, function_signature, 'EXECUTE'\)/);
  assert.doesNotMatch(source, /application_role\s*:=\s*current_user/);
  assert.doesNotMatch(source, /GRANT\s+EXECUTE/i);
  assert.doesNotMatch(source, /event_shares/i);
  assert.doesNotMatch(source, /ALTER\s+TABLE\s+(?:events|event_checklist)\b/i);
});

test('readiness is SELECT-only and fails closed on exact schema invariants', async () => {
  let sql = '';
  const notReady = {
    query: async statement => {
      sql = statement;
      return { rows: [{ ready: false, missing_requirements: ['constraint:item_fk'] }] };
    },
  };
  await assert.rejects(
    () => ensurePeakosEventChecklistDirectiveInfrastructure(notReady),
    error => error.statusCode === 503
      && error.code === 'PEAKOS_CHECKLIST_DIRECTIVE_SCHEMA_NOT_READY'
      && /20260817_peakos_event_checklist_directives\.sql/.test(error.message),
  );
  assert.equal(sql, DIRECTIVE_SCHEMA_READINESS_SQL);
  assert.match(sql, /format_type\(actual\.atttypid, actual\.atttypmod\)/);
  assert.match(sql, /actual\.atthasdef <> expected\.has_default/);
  assert.match(sql, /pg_get_expr\(column_default\.adbin, column_default\.adrelid\)/);
  assert.match(sql, /pg_get_constraintdef\(actual\.oid\)/);
  assert.match(sql, /actual\.convalidated IS NOT TRUE/);
  assert.match(sql, /actual\.prorettype <> 'trigger'::regtype/);
  assert.match(sql, /actual\.prokind <> 'f'/);
  assert.match(sql, /actual\.provolatile <> 'v'/);
  assert.match(sql, /actual\.prosecdef IS NOT FALSE/);
  assert.match(sql, /actual\.proconfig IS DISTINCT FROM ARRAY\['search_path=pg_catalog, public'\]::text\[\]/);
  assert.match(sql, /actual\.tgenabled <> 'O'/);
  assert.match(sql, /actual\.tgtype::integer <> expected\.trigger_type/);
  assert.match(sql, /actual\.tgqual IS NOT NULL/);
  assert.match(sql, /pg_get_triggerdef\(actual\.oid\)/);
  assert.match(sql, /actual\.indisvalid IS NOT TRUE/);
  assert.match(sql, /actual\.indnkeyatts <> cardinality/);
  assert.match(sql, /has_table_privilege/);
  assert.match(sql, /has_function_privilege/);
  assert.match(sql, /aclexplode/);
  assert.match(sql, /SELECT current_user AS role_name/);
  assert.doesNotMatch(sql, /current_setting\('peakos\.app_role'/);
  assert.doesNotMatch(
    sql,
    /(?:^|;\s*)(?:CREATE\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|GRANT\s+)/im,
  );

  assert.deepEqual(DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS.version, ['integer', true, '1']);
  assert.deepEqual(DIRECTIVE_REQUIRED_COLUMN_DEFINITIONS.created_at, [
    'timestamp with time zone', true, 'now()',
  ]);
  assert.equal(DIRECTIVE_REQUIRED_CONSTRAINTS.length, 13);
  assert.equal(DIRECTIVE_REQUIRED_CONSTRAINTS.filter(([, kind]) => kind === 'c').length, 7);
  assert.deepEqual(DIRECTIVE_REQUIRED_INDEXES.map(([name]) => name), [
    'peakos_event_checklist_directives_inbox_idx',
    'peakos_event_checklist_directives_event_idx',
  ]);
  assert.deepEqual(DIRECTIVE_REQUIRED_TRIGGERS.map(([, name]) => name), [
    'peakos_event_checklist_directives_parent_guard',
    'peakos_event_checklist_directives_touch_updated_at',
    'peakos_events_checklist_directive_workspace_guard',
    'peakos_event_checklist_directive_event_guard',
  ]);
  assert.match(
    DIRECTIVE_TRIGGER_FUNCTION_SOURCES.peakos_event_checklist_directive_assert_parent,
    /FROM public\.events event_row[\s\S]*FOR UPDATE OF event_row, checklist_row/,
  );
  assert.deepEqual(DIRECTIVE_TABLE_PRIVILEGES, {
    SELECT: true,
    INSERT: true,
    UPDATE: true,
    DELETE: true,
    TRUNCATE: false,
    REFERENCES: false,
    TRIGGER: false,
  });

  assert.equal(await ensurePeakosEventChecklistDirectiveInfrastructure({
    query: async () => ({ rows: [{ ready: true, missing_requirements: [] }] }),
  }), true);
});

test('candidate resolution is same-workspace, approved, active, and non-oversight', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ uid: 'canonical-uid', name: '서버 이름', workspace_slug: 'peak' }] };
    },
  };
  const instructor = await resolveCanonicalInstructor(db, 'ws_peak', 'canonical-uid');
  assert.deepEqual(instructor, {
    uid: 'canonical-uid', name: '서버 이름', workspaceSlug: 'peak',
    externalCalendarOnly: false, chatOnly: false, role: '',
  });
  assert.deepEqual(calls[0].values, ['ws_peak', 'canonical-uid']);
  assert.match(calls[0].sql, /membership\.workspace_id = \$1/);
  assert.match(calls[0].sql, /membership\.active = TRUE/);
  assert.match(calls[0].sql, /membership\.role <> 'oversight'/);
  assert.match(calls[0].sql, /user_row\.approved = TRUE/);
  assert.match(calls[0].sql, /COALESCE\(user_row\.is_active, TRUE\) = TRUE/);

  const listCalls = [];
  await listEligibleInstructors({
    query: async (sql, values) => { listCalls.push({ sql, values }); return { rows: [] }; },
  }, 'ws_daegu');
  assert.deepEqual(listCalls[0].values, ['ws_daegu', false, '']);
  assert.match(listCalls[0].sql, /membership\.workspace_id = \$1/);
  assert.match(listCalls[0].sql, /user_row\.uid = \$3 OR user_row\.role = 'admin'/);
});

test('restricted instructor directory exposes only the caller and admins', async () => {
  let captured;
  await listEligibleInstructors({
    query: async (sql, values) => { captured = { sql, values }; return { rows: [] }; },
  }, 'ws_peak', { callerUid: 'external-uid', restrictedDirectory: true });
  assert.deepEqual(captured.values, ['ws_peak', true, 'external-uid']);
  assert.match(captured.sql, /\$2::boolean = FALSE OR user_row\.uid = \$3 OR user_row\.role = 'admin'/);
  assert.match(captured.sql, /membership\.active = TRUE/);
  assert.match(captured.sql, /membership\.role <> 'oversight'/);
  assert.match(captured.sql, /membership\.permissions ->> 'calendar'.*IN \('read', 'write'\)/);
  assert.match(captured.sql, /user_row\.chat_only/);
  assert.match(captured.sql, /user_row\.external_calendar_only/);
});

test('instruction inbox returns only the selected item and minimal parent event data', async () => {
  let captured;
  const rows = [{
    checklist_item_id: ITEM_ID,
    checklist_title: '고객 후속 전화',
    checklist_done: false,
    checklist_sort_order: 2,
    directive_version: 3,
    directive_updated_at: '2026-08-17T01:00:00.000Z',
    recorded_by_uid: 'owner-uid',
    recorded_by_name_snapshot: '지시자',
    event_id: EVENT_ID,
    event_title: '영업 일정',
    event_date: '2026-08-17',
    event_time: '17:30',
    event_end_time: '19:00',
    event_owner_uid: 'owner-uid',
    event_owner_name: '일정 소유자',
  }];
  const instructions = await listInstructionInbox({
    query: async (sql, values) => { captured = { sql, values }; return { rows }; },
  }, {
    req: { uid: 'instructor-uid' },
    selectedWorkspaceId: 'ws_peak',
    peakWorkspaceId: 'ws_peak',
    from: '2026-08-17',
    to: '2026-08-17',
    eventHiddenPredicate: () => ' AND NOT EXISTS (SELECT 1 FROM hidden_fixture)',
  });

  assert.deepEqual(captured.values, [
    'ws_peak', 'instructor-uid', '2026-08-17', '2026-08-17', 'ws_peak',
  ]);
  assert.match(captured.sql, /directive\.instructor_uid = \$2/);
  assert.match(captured.sql, /current_membership\.active = TRUE/);
  assert.match(captured.sql, /current_membership\.permissions ->> 'calendar'.*IN \('read', 'write'\)/);
  assert.match(captured.sql, /current_workspace\.active = TRUE/);
  assert.match(captured.sql, /current_user\.chat_only/);
  assert.match(captured.sql, /event_row\.project_id IS NULL/);
  assert.match(captured.sql, /hidden_fixture/);
  assert.doesNotMatch(captured.sql, /\bmemo\b|event_shares|\bscope\b/i);
  assert.equal(instructions.length, 1);
  assert.deepEqual(Object.keys(instructions[0].event).sort(), ['date', 'endTime', 'id', 'owner', 'time', 'title']);
  assert.equal(instructions[0].title, '고객 후속 전화');
  assert.deepEqual(instructions[0].capabilities, { toggle: false, edit: false, delete: false });
  assert.equal(JSON.stringify(instructions).includes('memo'), false);
});

test('project-linked events never enter the personal directive inbox', async () => {
  let capturedSql = '';
  const instructions = await listInstructionInbox({
    query: async sql => { capturedSql = String(sql); return { rows: [] }; },
  }, {
    req: { uid: 'instructor-uid' },
    selectedWorkspaceId: 'ws_peak',
    peakWorkspaceId: 'ws_peak',
    from: '2026-08-17',
    to: '2026-08-17',
    eventHiddenPredicate: () => '',
  });

  assert.deepEqual(instructions, []);
  assert.match(capturedSql, /event_row\.project_id IS NULL/);
});

test('external-calendar inbox excludes every canonical internal-report rule', async () => {
  let capturedSql = '';
  await listInstructionInbox({
    query: async sql => { capturedSql = String(sql); return { rows: [] }; },
  }, {
    req: { uid: 'external-uid', userDoc: { external_calendar_only: true } },
    selectedWorkspaceId: 'ws_peak',
    peakWorkspaceId: 'ws_peak',
    from: '2026-08-17',
    to: '2026-08-17',
    eventHiddenPredicate: () => '',
  });
  assert.match(capturedSql, /AND NOT \(COALESCE\(event_row\.todo_cat, ''\) = '보고서'/);
  assert.match(capturedSql, /event_row\.title, ''\) LIKE '%보고서 작성%'/);
  assert.match(capturedSql, /event_row\.title, ''\) LIKE '%보고서 확인%'/);
  assert.match(capturedSql, /event_row\.title, ''\) LIKE '%업무보고 작성%'/);
});

test('external-calendar owners cannot mutate internal-report checklists', async () => {
  const database = mutationPool({ eventInternalRule: true });
  const delivered = [];
  const routeHandlers = handlers(database.pool, async (...args) => delivered.push(args));
  const res = response();
  await routeHandlers.createChecklist(request({
    externalCalendarOnly: true,
    body: { title: '내부 보고 확인', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, 'PEAKOS_CHECKLIST_EVENT_NOT_FOUND');
  assert.equal(database.state.inserted, false);
  assert.equal(delivered.length, 0);
});

test('internal-report directives reject external-calendar instructors before persistence or push', async () => {
  const database = mutationPool({ eventInternalRule: true, instructorExternal: true });
  const delivered = [];
  const routeHandlers = handlers(database.pool, async (...args) => delivered.push(args));
  const res = response();
  await routeHandlers.createChecklist(request({
    body: { title: '내부 보고 확인', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'PEAKOS_CHECKLIST_INSTRUCTOR_EVENT_FORBIDDEN');
  assert.equal(database.state.inserted, false);
  assert.equal(delivered.length, 0);
});

test('pure chat-only users cannot be selected or retained as checklist instructors', async () => {
  assert.throws(
    () => assertInstructorCanReceiveEvent(
      { is_internal_rule: false },
      { uid: 'chat-uid', chatOnly: true, externalCalendarOnly: false },
    ),
    error => error?.statusCode === 400
      && error?.code === 'PEAKOS_CHECKLIST_INSTRUCTOR_EVENT_FORBIDDEN',
  );
  const database = mutationPool({ instructorChatOnly: true });
  const delivered = [];
  const res = response();
  await handlers(database.pool, async (...args) => delivered.push(args)).createChecklist(request({
    body: { title: '채팅 계정에게 노출 금지', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'PEAKOS_CHECKLIST_INSTRUCTOR_EVENT_FORBIDDEN');
  assert.equal(database.state.inserted, false);
  assert.equal(delivered.length, 0);
});

test('project-linked events reject a personal checklist instructor before writing', async () => {
  const database = mutationPool({ projectId: 'project-1' });
  const routeHandlers = handlers(database.pool);
  const res = response();
  await routeHandlers.createChecklist(request({
    body: { title: '전화 후속', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'PEAKOS_CHECKLIST_PROJECT_DIRECTIVE_FORBIDDEN');
  assert.equal(database.state.inserted, false);
  assert.equal(database.state.directive, null);
});

test('owner create is atomic, stores the canonical instructor, and notifies only after commit', async () => {
  const timeline = [];
  const database = mutationPool({ timeline });
  const delivered = [];
  const routeHandlers = handlers(database.pool, async (uid, title, body, data) => {
    timeline.push('NOTIFY');
    delivered.push({ uid, title, body, data });
  });
  const req = request({
    body: { title: '전화 후속', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  });
  const res = response();
  await routeHandlers.createChecklist(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.item.instructor.uid, 'instructor-uid');
  assert.equal(res.payload.item.instructor.name, '서버 지시자');
  assert.equal(database.state.directive.instructor_name_snapshot, '서버 지시자');
  assert.deepEqual(delivered.map(item => item.uid), ['instructor-uid']);
  assert.equal(delivered[0].title, '📌 지시사항 등록 알림');
  assert.match(delivered[0].body, /담당 일정 소유자: 전화 후속 · 지시사항이 등록되었습니다/);
  assert.ok(timeline.indexOf('COMMIT') < timeline.indexOf('NOTIFY'));
  assert.equal(database.state.calls.some(call => /event_shares/i.test(call.sql)), false);
});

test('owner can atomically retitle, complete, and re-resolve an instructor', async () => {
  const timeline = [];
  const database = mutationPool({ seeded: true, timeline });
  const delivered = [];
  const routeHandlers = handlers(database.pool, async uid => {
    timeline.push('NOTIFY');
    delivered.push(uid);
  });
  const res = response();
  await routeHandlers.updateChecklist(request({
    body: {
      title: '수정된 지시',
      done: true,
      instructorUid: 'instructor-uid',
    },
    params: { eventId: EVENT_ID, itemId: ITEM_ID },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.item.title, '수정된 지시');
  assert.equal(res.payload.item.done, true);
  assert.deepEqual(res.payload.item.instructor, {
    uid: 'instructor-uid', name: '서버 지시자',
  });
  assert.equal(res.payload.event.done, true);
  assert.deepEqual(delivered, ['instructor-uid']);
  assert.ok(timeline.indexOf('COMMIT') < timeline.indexOf('NOTIFY'));
});

test('owner can delete an instructed item atomically and the former instructor is notified after commit', async () => {
  const timeline = [];
  const database = mutationPool({ seeded: true, timeline });
  const delivered = [];
  const routeHandlers = handlers(database.pool, async uid => {
    timeline.push('NOTIFY');
    delivered.push(uid);
  });
  const res = response();
  await routeHandlers.deleteChecklist(request({
    params: { eventId: EVENT_ID, itemId: ITEM_ID },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(database.state.inserted, false);
  assert.equal(database.state.directive, null);
  assert.deepEqual(delivered, ['instructor-uid']);
  assert.ok(timeline.indexOf('COMMIT') < timeline.indexOf('NOTIFY'));
});

test('revoked workspace instructors never receive update or delete notifications', async () => {
  for (const action of ['update', 'delete']) {
    const database = mutationPool({ seeded: true, eligibleInstructor: false });
    const delivered = [];
    const routeHandlers = handlers(database.pool, async (...args) => delivered.push(args));
    const res = response();
    if (action === 'update') {
      await routeHandlers.updateChecklist(request({
        body: { done: true },
        params: { eventId: EVENT_ID, itemId: ITEM_ID },
      }), res);
    } else {
      await routeHandlers.deleteChecklist(request({
        params: { eventId: EVENT_ID, itemId: ITEM_ID },
      }), res);
    }
    assert.equal(res.statusCode, 200, action);
    assert.equal(delivered.length, 0, action);
  }
});

test('a directive insert failure rolls back the checklist row and emits no notification', async () => {
  const timeline = [];
  const database = mutationPool({ directiveFailure: true, timeline });
  let notifications = 0;
  const routeHandlers = handlers(database.pool, async () => { notifications += 1; });
  const res = response();
  await routeHandlers.createChecklist(request({
    body: { title: '전화 후속', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(database.state.inserted, false);
  assert.equal(notifications, 0);
  assert.deepEqual(timeline.filter(value => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(value)), [
    'BEGIN', 'ROLLBACK',
  ]);
});

test('cross-workspace instructors fail before insert and selected/shared/team viewers cannot mutate', async () => {
  const crossWorkspace = mutationPool({ eligibleInstructor: false });
  const crossRes = response();
  await handlers(crossWorkspace.pool).createChecklist(request({
    body: { title: '전화 후속', instructorUid: 'instructor-uid' },
    params: { id: EVENT_ID },
  }), crossRes);
  assert.equal(crossRes.statusCode, 400);
  assert.equal(crossRes.payload.code, 'PEAKOS_CHECKLIST_INSTRUCTOR_INVALID');
  assert.equal(crossWorkspace.state.inserted, false);

  for (const actor of [
    { uid: 'instructor-uid', role: 'member' },
    { uid: 'shared-viewer', role: 'member' },
    { uid: 'team-manager', role: 'manager' },
  ]) {
    const database = mutationPool({ eventOwner: 'owner-uid' });
    const res = response();
    await handlers(database.pool).createChecklist(request({
      ...actor,
      body: { title: '권한 없는 추가' },
      params: { id: EVENT_ID },
    }), res);
    assert.equal(res.statusCode, 403, actor.uid);
    assert.equal(res.payload.code, 'PEAKOS_CHECKLIST_MUTATION_FORBIDDEN');
    assert.equal(database.state.inserted, false);
  }
});

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

test('non-OS title-only checklist requests pass through to the existing Paragon handler', async () => {
  const app = express();
  app.use(express.json());
  const noDbPool = {
    query: async () => { throw new Error('OS database handler must not run'); },
    connect: async () => { throw new Error('OS transaction must not run'); },
  };
  registerPeakosEventChecklistDirectiveRoutes({
    app,
    pool: noDbPool,
    workspaceIdForRequest: () => 'ws_peak',
    eventHiddenPredicate: () => '',
    canAccessEvent: async () => false,
    notifyUser: async () => {},
    isOsRequest: () => false,
  });
  app.post('/api/events/:id/checklist', (req, res) => {
    res.json({ legacy: true, title: req.body.title });
  });
  const server = await listen(app);
  try {
    const address = server.address();
    const result = await fetch(`http://127.0.0.1:${address.port}/api/events/${EVENT_ID}/checklist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '기존 파라곤 체크리스트' }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      legacy: true,
      title: '기존 파라곤 체크리스트',
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const directivePostgresUrl = process.env.PEAKOS_DIRECTIVE_TEST_DATABASE_URL || '';

test('disposable PostgreSQL validates idempotency, tamper detection, ACLs, and parent races', {
  skip: !directivePostgresUrl,
  timeout: 45_000,
}, async t => {
  const { Client } = require('pg');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const admin = new Client({ connectionString: directivePostgresUrl });
  await admin.connect();
  t.after(async () => admin.end());

  await admin.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
        CREATE ROLE calendar_user LOGIN;
      END IF;
    END
    $role$;
    CREATE TABLE peakos_workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE peakos_workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES peakos_workspaces(id),
      user_uid TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_uid)
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      project_id TEXT
    );
    CREATE TABLE event_checklist (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      title TEXT,
      sort_order INTEGER,
      done BOOLEAN,
      created_at TIMESTAMPTZ
    );
  `);
  await admin.query(migration);
  await admin.query(migration);
  await admin.query(`
    GRANT SELECT, UPDATE ON TABLE events, event_checklist TO calendar_user;
    INSERT INTO peakos_workspaces(id) VALUES ('ws_peak');
    INSERT INTO peakos_workspace_memberships(workspace_id, user_uid)
      VALUES ('ws_peak', 'instructor-uid'), ('ws_peak', 'owner-uid');
    INSERT INTO events(id, workspace_id, project_id)
      VALUES ('event-a', 'ws_peak', NULL), ('event-b', 'ws_peak', NULL);
    INSERT INTO event_checklist(id, event_id, title, sort_order, done, created_at)
      VALUES ('item-a', 'event-a', 'race item', 0, FALSE, NOW());
  `);

  async function readiness() {
    await admin.query('SET ROLE calendar_user');
    try {
      return (await admin.query(DIRECTIVE_SCHEMA_READINESS_SQL)).rows[0];
    } finally {
      await admin.query('RESET ROLE');
    }
  }

  function assertMissing(row, prefix) {
    assert.equal(row.ready, false);
    assert.ok(row.missing_requirements.some(value => String(value).startsWith(prefix)),
      `${prefix}: ${JSON.stringify(row.missing_requirements)}`);
  }

  assert.deepEqual(await readiness(), { ready: true, missing_requirements: [] });

  await admin.query('ALTER TABLE peakos_event_checklist_directives ALTER COLUMN version SET DEFAULT 2');
  assertMissing(await readiness(), 'column-definition:peakos_event_checklist_directives.version');
  await admin.query('ALTER TABLE peakos_event_checklist_directives ALTER COLUMN version SET DEFAULT 1');

  await admin.query(`
    ALTER TABLE peakos_event_checklist_directives
      DROP CONSTRAINT peakos_event_checklist_directives_version_check;
    ALTER TABLE peakos_event_checklist_directives
      ADD CONSTRAINT peakos_event_checklist_directives_version_check CHECK (version >= 0);
  `);
  assertMissing(await readiness(), 'constraint-definition:peakos_event_checklist_directives.peakos_event_checklist_directives_version_check');
  await admin.query(`
    ALTER TABLE peakos_event_checklist_directives
      DROP CONSTRAINT peakos_event_checklist_directives_version_check;
    ALTER TABLE peakos_event_checklist_directives
      ADD CONSTRAINT peakos_event_checklist_directives_version_check CHECK (version >= 1) NOT VALID;
  `);
  assertMissing(await readiness(), 'constraint-definition:peakos_event_checklist_directives.peakos_event_checklist_directives_version_check');
  await admin.query(`ALTER TABLE peakos_event_checklist_directives
    VALIDATE CONSTRAINT peakos_event_checklist_directives_version_check`);

  await admin.query(`
    DROP INDEX peakos_event_checklist_directives_event_idx;
    CREATE INDEX peakos_event_checklist_directives_event_idx
      ON peakos_event_checklist_directives(event_id DESC);
  `);
  assertMissing(await readiness(), 'index-definition:peakos_event_checklist_directives.peakos_event_checklist_directives_event_idx');
  await admin.query(`
    DROP INDEX peakos_event_checklist_directives_event_idx;
    CREATE INDEX peakos_event_checklist_directives_event_idx
      ON peakos_event_checklist_directives(event_id);
  `);

  await admin.query(`ALTER TABLE peakos_event_checklist_directives
    DISABLE TRIGGER peakos_event_checklist_directives_parent_guard`);
  assertMissing(await readiness(), 'trigger-definition:peakos_event_checklist_directives.peakos_event_checklist_directives_parent_guard');
  await admin.query(`ALTER TABLE peakos_event_checklist_directives
    ENABLE TRIGGER peakos_event_checklist_directives_parent_guard`);

  await admin.query(`
    DROP TRIGGER peakos_events_checklist_directive_workspace_guard ON events;
    CREATE TRIGGER peakos_events_checklist_directive_workspace_guard
      BEFORE UPDATE OF workspace_id, project_id ON events
      FOR EACH ROW EXECUTE FUNCTION public.peakos_event_preserve_checklist_directives();
  `);
  assertMissing(await readiness(), 'trigger-definition:events.peakos_events_checklist_directive_workspace_guard');
  await admin.query(migration);

  await admin.query(`ALTER FUNCTION public.peakos_event_checklist_directive_assert_parent()
    SECURITY DEFINER`);
  assertMissing(await readiness(), 'function-definition:peakos_event_checklist_directive_assert_parent');
  await admin.query(`ALTER FUNCTION public.peakos_event_checklist_directive_assert_parent()
    SECURITY INVOKER`);

  await admin.query(`
    CREATE OR REPLACE FUNCTION public.peakos_event_checklist_directive_touch_updated_at()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $tampered$ BEGIN RETURN NEW; END $tampered$;
  `);
  assertMissing(await readiness(), 'function-definition:peakos_event_checklist_directive_touch_updated_at');
  await admin.query(migration);

  await admin.query('GRANT TRUNCATE ON peakos_event_checklist_directives TO calendar_user');
  assertMissing(await readiness(), 'table-privilege:peakos_event_checklist_directives.TRUNCATE');
  await admin.query('REVOKE TRUNCATE ON peakos_event_checklist_directives FROM calendar_user');

  await admin.query('GRANT SELECT ON peakos_event_checklist_directives TO PUBLIC');
  assertMissing(await readiness(), 'public-table-privilege:peakos_event_checklist_directives.SELECT');
  await admin.query('REVOKE SELECT ON peakos_event_checklist_directives FROM PUBLIC');

  await admin.query(`GRANT EXECUTE ON FUNCTION
    public.peakos_event_checklist_directive_assert_parent() TO calendar_user`);
  assertMissing(await readiness(), 'function-privilege:peakos_event_checklist_directive_assert_parent.execute');
  await admin.query(`REVOKE EXECUTE ON FUNCTION
    public.peakos_event_checklist_directive_assert_parent() FROM calendar_user`);

  await admin.query(`GRANT EXECUTE ON FUNCTION
    public.peakos_event_checklist_directive_assert_parent() TO PUBLIC`);
  assertMissing(await readiness(), 'public-function-privilege:peakos_event_checklist_directive_assert_parent.execute');
  await admin.query(`REVOKE EXECUTE ON FUNCTION
    public.peakos_event_checklist_directive_assert_parent() FROM PUBLIC`);
  assert.equal((await readiness()).ready, true);

  const runtimeA = new Client({ connectionString: directivePostgresUrl });
  const runtimeB = new Client({ connectionString: directivePostgresUrl });
  await runtimeA.connect();
  await runtimeB.connect();
  t.after(async () => Promise.allSettled([runtimeA.end(), runtimeB.end()]));
  await runtimeA.query('SET ROLE calendar_user');
  await runtimeB.query('SET ROLE calendar_user');

  const insertDirectiveSql = `INSERT INTO peakos_event_checklist_directives
    (workspace_id, event_id, checklist_item_id, instructor_uid,
     instructor_name_snapshot, recorded_by_uid, recorded_by_name_snapshot)
    VALUES ('ws_peak', 'event-a', 'item-a', 'instructor-uid',
            'Instructor', 'owner-uid', 'Owner')`;
  const pendingAfter = (promise, milliseconds = 120) => Promise.race([
    promise.then(() => 'settled', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('pending'), milliseconds)),
  ]);

  await runtimeA.query('BEGIN');
  await runtimeB.query('BEGIN');
  await runtimeA.query("UPDATE events SET project_id = 'project-race' WHERE id = 'event-a'");
  const projectInsert = runtimeB.query(insertDirectiveSql);
  assert.equal(await pendingAfter(projectInsert), 'pending');
  await runtimeA.query('COMMIT');
  await assert.rejects(projectInsert, error => error.code === '23503');
  await runtimeB.query('ROLLBACK');
  await admin.query("UPDATE events SET project_id = NULL WHERE id = 'event-a'");

  await runtimeA.query('BEGIN');
  await runtimeB.query('BEGIN');
  await runtimeA.query("UPDATE event_checklist SET event_id = 'event-b' WHERE id = 'item-a'");
  const reparentInsert = runtimeB.query(insertDirectiveSql);
  assert.equal(await pendingAfter(reparentInsert), 'pending');
  await runtimeA.query('COMMIT');
  await assert.rejects(reparentInsert, error => error.code === '23503');
  await runtimeB.query('ROLLBACK');
  await admin.query("UPDATE event_checklist SET event_id = 'event-a' WHERE id = 'item-a'");

  await runtimeA.query('BEGIN');
  await runtimeB.query('BEGIN');
  await runtimeA.query(insertDirectiveSql);
  const projectUpdate = runtimeB.query(
    "UPDATE events SET project_id = 'project-race' WHERE id = 'event-a'",
  );
  assert.equal(await pendingAfter(projectUpdate), 'pending');
  await runtimeA.query('COMMIT');
  await assert.rejects(projectUpdate, error => error.code === '23503');
  await runtimeB.query('ROLLBACK');

  await runtimeA.query('BEGIN');
  await runtimeB.query('BEGIN');
  await runtimeA.query(
    "DELETE FROM peakos_event_checklist_directives WHERE checklist_item_id = 'item-a'",
  );
  await runtimeA.query(insertDirectiveSql);
  const reparentUpdate = runtimeB.query(
    "UPDATE event_checklist SET event_id = 'event-b' WHERE id = 'item-a'",
  );
  assert.equal(await pendingAfter(reparentUpdate), 'pending');
  await runtimeA.query('COMMIT');
  await assert.rejects(reparentUpdate, error => error.code === '23503');
  await runtimeB.query('ROLLBACK');
});

test('migration path is the expected operator artifact', () => {
  assert.equal(
    path.basename(MIGRATION_PATH),
    '20260817_peakos_event_checklist_directives.sql',
  );
});
