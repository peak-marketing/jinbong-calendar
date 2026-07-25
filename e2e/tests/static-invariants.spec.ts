import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Fast, non-browser tests that protect against regressions in the bug
// fixes we just shipped. These assert on the source of index.html.
const INDEX_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../index.html'),
  'utf8'
);

test.describe('source invariants', () => {
  test('no auto location.reload() in service-worker statechange handler', () => {
    // We care specifically about the updatefound → statechange branch
    // auto-reloading the tab, which used to destroy modals mid-edit.
    // A user-initiated "새로고침" button in an update banner is fine.
    const start = INDEX_HTML.indexOf('async function ensureServiceWorkerRegistration');
    expect(start).toBeGreaterThan(0);
    // Narrow to the statechange callback block only, not the whole
    // surrounding region (which now contains a banner whose *button*
    // calls location.reload on user click).
    const stateChangeIdx = INDEX_HTML.indexOf("newSW.addEventListener('statechange'", start);
    expect(stateChangeIdx).toBeGreaterThan(-1);
    // Find the matching closing brace of the handler by counting
    // braces from the opening `{` after `statechange', () =>`.
    const bodyStart = INDEX_HTML.indexOf('{', stateChangeIdx);
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < INDEX_HTML.length; i++) {
      if (INDEX_HTML[i] === '{') depth += 1;
      else if (INDEX_HTML[i] === '}') { depth -= 1; if (depth === 0) { bodyEnd = i + 1; break; } }
    }
    const raw = INDEX_HTML.slice(bodyStart, bodyEnd);
    const region = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(region).not.toMatch(/location\.reload\s*\(\s*\)/);
  });

  test('month cell template carries data-date and uses selectMonthDate', () => {
    expect(INDEX_HTML).toMatch(/class="cal-cell [^"]*"\s+data-date="\$\{ds\}"/);
    expect(INDEX_HTML).toMatch(/onclick="selectMonthDate\('\$\{ds\}'\)"/);
  });

  test('refreshCalendarUi tries patchCalendarInPlace before full renderPage', () => {
    const m = INDEX_HTML.match(
      /function refreshCalendarUi[\s\S]*?\n\}/
    );
    expect(m).not.toBeNull();
    expect(m![0]).toContain('patchCalendarInPlace()');
    expect(m![0]).toContain('renderPage(options.keepScroll !== false)');
  });

  test('patchCalendarMonthView + helper functions exist', () => {
    expect(INDEX_HTML).toContain('function patchCalendarInPlace(');
    expect(INDEX_HTML).toContain('function patchCalendarMonthView(');
    expect(INDEX_HTML).toContain('function patchCalendarListView(');
    expect(INDEX_HTML).toContain('function selectMonthDate(');
  });

  test('fetchEvents preserves recent local upserts against polling clobber', () => {
    const m = INDEX_HTML.match(/async function fetchEvents[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('recentLocalUpserts');
    expect(m![0]).toContain('UPSERT_GRACE_MS');
  });

  test('upsertLocalEvent records into recentLocalUpserts and clears on delete', () => {
    const m = INDEX_HTML.match(/function upsertLocalEvent\(record\)[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('recentLocalUpserts.set');
    expect(m![0]).toContain('recentLocalUpserts.delete');
  });

  test('saveNewEvent refreshes calendar before closing modal', () => {
    const m = INDEX_HTML.match(/async function saveNewEvent\(\)[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const src = m![0];
    const refreshIdx = src.indexOf('refreshCalendarUi({ keepScroll: true })');
    const closeIdx = src.indexOf('closeModal()', refreshIdx);
    expect(refreshIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeGreaterThan(refreshIdx);
  });

  test('repeat-event save path uses refreshCalendarUi, not renderPage(true)', () => {
    const m = INDEX_HTML.match(/async function saveNewEvent\(\)[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const repeatBlock = m![0].slice(m![0].indexOf('if (repeatType)'));
    // Should not fall back to renderPage(true) inside the repeatType branch.
    expect(repeatBlock).not.toMatch(/renderPage\(true\)/);
    expect(repeatBlock).toContain('refreshCalendarUi');
  });

  test('deleteRepeatFuture/All use refreshCalendarUi', () => {
    const futureFn = INDEX_HTML.match(/async function deleteRepeatFuture[\s\S]*?\n\}/);
    const allFn = INDEX_HTML.match(/async function deleteRepeatAll[\s\S]*?\n\}/);
    expect(futureFn).not.toBeNull();
    expect(allFn).not.toBeNull();
    expect(futureFn![0]).toContain('refreshCalendarUi');
    expect(futureFn![0]).not.toMatch(/renderPage\(true\)/);
    expect(allFn![0]).toContain('refreshCalendarUi');
    expect(allFn![0]).not.toMatch(/renderPage\(true\)/);
  });

  test('morphHtml + morphChildren helpers exist, patch fns use them', () => {
    expect(INDEX_HTML).toContain('function morphHtml(');
    expect(INDEX_HTML).toContain('function morphChildren(');
    expect(INDEX_HTML).toContain('function morphNodeInPlace(');
    const monthFn = INDEX_HTML.match(/function patchCalendarMonthView\(\)[\s\S]*?\n\}/);
    expect(monthFn).not.toBeNull();
    expect(monthFn![0]).toContain('morphHtml(rightPanel,');
    expect(monthFn![0]).toContain('morphHtml(mobilePanel,');
    expect(monthFn![0]).not.toMatch(/rightPanel\.innerHTML\s*=/);
    const listFn = INDEX_HTML.match(/function patchCalendarListView\(\)[\s\S]*?\n\}/);
    expect(listFn).not.toBeNull();
    expect(listFn![0]).toContain('morphHtml(area,');
    expect(listFn![0]).not.toMatch(/area\.innerHTML\s*=/);
  });

  test('/api/events forces a default date scope for admin/manager even when client omits from/to', () => {
    // Stale tabs on the manager account were pulling 50k+ rows on
    // every 5s poll because the original endpoint fell back to an
    // unscoped query when from/to were missing. Bandwidth report
    // showed /api/events at 152 GB (92% of outbound) for one month.
    // The server must now enforce a default range for privileged
    // roles regardless of client params.
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const fn = SERVER.match(/app\.get\('\/api\/events'[\s\S]*?\n\}\);/);
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toContain('isPrivileged');
    expect(src).toMatch(/isPrivileged && !effectiveFrom && !effectiveTo/);
    expect(src).toMatch(/server-default/);
  });

  test('todo notification crons count owner + shares + team (matches UI)', () => {
    // The push "미완료 N건" must line up with the "미완료 N" badge
    // on the calendar. Both are per-user, so the cron query has to
    // mirror /api/events scoping — owner_id OR event_shares OR
    // (role∈admin|manager AND scope='team'). Regressing to owner-only
    // was what caused admin users to see "1건" in a push while their
    // calendar showed 21.
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    expect(SERVER).toContain('function buildTodoCountQuery');
    const fn = SERVER.match(/function buildTodoCountQuery\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toMatch(/owner_id\s*=\s*\$1/);
    expect(src).toMatch(/scope\s*=\s*'team'/);
    expect(src).toMatch(/event_shares/);
    // Both the morning (10:00) and evening (19:00) crons must use it.
    const morning = SERVER.match(/cron\.schedule\('0 10 \* \* \*'[\s\S]*?\}, \{ timezone/);
    const evening = SERVER.match(/cron\.schedule\('0 19 \* \* 1-5'[\s\S]*?\}, \{ timezone/);
    expect(morning).not.toBeNull();
    expect(evening).not.toBeNull();
    expect(morning![0]).toContain('buildTodoCountQuery');
    expect(evening![0]).toContain('buildTodoCountQuery');
    // Both must also skip chat_only users (no calendar, no relevant todos).
    expect(morning![0]).toContain('chat_only = false');
    expect(evening![0]).toContain('chat_only = false');
    // And neither should fall back to the old owner-only filter.
    expect(morning![0]).not.toMatch(/SELECT COUNT\(\*\) FROM events WHERE owner_id = \$1 AND deleted/);
    expect(evening![0]).not.toMatch(/SELECT COUNT\(\*\) FROM events WHERE owner_id = \$1 AND deleted/);
    // Evening cron additionally has to pick up multi-day range todos
    // (date ≤ today ≤ end_date) so the push count matches eventsForDate().
    expect(evening![0]).toContain('end_date');
  });

  test('/users/:uid/approve accepts role/groupId/chatOnly in body', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const fn = SERVER.match(/app\.post\('\/api\/users\/:uid\/approve'[\s\S]*?\n\}\);/);
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toContain('role');
    expect(src).toContain('groupId');
    expect(src).toContain('chatOnly');
    // Must refuse chat_only on an existing admin.
    expect(src).toContain("'admin'");
    // Must keep the `approved = true` update.
    expect(src).toContain('approved = true');
  });

  test('approve button opens the role/group/chat-only picker modal', () => {
    expect(INDEX_HTML).toContain('function openApproveUser(');
    expect(INDEX_HTML).toContain('function confirmApproveUser(');
    // The pending row's button invokes the picker, not the legacy
    // one-shot approveUser() path.
    const pendingRow = INDEX_HTML.match(/onclick="openApproveUser\('\$\{u\.uid\}'/);
    expect(pendingRow).not.toBeNull();
    // And the picker carries the three editable fields.
    expect(INDEX_HTML).toContain('name="approve_role"');
    expect(INDEX_HTML).toContain('id="approve_group"');
    expect(INDEX_HTML).toContain('id="approve_chat_only"');
  });

  test('server filters /users/all-approved for chat_only callers', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const start = SERVER.indexOf("'/api/users/all-approved'");
    expect(start).toBeGreaterThan(0);
    // Walk forward to the end of this handler.
    const region = SERVER.slice(start, start + 2000);
    expect(region).toContain('chat_only');
    expect(region).toMatch(/u\.uid\s*=\s*\$1\s+OR\s+u\.role\s*=\s*'admin'/);
  });

  test('project create and conversations notify project members', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const createRoute = SERVER.match(/app\.post\('\/api\/projects'[\s\S]*?app\.get\('\/api\/projects\/:id'/);
    expect(createRoute).not.toBeNull();
    expect(createRoute![0]).toContain('notifyProjectMembers');
    expect(createRoute![0]).toContain('새 프로젝트');

    const projectCommentRoute = SERVER.match(/app\.post\('\/api\/projects\/:id\/comments'[\s\S]*?app\.put\('\/api\/projects\/:id\/comments\/:commentId'/);
    expect(projectCommentRoute).not.toBeNull();
    expect(projectCommentRoute![0]).toContain('notifyProjectMembers');
    expect(projectCommentRoute![0]).toContain('프로젝트 대화');

    const taskCommentRoute = SERVER.match(/app\.post\('\/api\/projects\/:id\/tasks\/:taskId\/comments'[\s\S]*?app\.delete\('\/api\/projects\/:id\/tasks\/:taskId\/comments\/:commentId'/);
    expect(taskCommentRoute).not.toBeNull();
    expect(taskCommentRoute![0]).toContain('notifyProjectMembers');
    expect(taskCommentRoute![0]).toContain('업무 대화');

    const taskUpdateRoute = SERVER.match(/app\.put\('\/api\/projects\/:id\/tasks\/:taskId'[\s\S]*?app\.delete\('\/api\/projects\/:id\/tasks\/:taskId'/);
    expect(taskUpdateRoute).not.toBeNull();
    expect(taskUpdateRoute![0]).toContain('notifyProjectMembers');
    expect(taskUpdateRoute![0]).toContain('업무 검토요청');
    expect(taskUpdateRoute![0]).toContain('업무 완료 처리');
  });

  test('all-assignee project tasks track per-user completion', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    expect(SERVER).toContain('CREATE TABLE IF NOT EXISTS project_task_assignees');
    expect(SERVER).toContain("req.body.assigneeMode === 'all'");
    expect(SERVER).toContain("app.put('/api/projects/:id/tasks/:taskId/completion'");
    expect(SERVER).toContain('completedCount === total');
    expect(SERVER).toContain("nextStatus = 'review'");

    expect(INDEX_HTML).toContain('모두 (프로젝트 참여자 전원)');
    expect(INDEX_HTML).toContain('개인별 완료 현황');
    expect(INDEX_HTML).toContain('toggleProjectTaskCompletion');
  });

  test('single-assignee completion requests review before final completion', () => {
    expect(INDEX_HTML).toContain("['review', 'done'].includes(task.status)");
    expect(INDEX_HTML).toContain("checked ? 'doing' : 'review'");
    expect(INDEX_HTML).toContain('검토요청 상태 변경');
  });

  test('/api/events excludes meetings from archived or deleted projects', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    const fn = SERVER.match(/app\.get\('\/api\/events'[\s\S]*?\n\}\);/);
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toContain('LEFT JOIN projects ep ON ep.id = e.project_id');
    expect(src).toContain('LEFT JOIN project_details epd ON epd.project_id = ep.id');
    expect(src).toContain('COALESCE(epd.deleted, false) = false');
    expect(src).toContain("ep.status IS DISTINCT FROM 'archived'");
  });

  test('server authMiddleware enforces chat-only path whitelist', () => {
    const SERVER = fs.readFileSync(
      path.resolve(__dirname, '../../server/index.js'),
      'utf8'
    );
    expect(SERVER).toContain('isChatOnlyAllowedPath');
    const fn = SERVER.match(/function isChatOnlyAllowedPath\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    // Chat-required paths must be whitelisted.
    expect(fn![0]).toMatch(/\/api\\\/chat-rooms/);
    expect(fn![0]).toMatch(/\/api\\\/users\\\/me/);
    // And the auth path actually consults the helper.
    expect(SERVER).toMatch(/chat_only[\s\S]{0,120}isChatOnlyAllowedPath/);
  });

  test('accordion uses stable data-acc-key and toggleAcc helper', () => {
    const fn = INDEX_HTML.match(/function accordion\(title, badge, color, content, collapsed\)[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('data-acc-key=');
    expect(fn![0]).toContain('toggleAcc(this)');
    expect(fn![0]).not.toMatch(/document\.getElementById\('\$\{id\}'\)\.style\.display/);
    expect(INDEX_HTML).toContain('function toggleAcc(');
  });
});
