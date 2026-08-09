'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const BASE_PRICE_ROWS = require('./peakos-price-catalog-data');

const CATALOG_VERSION = 'legacy-b6d5f78-v1';
const CATALOG_SHA256 = 'a2e8fee2ff95a55b04601c740897b514b08928268cde04ba3975babb8c7c592c';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  '20260809_peakos_price_catalog.sql',
);
const PRICE_WORKSPACE_IDS = Object.freeze([
  'ws_peak',
  'ws_build_solution',
  'ws_jeonju',
  'ws_daegu',
]);

function priceKey(a, b, c) {
  return `${String(a)}|${String(b)}|${String(c)}`;
}

function verifyCatalogDefinition() {
  const actual = crypto.createHash('sha256')
    .update(JSON.stringify(BASE_PRICE_ROWS))
    .digest('hex');
  if (actual !== CATALOG_SHA256) throw new Error('PEAK OS 기본 단가표 해시가 기준과 다릅니다.');
  const keys = BASE_PRICE_ROWS.map(row => priceKey(row[0], row[1], row[2]));
  if (BASE_PRICE_ROWS.length !== 165 || new Set(keys).size !== BASE_PRICE_ROWS.length) {
    throw new Error('PEAK OS 기본 단가표의 건수 또는 키가 올바르지 않습니다.');
  }
  return true;
}

async function seedWorkspacePriceCatalog(client, workspaceId) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client.query가 필요합니다.');
  if (!PRICE_WORKSPACE_IDS.includes(workspaceId)) throw new TypeError('올바른 단가표 workspace_id가 필요합니다.');
  verifyCatalogDefinition();
  for (const [a, b, c, cost, unit] of BASE_PRICE_ROWS) {
    const key = priceKey(a, b, c);
    await client.query(
      `INSERT INTO peakos_price
          (workspace_id, key, a, b, c, cost, unit, is_custom, is_base,
           default_cost, default_unit, catalog_version, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,TRUE,$6,$7,$8,'기본 단가표 이관',NOW())
         ON CONFLICT (workspace_id, key) DO NOTHING`,
      [workspaceId, key, a, b, c, cost, unit, CATALOG_VERSION],
    );
    const existing = await client.query(
      'SELECT a, b, c FROM peakos_price WHERE workspace_id = $1 AND key = $2 FOR UPDATE',
      [workspaceId, key],
    );
    const row = existing.rows[0];
    if (!row || row.a !== a || row.b !== b || row.c !== c) {
      throw new Error('기본 단가표 키와 분류가 충돌합니다.');
    }
    // Preserve independently edited current values in each workspace. Only
    // immutable defaults and catalog identity are repaired on repeated startup.
    await client.query(
      `UPDATE peakos_price
            SET is_base = TRUE,
                is_custom = FALSE,
                default_cost = $3,
                default_unit = $4,
                catalog_version = $5
          WHERE workspace_id = $1 AND key = $2`,
      [workspaceId, key, cost, unit, CATALOG_VERSION],
    );
  }
  const check = await client.query(
    `SELECT COUNT(*)::integer AS count
         FROM peakos_price
        WHERE workspace_id = $1
          AND is_base = TRUE
          AND catalog_version = $2`,
    [workspaceId, CATALOG_VERSION],
  );
  if (Number(check.rows[0]?.count) !== BASE_PRICE_ROWS.length) {
    throw new Error('PEAK OS 워크스페이스 기본 단가표 저장 건수가 올바르지 않습니다.');
  }
  return BASE_PRICE_ROWS.length;
}

async function ensurePeakosPriceCatalog(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  verifyCatalogDefinition();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    for (const workspaceId of PRICE_WORKSPACE_IDS) {
      await seedWorkspacePriceCatalog(client, workspaceId);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function findCatalogPrice(client, { a, b, c, workspaceId = 'ws_peak', workspace_id } = {}) {
  const resolvedWorkspaceId = workspace_id || workspaceId;
  const result = await client.query(
    `SELECT key, a, b, c, cost, unit, is_custom, is_base
       FROM peakos_price
      WHERE workspace_id = $1 AND key = $2 AND a = $3 AND b = $4 AND c = $5`,
    [resolvedWorkspaceId, priceKey(a, b, c), a, b, c],
  );
  return result.rows[0] || null;
}

module.exports = {
  BASE_PRICE_ROWS,
  CATALOG_SHA256,
  CATALOG_VERSION,
  PRICE_WORKSPACE_IDS,
  ensurePeakosPriceCatalog,
  findCatalogPrice,
  priceKey,
  seedWorkspacePriceCatalog,
  verifyCatalogDefinition,
};
