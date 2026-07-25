import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Regression net for the Korean-IME double-Enter bug that made
// addCheckItem POST twice. Two guards must stay in place:
//   1. Every Enter onkeydown handler skips when the IME is still
//      composing (event.isComposing || keyCode === 229).
//   2. addCheckItem uses a busy flag so a stray second call can't
//      slip past before input.value is visibly cleared.
const INDEX_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../index.html'),
  'utf8'
);

test.describe('IME Enter double-fire guards', () => {
  test('every Enter keydown handler filters event.isComposing', () => {
    const handlers = [...INDEX_HTML.matchAll(/onkeydown\s*=\s*"[^"]*key\s*===\s*'Enter'[^"]*"/g)]
      .map(m => m[0]);
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      expect(h, `missing isComposing / 229 guard in: ${h}`).toMatch(/isComposing/);
      expect(h, `missing isComposing / 229 guard in: ${h}`).toMatch(/229/);
    }
  });

  test('inlineAddTodo input.onkeydown filters event.isComposing', () => {
    const m = INDEX_HTML.match(/input\.onkeydown\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?\};/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/isComposing/);
    expect(m![0]).toMatch(/keyCode\s*!==\s*229/);
  });

  test('addCheckItem uses a busy flag to block re-entry', () => {
    const fn = INDEX_HTML.match(/async function addCheckItem\(eventId\)[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/dataset\.busy/);
    // The busy flag must be set AND the value cleared BEFORE the POST
    // await, otherwise a second keydown in the same tick still wins.
    const body = fn![0];
    const busyIdx = body.indexOf("dataset.busy = '1'");
    const clearIdx = body.indexOf("input.value = ''");
    const awaitIdx = body.indexOf('await api');
    expect(busyIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(busyIdx).toBeLessThan(awaitIdx);
    expect(clearIdx).toBeLessThan(awaitIdx);
    // And the flag must be released in a finally block so an error
    // doesn't wedge the input forever.
    expect(body).toMatch(/finally\s*\{[\s\S]*?dataset\.busy\s*=\s*''/);
  });
});
