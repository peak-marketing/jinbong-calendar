'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BASE_PRICE_ROWS,
  CATALOG_SHA256,
  CATALOG_VERSION,
  ensurePeakosPriceCatalog,
  priceKey,
  verifyCatalogDefinition,
} = require('./peakos-price-catalog');

test('기본 단가표 165건의 키와 기준 해시를 고정한다', () => {
  assert.equal(verifyCatalogDefinition(), true);
  assert.equal(BASE_PRICE_ROWS.length, 165);
  assert.equal(new Set(BASE_PRICE_ROWS.map(row => priceKey(...row.slice(0, 3)))).size, 165);
  assert.equal(CATALOG_SHA256, 'a2e8fee2ff95a55b04601c740897b514b08928268cde04ba3975babb8c7c592c');
  assert.equal(CATALOG_VERSION, 'legacy-b6d5f78-v1');
});

test('공백을 포함한 원본 상품 키를 정규화 없이 보존한다', () => {
  assert.ok(BASE_PRICE_ROWS.some(row => row[2] === 'AI 사진 3장 '));
  assert.ok(BASE_PRICE_ROWS.some(row => row[2] === '준최 4 '));
});

test('시드는 4개 workspace 현재 단가를 덮지 않고 각 165개 기본키를 검증한다', async () => {
  let inserts = 0;
  let metadataUpdates = 0;
  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('peakos-price-catalog-v1')) return { rows: [] };
      if (sql.includes('INSERT INTO peakos_price')) {
        inserts += 1;
        assert.match(sql, /ON CONFLICT \(workspace_id, key\) DO NOTHING/);
        return { rows: [] };
      }
      if (sql.includes('SELECT a, b, c FROM peakos_price')) {
        const parts = params[1].split('|');
        return { rows: [{ a: parts[0], b: parts[1], c: parts.slice(2).join('|') }] };
      }
      if (sql.includes('SET is_base = TRUE')) {
        metadataUpdates += 1;
        assert.doesNotMatch(sql, /SET\s+cost\s*=/);
        return { rows: [] };
      }
      if (sql.includes('COUNT(*)::integer')) return { rows: [{ count: 165 }] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
  await ensurePeakosPriceCatalog({ connect: async () => client });
  assert.equal(inserts, 4 * 165);
  assert.equal(metadataUpdates, 4 * 165);
});
