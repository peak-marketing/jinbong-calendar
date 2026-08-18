'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const indexPath = path.join(__dirname, '..', 'index.js');

test('server mounts todos behind selected-workspace/email gate and allows the isolated branch surface', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  assert.match(source, /app\.use\(\s*'\/api\/peakos',[\s\S]*?requireSelectedWorkspace\(\)/);
  assert.match(source, /\|\| \/\^\\\/todos\(\?:\\\/\|\$\)\//);
  assert.match(source, /registerPeakosTodoRoutes\(\{[\s\S]*?area: 'calendar', action: 'read', requireHeader: true[\s\S]*?area: 'calendar', action: 'write', requireHeader: true/);
  assert.match(source, /collaborationAreaForPath[\s\S]*?\^\\\/api\\\/peakos\\\/todos[\s\S]*?return 'calendar'/);
  assert.ok(source.indexOf("app.use(\n  '/api/peakos'") < source.indexOf('registerPeakosTodoRoutes({'));
});

test('restricted calendar/chat allowlists do not admit the internal personal todo route', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const restrictedStart = source.indexOf('function isChatOnlyAllowedPath');
  const restrictedEnd = source.indexOf('function isExternalCalendarUser', restrictedStart);
  const restrictedPolicy = source.slice(restrictedStart, restrictedEnd);
  assert.doesNotMatch(restrictedPolicy, /peakos\\\/todos|peakos\/todos/);
});

test('startup exact-readiness includes todos before the first legacy write-capable ensure', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const workspace = source.indexOf('await ensurePeakosWorkspaceInfrastructure(pool);');
  const todo = source.indexOf('await ensurePeakosTodoInfrastructure(pool);');
  const firstLegacyWrite = source.indexOf('await ensureReminderInfrastructure();');
  assert.ok(workspace >= 0 && todo > workspace && todo < firstLegacyWrite);
});
