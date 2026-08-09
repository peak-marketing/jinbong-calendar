'use strict';

const fs = require('fs');
const path = require('path');

async function ensurePeakosCoreInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const migrationPath = path.join(
    __dirname,
    '..',
    'migrations',
    '20260805_peakos_reconciliation_prerequisites.sql',
  );
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
}

module.exports = { ensurePeakosCoreInfrastructure };
