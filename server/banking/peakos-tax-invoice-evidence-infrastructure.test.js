'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const {
  MIGRATION_PATH,
  REQUIRED_COLUMNS,
  REQUIRED_CONSTRAINTS,
  REQUIRED_INDEXES,
  REQUIRED_TRIGGERS,
  TABLE_PRIVILEGES,
  TAX_INVOICE_EVIDENCE_READINESS_SQL,
  ensurePeakosTaxInvoiceEvidenceInfrastructure,
  taxInvoiceEvidenceReadiness,
} = require('./peakos-tax-invoice-evidence-infrastructure');

test('operator migration은 protected evidence, terminal guard, append-only audit, 최소 ACL만 선언한다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /^-- Protected,[\s\S]*BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_tax_invoice_evidence \(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.peakos_tax_invoice_evidence_audit \(/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS current_invoice_evidence_id UUID/);
  assert.match(sql, /invoice_status NOT IN \('ISSUED', 'CORRECTED'\)[\s\S]*current_invoice_evidence_id IS NOT NULL/);
  assert.match(sql, /peakos_tax_invoice_evidence_no_mutation/);
  assert.match(sql, /peakos_finance_requests_invoice_evidence_guard/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.peakos_tax_invoice_evidence/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.peakos_tax_invoice_evidence_audit/);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*peakos_tax_invoice_evidence/i);
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.peakos_bank_/i);
});

test('readiness에 고정한 trigger prosrc hash가 migration 본문과 정확히 일치한다', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const [, , , functionName, expectedMd5] of REQUIRED_TRIGGERS) {
    const expression = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${functionName}\\(\\)[\\s\\S]*?AS \\$([A-Za-z0-9_]+)\\$([\\s\\S]*?)\\$\\1\\$;`,
    );
    const match = sql.match(expression);
    assert.ok(match, `${functionName} source is present`);
    assert.equal(crypto.createHash('md5').update(match[2]).digest('hex'), expectedMd5);
  }
});

test('exact readiness는 runtime DDL 없이 column/constraint/index/trigger/ACL 변조를 점검한다', async () => {
  assert.equal(REQUIRED_COLUMNS.length, 30);
  assert.equal(REQUIRED_CONSTRAINTS.length, 26);
  assert.equal(REQUIRED_INDEXES.length, 3);
  assert.equal(REQUIRED_TRIGGERS.length, 8);
  assert.deepEqual(TABLE_PRIVILEGES.peakos_tax_invoice_evidence, {
    SELECT: true, INSERT: true, UPDATE: false, DELETE: false,
    TRUNCATE: false, REFERENCES: false, TRIGGER: false,
  });
  assert.match(TAX_INVOICE_EVIDENCE_READINESS_SQL, /md5\(function_row\.prosrc\)/);
  assert.match(TAX_INVOICE_EVIDENCE_READINESS_SQL, /has_table_privilege/);
  assert.match(TAX_INVOICE_EVIDENCE_READINESS_SQL, /has_sequence_privilege/);
  assert.match(TAX_INVOICE_EVIDENCE_READINESS_SQL, /has_function_privilege/);
  assert.doesNotMatch(TAX_INVOICE_EVIDENCE_READINESS_SQL, /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);

  const ready = await ensurePeakosTaxInvoiceEvidenceInfrastructure({
    async query(sql) {
      assert.equal(sql, TAX_INVOICE_EVIDENCE_READINESS_SQL);
      return { rows: [{ ready: true, missing_requirements: [] }] };
    },
  });
  assert.deepEqual(ready, { ready: true, missing: [] });
});

test('missing/disabled/tampered requirement는 fail-closed startup error가 된다', async () => {
  const parsed = taxInvoiceEvidenceReadiness({
    ready: false,
    missing_requirements: [
      'trigger-definition:peakos_finance_requests.peakos_finance_requests_invoice_evidence_guard',
      'table-privilege:peakos_tax_invoice_evidence.UPDATE',
    ],
  });
  assert.equal(parsed.ready, false);
  assert.equal(parsed.code, 'TAX_INVOICE_EVIDENCE_SCHEMA_NOT_READY');
  assert.equal(parsed.missing.length, 2);

  await assert.rejects(
    ensurePeakosTaxInvoiceEvidenceInfrastructure({
      async query() {
        return { rows: [{ ready: false, missing_requirements: parsed.missing }] };
      },
    }),
    error => error.code === 'TAX_INVOICE_EVIDENCE_SCHEMA_NOT_READY'
      && error.missing.includes('table-privilege:peakos_tax_invoice_evidence.UPDATE'),
  );
});
