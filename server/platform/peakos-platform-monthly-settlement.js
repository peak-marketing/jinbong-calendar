'use strict';

const crypto = require('node:crypto');

const KST_TIME_ZONE = 'Asia/Seoul';
const PLATFORM_PROVIDERS = Object.freeze([
  Object.freeze({ key: 'rewardspace', label: '리워드스페이스' }),
  Object.freeze({ key: 'reviewspace', label: '리뷰스페이스' }),
  Object.freeze({ key: 'keywordmaster', label: '키워드마스터' }),
  Object.freeze({ key: 'brandautospace', label: '브랜드오토스페이스' }),
  Object.freeze({ key: 'reviewflow', label: '리뷰플로우' }),
]);
const PROVIDER_KEYS = Object.freeze(PLATFORM_PROVIDERS.map(provider => provider.key));
const PROVIDER_SET = new Set(PROVIDER_KEYS);
const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:._/-]+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ISSUE_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/;
const AGGREGATE_SOURCE_STATES = new Set(['live', 'draft', 'paid', 'unknown']);
const AGGREGATE_PROFIT_BASES = new Set([
  'reward_distributor_margin', 'review_spread_profit', 'unavailable',
]);

const REQUIRED_COLUMN_DEFINITIONS = Object.freeze({
  peakos_platform_connections: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], version: ['integer', true, ''],
    connection_state: ['text', true, "'pending'::text"], credential_secret_ref: ['text', false, ''],
    last_successful_import_at: ['timestamp with time zone', false, ''], last_error_code: ['text', false, ''],
    actor_uid: ['text', true, ''], actor_name_snapshot: ['text', true, "''::text"],
    created_at: ['timestamp with time zone', true, 'now()'],
  }),
  peakos_platform_salesperson_mappings: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    version: ['integer', true, ''], supersedes_id: ['uuid', false, ''],
    operation_key: ['text', true, ''],
    external_name_normalized: ['text', true, ''], external_name_snapshot: ['text', true, ''],
    owner_uid: ['text', false, ''], owner_name_snapshot: ['text', false, ''],
    mapping_state: ['text', true, "'active'::text"], match_method: ['text', true, "'exact_name'::text"],
    correction_reason: ['text', false, ''], actor_uid: ['text', true, ''],
    actor_name_snapshot: ['text', true, "''::text"], created_at: ['timestamp with time zone', true, 'now()'],
  }),
  peakos_platform_import_runs: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    idempotency_key: ['text', true, ''], source_digest: ['text', true, ''], adapter_version: ['text', true, ''],
    status: ['text', true, ''], covered_from: ['date', true, ''], covered_to: ['date', true, ''],
    source_total_count: ['integer', true, ''], snapshot_complete: ['boolean', true, ''],
    requested_count: ['integer', true, '0'], inserted_count: ['integer', true, '0'],
    mapped_count: ['integer', true, '0'], unmapped_count: ['integer', true, '0'],
    ambiguous_count: ['integer', true, '0'], actor_uid: ['text', true, ''],
    actor_name_snapshot: ['text', true, "''::text"], error_code: ['text', false, ''],
    started_at: ['timestamp with time zone', true, ''], completed_at: ['timestamp with time zone', true, ''],
  }),
  peakos_platform_transaction_events: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    import_run_id: ['uuid', true, ''], external_transaction_id: ['text', true, ''],
    event_fingerprint: ['text', true, ''], source_updated_at: ['timestamp with time zone', true, ''],
    business_date: ['date', true, ''], external_salesperson_name: ['text', true, ''],
    external_name_normalized: ['text', true, ''], attribution_status: ['text', true, ''],
    owner_uid: ['text', false, ''], owner_name_snapshot: ['text', false, ''],
    record_state: ['text', true, "'active'::text"], sales_amount: ['numeric(20,0)', false, ''],
    profit_amount: ['numeric(20,0)', false, ''], currency: ['text', true, "'KRW'::text"],
    imported_at: ['timestamp with time zone', true, 'now()'],
  }),
  peakos_platform_aggregate_runs: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    settlement_month: ['text', true, ''], status: ['text', true, "'completed'::text"],
    covered_from: ['date', true, ''], covered_to: ['date', true, ''],
    idempotency_key: ['text', true, ''], source_digest: ['text', true, ''],
    adapter_version: ['text', true, ''], source_total_count: ['integer', true, ''],
    row_count: ['integer', true, ''], mapped_count: ['integer', true, ''],
    ambiguous_count: ['integer', true, ''], global_unmatched_count: ['integer', true, ''],
    source_excluded_count: ['integer', true, ''],
    source_state: ['text', true, "'unknown'::text"], source_drift: ['numeric(20,0)', false, ''],
    observed_at: ['timestamp with time zone', true, ''], actor_uid: ['text', true, ''],
    actor_name_snapshot: ['text', true, "''::text"],
    completed_at: ['timestamp with time zone', true, ''],
    created_at: ['timestamp with time zone', true, 'now()'],
  }),
  peakos_platform_aggregate_rows: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    snapshot_run_id: ['uuid', true, ''], external_row_key: ['text', true, ''],
    external_salesperson_name: ['text', true, ''], external_name_normalized: ['text', true, ''],
    attribution_status: ['text', true, ''], owner_uid: ['text', false, ''],
    owner_name_snapshot: ['text', false, ''], sales_amount: ['numeric(20,0)', false, ''],
    profit_amount: ['numeric(20,0)', false, ''], profit_basis: ['text', true, ''],
    source_record_count: ['integer', false, ''], attribution_issue_code: ['text', false, ''],
    attribution_issue_detail: ['text', false, ''], currency: ['text', true, "'KRW'::text"],
    imported_at: ['timestamp with time zone', true, 'now()'],
  }),
  peakos_platform_aggregate_quarantines: Object.freeze({
    workspace_id: ['text', true, ''], provider: ['text', true, ''], id: ['uuid', true, ''],
    aggregate_run_id: ['uuid', true, ''], operation_key: ['text', true, ''],
    expected_latest_run_id: ['uuid', true, ''], reason: ['text', true, ''],
    actor_uid: ['text', true, ''], actor_name_snapshot: ['text', true, ''],
    created_at: ['timestamp with time zone', true, 'now()'],
  }),
});
const REQUIRED_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_COLUMN_DEFINITIONS).map(([table, columns]) => [table, Object.freeze(Object.keys(columns))]),
));
const PROVIDER_CHECK_DEFINITION = "CHECK ((provider = ANY (ARRAY['rewardspace'::text, 'reviewspace'::text, 'keywordmaster'::text, 'brandautospace'::text, 'reviewflow'::text])))";
const WORKSPACE_FK_DEFINITION = 'FOREIGN KEY (workspace_id) REFERENCES peakos_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT';
const OWNER_FK_DEFINITION = 'FOREIGN KEY (workspace_id, owner_uid) REFERENCES peakos_workspace_memberships(workspace_id, user_uid) ON UPDATE RESTRICT ON DELETE RESTRICT';
const PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION = "CHECK (((credential_secret_ref IS NULL) OR (((char_length(credential_secret_ref) >= 1) AND (char_length(credential_secret_ref) <= 512)) AND (credential_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9:/._-]*$'::text))))";
const REQUIRED_CONSTRAINT_DEFINITIONS = Object.freeze({
  peakos_platform_connections_actor_check: ['c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
  peakos_platform_connections_actor_name_check: ['c', 'CHECK ((char_length(actor_name_snapshot) <= 160))'],
  peakos_platform_connections_error_check: ['c', "CHECK ((((connection_state = 'error'::text) AND (last_error_code IS NOT NULL) AND (last_error_code ~ '^[A-Z0-9_]{1,80}$'::text)) OR ((connection_state <> 'error'::text) AND (last_error_code IS NULL))))"],
  peakos_platform_connections_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, version)'],
  peakos_platform_connections_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_connections_ready_secret_check: ['c', "CHECK (((connection_state <> 'ready'::text) OR (credential_secret_ref IS NOT NULL)))"],
  peakos_platform_connections_secret_ref_check: ['c', PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION],
  peakos_platform_connections_state_check: ['c', "CHECK ((connection_state = ANY (ARRAY['pending'::text, 'ready'::text, 'error'::text, 'disabled'::text])))"],
  peakos_platform_connections_version_check: ['c', 'CHECK ((version > 0))'],
  peakos_platform_connections_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_salesperson_mappings_actor_check: ['c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
  peakos_platform_salesperson_mappings_actor_name_check: ['c', 'CHECK ((char_length(actor_name_snapshot) <= 160))'],
  peakos_platform_salesperson_mappings_correction_check: ['c', "CHECK ((((match_method = 'exact_name'::text) AND (version = 1) AND (correction_reason IS NULL)) OR ((match_method = 'manual_correction'::text) AND (correction_reason IS NOT NULL) AND ((char_length(btrim(correction_reason)) >= 8) AND (char_length(btrim(correction_reason)) <= 500))) OR ((match_method = 'manual_revoke'::text) AND (version > 1) AND (correction_reason IS NOT NULL) AND ((char_length(btrim(correction_reason)) >= 8) AND (char_length(btrim(correction_reason)) <= 500)))))"],
  peakos_platform_salesperson_mappings_external_name_check: ['c', 'CHECK (((char_length(external_name_normalized) >= 1) AND (char_length(external_name_normalized) <= 160)))'],
  peakos_platform_salesperson_mappings_external_snapshot_check: ['c', 'CHECK (((char_length(btrim(external_name_snapshot)) >= 1) AND (char_length(btrim(external_name_snapshot)) <= 160)))'],
  peakos_platform_salesperson_mappings_match_method_check: ['c', "CHECK ((match_method = ANY (ARRAY['exact_name'::text, 'manual_correction'::text, 'manual_revoke'::text])))"],
  peakos_platform_salesperson_mappings_owner_check: ['c', "CHECK ((((mapping_state = 'active'::text) AND (owner_uid IS NOT NULL) AND (owner_name_snapshot IS NOT NULL) AND ((char_length(btrim(owner_name_snapshot)) >= 1) AND (char_length(btrim(owner_name_snapshot)) <= 160))) OR ((mapping_state = 'revoked'::text) AND (owner_uid IS NULL) AND (owner_name_snapshot IS NULL))))"],
  peakos_platform_salesperson_mappings_owner_membership_fk: ['f', OWNER_FK_DEFINITION],
  peakos_platform_salesperson_mappings_operation_check: ['c', "CHECK ((operation_key ~ '^[A-Za-z0-9:._/-]{1,240}$'::text))"],
  peakos_platform_salesperson_mappings_operation_unique: ['u', 'UNIQUE (workspace_id, provider, operation_key)'],
  peakos_platform_salesperson_mappings_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_salesperson_mappings_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_salesperson_mappings_state_check: ['c', "CHECK ((mapping_state = ANY (ARRAY['active'::text, 'revoked'::text])))"],
  peakos_platform_salesperson_mappings_supersedes_check: ['c', 'CHECK ((((version = 1) AND (supersedes_id IS NULL)) OR ((version > 1) AND (supersedes_id IS NOT NULL))))'],
  peakos_platform_salesperson_mappings_supersedes_fk: ['f', 'FOREIGN KEY (workspace_id, provider, supersedes_id) REFERENCES peakos_platform_salesperson_mappings(workspace_id, provider, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  peakos_platform_salesperson_mappings_version_check: ['c', 'CHECK ((version > 0))'],
  peakos_platform_salesperson_mappings_version_unique: ['u', 'UNIQUE (workspace_id, provider, external_name_normalized, version)'],
  peakos_platform_salesperson_mappings_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_import_runs_actor_check: ['c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
  peakos_platform_import_runs_actor_name_check: ['c', 'CHECK ((char_length(actor_name_snapshot) <= 160))'],
  peakos_platform_import_runs_adapter_check: ['c', "CHECK ((adapter_version ~ '^[A-Za-z0-9:._/-]{1,120}$'::text))"],
  peakos_platform_import_runs_counts_check: ['c', 'CHECK (((requested_count >= 0) AND (inserted_count >= 0) AND (mapped_count >= 0) AND (unmapped_count >= 0) AND (ambiguous_count >= 0) AND (inserted_count <= requested_count) AND (((mapped_count + unmapped_count) + ambiguous_count) = requested_count)))'],
  peakos_platform_import_runs_coverage_check: ['c', 'CHECK ((covered_to >= covered_from))'],
  peakos_platform_import_runs_digest_check: ['c', "CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))"],
  peakos_platform_import_runs_error_check: ['c', "CHECK ((((status = 'failed'::text) AND (error_code IS NOT NULL) AND (error_code ~ '^[A-Z0-9_]{1,80}$'::text)) OR ((status = 'completed'::text) AND (error_code IS NULL))))"],
  peakos_platform_import_runs_idempotency_check: ['c', "CHECK ((idempotency_key ~ '^[A-Za-z0-9:._/-]{1,240}$'::text))"],
  peakos_platform_import_runs_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_import_runs_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_import_runs_snapshot_complete_check: ['c', 'CHECK (snapshot_complete)'],
  peakos_platform_import_runs_source_total_check: ['c', 'CHECK (((source_total_count >= 0) AND (source_total_count = requested_count)))'],
  peakos_platform_import_runs_status_check: ['c', "CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))"],
  peakos_platform_import_runs_time_check: ['c', 'CHECK ((completed_at >= started_at))'],
  peakos_platform_import_runs_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_transaction_events_attribution_check: ['c', "CHECK ((((attribution_status = 'mapped'::text) AND (owner_uid IS NOT NULL) AND (owner_name_snapshot IS NOT NULL) AND ((char_length(btrim(owner_name_snapshot)) >= 1) AND (char_length(btrim(owner_name_snapshot)) <= 160))) OR ((attribution_status = ANY (ARRAY['unmapped'::text, 'ambiguous'::text])) AND (owner_uid IS NULL) AND (owner_name_snapshot IS NULL))))"],
  peakos_platform_transaction_events_currency_check: ['c', "CHECK ((currency = 'KRW'::text))"],
  peakos_platform_transaction_events_external_id_check: ['c', 'CHECK (((char_length(btrim(external_transaction_id)) >= 1) AND (char_length(btrim(external_transaction_id)) <= 240)))'],
  peakos_platform_transaction_events_external_name_check: ['c', 'CHECK (((char_length(btrim(external_salesperson_name)) >= 1) AND (char_length(btrim(external_salesperson_name)) <= 160)))'],
  peakos_platform_transaction_events_fingerprint_check: ['c', "CHECK ((event_fingerprint ~ '^[0-9a-f]{64}$'::text))"],
  peakos_platform_transaction_events_import_fk: ['f', 'FOREIGN KEY (workspace_id, provider, import_run_id) REFERENCES peakos_platform_import_runs(workspace_id, provider, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  peakos_platform_transaction_events_normalized_name_check: ['c', 'CHECK (((char_length(external_name_normalized) >= 1) AND (char_length(external_name_normalized) <= 160)))'],
  peakos_platform_transaction_events_owner_membership_fk: ['f', OWNER_FK_DEFINITION],
  peakos_platform_transaction_events_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_transaction_events_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_transaction_events_state_check: ['c', "CHECK ((record_state = ANY (ARRAY['active'::text, 'voided'::text])))"],
  peakos_platform_transaction_events_voided_amount_check: ['c', "CHECK (((record_state <> 'voided'::text) OR ((sales_amount IS NULL) AND (profit_amount IS NULL))))"],
  peakos_platform_transaction_events_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_aggregate_runs_actor_check: ['c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
  peakos_platform_aggregate_runs_actor_name_check: ['c', 'CHECK ((char_length(actor_name_snapshot) <= 160))'],
  peakos_platform_aggregate_runs_adapter_check: ['c', "CHECK ((adapter_version ~ '^[A-Za-z0-9:._/-]{1,120}$'::text))"],
  peakos_platform_aggregate_runs_counts_check: ['c', 'CHECK (((source_total_count >= 0) AND (row_count >= 0) AND (mapped_count >= 0) AND (ambiguous_count >= 0) AND (global_unmatched_count >= 0) AND (source_excluded_count >= 0) AND ((mapped_count + ambiguous_count) = row_count) AND (((row_count + global_unmatched_count) + source_excluded_count) = source_total_count)))'],
  peakos_platform_aggregate_runs_coverage_check: ['c', "CHECK (((covered_to >= covered_from) AND (to_char((covered_from)::timestamp with time zone, 'YYYY-MM'::text) = settlement_month) AND (to_char((covered_to)::timestamp with time zone, 'YYYY-MM'::text) = settlement_month)))"],
  peakos_platform_aggregate_runs_digest_check: ['c', "CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))"],
  peakos_platform_aggregate_runs_idempotency_check: ['c', "CHECK ((idempotency_key ~ '^[A-Za-z0-9:._/-]{1,240}$'::text))"],
  peakos_platform_aggregate_runs_month_check: ['c', "CHECK ((settlement_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'::text))"],
  peakos_platform_aggregate_runs_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_aggregate_runs_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_aggregate_runs_source_drift_check: ['c', "CHECK (((source_drift IS NULL) OR ((source_drift >= ('-9007199254740991'::bigint)::numeric) AND (source_drift <= ('9007199254740991'::bigint)::numeric))))"],
  peakos_platform_aggregate_runs_source_state_check: ['c', "CHECK ((source_state = ANY (ARRAY['live'::text, 'draft'::text, 'paid'::text, 'unknown'::text])))"],
  peakos_platform_aggregate_runs_status_check: ['c', "CHECK ((status = 'completed'::text))"],
  peakos_platform_aggregate_runs_time_check: ['c', 'CHECK ((completed_at >= observed_at))'],
  peakos_platform_aggregate_runs_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_aggregate_rows_amount_range_check: ['c', "CHECK ((((sales_amount IS NULL) OR ((sales_amount >= ('-9007199254740991'::bigint)::numeric) AND (sales_amount <= ('9007199254740991'::bigint)::numeric))) AND ((profit_amount IS NULL) OR ((profit_amount >= ('-9007199254740991'::bigint)::numeric) AND (profit_amount <= ('9007199254740991'::bigint)::numeric)))))"],
  peakos_platform_aggregate_rows_attribution_check: ['c', "CHECK ((((attribution_status = 'mapped'::text) AND (owner_uid IS NOT NULL) AND (owner_name_snapshot IS NOT NULL) AND ((char_length(btrim(owner_name_snapshot)) >= 1) AND (char_length(btrim(owner_name_snapshot)) <= 160)) AND (attribution_issue_code IS NULL) AND (attribution_issue_detail IS NULL)) OR ((attribution_status = 'unmapped'::text) AND (owner_uid IS NULL) AND (owner_name_snapshot IS NULL) AND (attribution_issue_code IS NULL) AND (attribution_issue_detail IS NULL)) OR ((attribution_status = 'ambiguous'::text) AND (owner_uid IS NULL) AND (owner_name_snapshot IS NULL) AND (sales_amount IS NULL) AND (profit_amount IS NULL) AND (attribution_issue_code IS NOT NULL) AND (attribution_issue_code ~ '^[A-Z0-9_]{1,80}$'::text) AND (attribution_issue_detail IS NOT NULL) AND ((char_length(btrim(attribution_issue_detail)) >= 1) AND (char_length(btrim(attribution_issue_detail)) <= 500)))))"],
  peakos_platform_aggregate_rows_currency_check: ['c', "CHECK ((currency = 'KRW'::text))"],
  peakos_platform_aggregate_rows_external_key_check: ['c', "CHECK ((external_row_key ~ '^[A-Za-z0-9:._/-]{1,240}$'::text))"],
  peakos_platform_aggregate_rows_external_name_check: ['c', 'CHECK (((char_length(btrim(external_salesperson_name)) >= 1) AND (char_length(btrim(external_salesperson_name)) <= 160)))'],
  peakos_platform_aggregate_rows_keyword_profit_check: ['c', "CHECK (((provider <> 'keywordmaster'::text) OR ((profit_amount IS NULL) AND (profit_basis = 'unavailable'::text))))"],
  peakos_platform_aggregate_rows_normalized_name_check: ['c', 'CHECK (((char_length(external_name_normalized) >= 1) AND (char_length(external_name_normalized) <= 160)))'],
  peakos_platform_aggregate_rows_owner_membership_fk: ['f', OWNER_FK_DEFINITION],
  peakos_platform_aggregate_rows_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_aggregate_rows_profit_availability_check: ['c', "CHECK (((profit_basis <> 'unavailable'::text) OR (profit_amount IS NULL)))"],
  peakos_platform_aggregate_rows_profit_basis_check: ['c', "CHECK ((profit_basis = ANY (ARRAY['reward_distributor_margin'::text, 'review_spread_profit'::text, 'unavailable'::text])))"],
  peakos_platform_aggregate_rows_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_aggregate_rows_run_fk: ['f', 'FOREIGN KEY (workspace_id, provider, snapshot_run_id) REFERENCES peakos_platform_aggregate_runs(workspace_id, provider, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  peakos_platform_aggregate_rows_run_unique: ['u', 'UNIQUE (workspace_id, provider, snapshot_run_id, external_row_key)'],
  peakos_platform_aggregate_rows_source_count_check: ['c', 'CHECK (((source_record_count IS NULL) OR (source_record_count >= 0)))'],
  peakos_platform_aggregate_rows_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],

  peakos_platform_aggregate_quarantines_actor_check: ['c', 'CHECK (((char_length(btrim(actor_uid)) >= 1) AND (char_length(btrim(actor_uid)) <= 200)))'],
  peakos_platform_aggregate_quarantines_actor_name_check: ['c', 'CHECK (((char_length(btrim(actor_name_snapshot)) >= 1) AND (char_length(btrim(actor_name_snapshot)) <= 160)))'],
  peakos_platform_aggregate_quarantines_expected_latest_check: ['c', 'CHECK ((expected_latest_run_id = aggregate_run_id))'],
  peakos_platform_aggregate_quarantines_operation_check: ['c', "CHECK ((operation_key ~ '^[A-Za-z0-9:._/-]{1,240}$'::text))"],
  peakos_platform_aggregate_quarantines_operation_unique: ['u', 'UNIQUE (workspace_id, provider, operation_key)'],
  peakos_platform_aggregate_quarantines_pkey: ['p', 'PRIMARY KEY (workspace_id, provider, id)'],
  peakos_platform_aggregate_quarantines_provider_check: ['c', PROVIDER_CHECK_DEFINITION],
  peakos_platform_aggregate_quarantines_reason_check: ['c', 'CHECK (((char_length(btrim(reason)) >= 8) AND (char_length(btrim(reason)) <= 500)))'],
  peakos_platform_aggregate_quarantines_run_fk: ['f', 'FOREIGN KEY (workspace_id, provider, aggregate_run_id) REFERENCES peakos_platform_aggregate_runs(workspace_id, provider, id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  peakos_platform_aggregate_quarantines_run_unique: ['u', 'UNIQUE (workspace_id, provider, aggregate_run_id)'],
  peakos_platform_aggregate_quarantines_workspace_fk: ['f', WORKSPACE_FK_DEFINITION],
});
const REQUIRED_CONSTRAINTS = Object.freeze(Object.keys(REQUIRED_CONSTRAINT_DEFINITIONS));
const REQUIRED_INDEX_DEFINITIONS = Object.freeze({
  peakos_platform_import_runs_idempotency_uidx: Object.freeze({
    table: 'peakos_platform_import_runs',
    unique: true,
    definition: 'CREATE UNIQUE INDEX peakos_platform_import_runs_idempotency_uidx ON public.peakos_platform_import_runs USING btree (workspace_id, provider, idempotency_key)',
    predicate: '',
  }),
  peakos_platform_import_runs_latest_idx: Object.freeze({
    table: 'peakos_platform_import_runs',
    unique: false,
    definition: "CREATE INDEX peakos_platform_import_runs_latest_idx ON public.peakos_platform_import_runs USING btree (workspace_id, provider, completed_at DESC, id DESC) WHERE (status = 'completed'::text)",
    predicate: "(status = 'completed'::text)",
  }),
  peakos_platform_transaction_events_current_idx: Object.freeze({
    table: 'peakos_platform_transaction_events',
    unique: false,
    definition: 'CREATE INDEX peakos_platform_transaction_events_current_idx ON public.peakos_platform_transaction_events USING btree (workspace_id, provider, external_transaction_id, source_updated_at DESC, imported_at DESC, id DESC)',
    predicate: '',
  }),
  peakos_platform_transaction_events_fingerprint_uidx: Object.freeze({
    table: 'peakos_platform_transaction_events',
    unique: true,
    definition: 'CREATE UNIQUE INDEX peakos_platform_transaction_events_fingerprint_uidx ON public.peakos_platform_transaction_events USING btree (workspace_id, provider, event_fingerprint)',
    predicate: '',
  }),
  peakos_platform_transaction_events_self_month_idx: Object.freeze({
    table: 'peakos_platform_transaction_events',
    unique: false,
    definition: "CREATE INDEX peakos_platform_transaction_events_self_month_idx ON public.peakos_platform_transaction_events USING btree (workspace_id, owner_uid, business_date, provider) WHERE (attribution_status = 'mapped'::text)",
    predicate: "(attribution_status = 'mapped'::text)",
  }),
  peakos_platform_aggregate_runs_idempotency_uidx: Object.freeze({
    table: 'peakos_platform_aggregate_runs',
    unique: true,
    definition: 'CREATE UNIQUE INDEX peakos_platform_aggregate_runs_idempotency_uidx ON public.peakos_platform_aggregate_runs USING btree (workspace_id, provider, idempotency_key)',
    predicate: '',
  }),
  peakos_platform_aggregate_runs_identity_uidx: Object.freeze({
    table: 'peakos_platform_aggregate_runs',
    unique: true,
    definition: 'CREATE UNIQUE INDEX peakos_platform_aggregate_runs_identity_uidx ON public.peakos_platform_aggregate_runs USING btree (workspace_id, provider, settlement_month, source_digest, adapter_version)',
    predicate: '',
  }),
  peakos_platform_aggregate_runs_latest_idx: Object.freeze({
    table: 'peakos_platform_aggregate_runs',
    unique: false,
    definition: "CREATE INDEX peakos_platform_aggregate_runs_latest_idx ON public.peakos_platform_aggregate_runs USING btree (workspace_id, provider, settlement_month, completed_at DESC, id DESC) WHERE (status = 'completed'::text)",
    predicate: "(status = 'completed'::text)",
  }),
  peakos_platform_aggregate_rows_self_idx: Object.freeze({
    table: 'peakos_platform_aggregate_rows',
    unique: false,
    definition: 'CREATE INDEX peakos_platform_aggregate_rows_self_idx ON public.peakos_platform_aggregate_rows USING btree (workspace_id, provider, snapshot_run_id, external_name_normalized)',
    predicate: '',
  }),
});
const REQUIRED_INDEXES = Object.freeze(Object.keys(REQUIRED_INDEX_DEFINITIONS));
const APPEND_ONLY_TABLES = Object.freeze(Object.keys(REQUIRED_COLUMNS));
const APPEND_ONLY_FUNCTION_SOURCE = `
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
`.trim();

class PlatformSettlementError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'PlatformSettlementError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, code, statusCode = 400) {
  throw new PlatformSettlementError(message, code, statusCode);
}

function cleanText(value, maxLength, field) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) {
    fail(`${field} 값이 올바르지 않습니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  return text;
}

function normalizeExactName(value) {
  return String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function validDateKey(value) {
  const text = String(value || '');
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatKstDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dbDateKey(value) {
  if (value instanceof Date) return formatKstDate(value);
  return String(value || '').slice(0, 10);
}

function monthBounds(month, now = new Date()) {
  const value = String(month || formatKstDate(now).slice(0, 7));
  if (!MONTH_PATTERN.test(value)) {
    fail('조회 월은 YYYY-MM 형식이어야 합니다.', 'MONTHLY_SETTLEMENT_MONTH_INVALID', 400);
  }
  const [year, monthNumber] = value.split('-').map(Number);
  const from = `${value}-01`;
  const nextDate = new Date(Date.UTC(year, monthNumber, 1));
  const next = nextDate.toISOString().slice(0, 10);
  const to = shiftDateKey(next, -1);
  const today = formatKstDate(now);
  const coverageRequiredThrough = today >= from && today <= to ? today : to;
  return { month: value, from, to, next, coverageRequiredThrough };
}

function validProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!PROVIDER_SET.has(provider)) {
    fail('지원하지 않는 플랫폼입니다.', 'PLATFORM_PROVIDER_INVALID', 400);
  }
  return provider;
}

function validSimpleIdentifier(value, maxLength, field) {
  const text = cleanText(value, maxLength, field);
  if (!IDENTIFIER_PATTERN.test(text)) {
    fail(`${field} 값이 올바르지 않습니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  return text;
}

function normalizeWon(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    fail(`${field}은 원 단위 정수여야 합니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    fail(`${field} 금액이 안전한 범위를 벗어났습니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  return String(number);
}

function normalizeSignedInteger(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    fail(`${field}는 정수여야 합니다.`, 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    fail(`${field}가 안전한 범위를 벗어났습니다.`, 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  return String(number);
}

function normalizeTimestamp(value, field) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    fail(`${field}에는 시간대가 포함된 시각이 필요합니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    fail(`${field} 시각이 올바르지 않습니다.`, 'PLATFORM_IMPORT_INVALID', 400);
  }
  return parsed.toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizedTransaction(provider, row, coveredFrom, coveredTo) {
  const externalTransactionId = cleanText(row?.externalTransactionId, 240, '외부 거래 ID');
  const sourceUpdatedAt = normalizeTimestamp(row?.sourceUpdatedAt, '외부 수정 시각');
  const businessDate = String(row?.businessDate || '');
  if (!validDateKey(businessDate) || businessDate < coveredFrom || businessDate > coveredTo) {
    fail('거래일이 올바르지 않거나 수집 범위를 벗어났습니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }
  const externalSalespersonName = cleanText(row?.externalSalespersonName, 160, '외부 영업자명');
  const externalNameNormalized = normalizeExactName(externalSalespersonName);
  if (!externalNameNormalized || externalNameNormalized.length > 160) {
    fail('외부 영업자명이 올바르지 않습니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }
  const recordState = String(row?.recordState || 'active');
  if (!['active', 'voided'].includes(recordState)) {
    fail('거래 상태가 올바르지 않습니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }
  const salesAmount = recordState === 'voided' ? null : normalizeWon(row?.salesAmount, '매출');
  const profitAmount = recordState === 'voided' ? null : normalizeWon(row?.profitAmount, '영업이익');
  const canonical = {
    provider,
    externalTransactionId,
    sourceUpdatedAt,
    businessDate,
    externalSalespersonName,
    externalNameNormalized,
    recordState,
    salesAmount,
    profitAmount,
  };
  return { ...canonical, eventFingerprint: sha256(JSON.stringify(canonical)) };
}

function normalizeNonNegativeCount(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${field}은 0 이상의 안전한 정수여야 합니다.`, 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  return value;
}

function normalizeAggregateSourceRow(provider, row) {
  const externalRowKey = validSimpleIdentifier(row?.externalRowKey, 240, '외부 집계 행 키');
  const externalSalespersonName = cleanText(row?.externalSalespersonName, 160, '외부 영업자명');
  const externalNameNormalized = normalizeExactName(externalSalespersonName);
  if (!externalNameNormalized || externalNameNormalized.length > 160) {
    fail('외부 영업자명이 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const profitBasis = String(row?.profitBasis || '');
  if (!AGGREGATE_PROFIT_BASES.has(profitBasis)) {
    fail('영업이익 산정 기준이 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const salesAmount = normalizeWon(row?.salesAmount, '매출');
  const profitAmount = normalizeWon(row?.profitAmount, '영업이익');
  if (profitBasis === 'unavailable' && profitAmount !== null) {
    fail('영업이익 미제공 행에는 영업이익 금액을 저장할 수 없습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  if (provider === 'keywordmaster' && (profitAmount !== null || profitBasis !== 'unavailable')) {
    fail('키워드마스터 커미션은 영업이익으로 저장할 수 없습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const sourceRecordCount = normalizeNonNegativeCount(
    row?.sourceRecordCount,
    '원본 레코드 수',
    { nullable: true },
  );
  let preassigned = null;
  const hasPreassignment = row?.attributionStatus !== undefined
    || row?.ownerUid !== undefined
    || row?.ownerNameSnapshot !== undefined;
  if (hasPreassignment) {
    if (row?.attributionStatus !== 'mapped') {
      fail('사전 귀속 행은 mapped 상태만 허용합니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
    }
    preassigned = {
      uid: cleanText(row?.ownerUid, 200, '사전 귀속 UID'),
      name: cleanText(row?.ownerNameSnapshot, 160, '사전 귀속 계정명'),
    };
  }
  return {
    externalRowKey,
    externalSalespersonName,
    externalNameNormalized,
    salesAmount,
    profitAmount,
    profitBasis,
    sourceRecordCount,
    preassigned,
  };
}

function normalizeAggregateAttributionIssue(issue) {
  const externalRowKey = validSimpleIdentifier(issue?.externalRowKey, 240, '모호한 집계 행 키');
  const externalSalespersonName = cleanText(issue?.externalSalespersonName, 160, '모호한 외부 영업자명');
  const externalNameNormalized = normalizeExactName(externalSalespersonName);
  if (!externalNameNormalized || externalNameNormalized.length > 160) {
    fail('모호한 외부 영업자명이 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  if (issue?.salesAmount !== undefined || issue?.profitAmount !== undefined
      || issue?.ownerUid !== undefined || issue?.ownerNameSnapshot !== undefined) {
    fail('모호한 귀속 이슈에는 금액이나 대상 계정을 넣을 수 없습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const issueCode = String(issue?.issueCode || 'EXACT_NAME_AMBIGUOUS').trim();
  if (!ISSUE_CODE_PATTERN.test(issueCode)) {
    fail('귀속 이슈 코드가 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const issueDetail = cleanText(
    issue?.issueDetail || '동명이인 또는 원본 식별자 모호성으로 자동 귀속하지 않았습니다.',
    500,
    '귀속 이슈 설명',
  );
  return {
    externalRowKey,
    externalSalespersonName,
    externalNameNormalized,
    issueCode,
    issueDetail,
  };
}

function normalizedAggregateSnapshotPayload({
  provider: providerInput,
  month: monthInput,
  coveredFrom: coveredFromInput,
  coveredTo: coveredToInput,
  sourceTotalCount: sourceTotalCountInput,
  globalUnmatchedCount: globalUnmatchedCountInput = 0,
  sourceExcludedCount: sourceExcludedCountInput = 0,
  rows: inputRows,
  attributionIssues: inputIssues = [],
  sourceState: sourceStateInput = 'unknown',
  sourceDrift: sourceDriftInput = null,
} = {}) {
  const provider = validProvider(providerInput);
  const month = String(monthInput || '');
  if (!MONTH_PATTERN.test(month)) {
    fail('집계 월은 YYYY-MM 형식이어야 합니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const coveredFrom = String(coveredFromInput || '');
  const coveredTo = String(coveredToInput || '');
  if (!validDateKey(coveredFrom) || !validDateKey(coveredTo)
      || coveredFrom > coveredTo || coveredFrom.slice(0, 7) !== month
      || coveredTo.slice(0, 7) !== month || coveredFrom !== `${month}-01`) {
    fail('월별 집계 coverage가 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  if (!Array.isArray(inputRows) || !Array.isArray(inputIssues)
      || inputRows.length + inputIssues.length > 10000) {
    fail('한 번에 저장할 집계 행과 이슈는 합계 10,000건 이하여야 합니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const sourceTotalCount = normalizeNonNegativeCount(sourceTotalCountInput, '원본 전체 건수');
  const globalUnmatchedCount = normalizeNonNegativeCount(
    globalUnmatchedCountInput,
    '글로벌 미귀속 건수',
  );
  const sourceExcludedCount = normalizeNonNegativeCount(
    sourceExcludedCountInput,
    '원본 제외 건수',
  );
  const sourceState = String(sourceStateInput || 'unknown').toLowerCase();
  if (!AGGREGATE_SOURCE_STATES.has(sourceState)) {
    fail('원본 정산 상태가 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const sourceDrift = normalizeSignedInteger(sourceDriftInput, '원본 drift');
  const rows = inputRows.map(row => normalizeAggregateSourceRow(provider, row));
  const attributionIssues = inputIssues.map(normalizeAggregateAttributionIssue);
  if (sourceTotalCount !== rows.length + attributionIssues.length
      + globalUnmatchedCount + sourceExcludedCount) {
    fail(
      '원본 전체 건수와 귀속·모호·글로벌 미귀속·제외 행 수 합계가 일치해야 합니다.',
      'PLATFORM_AGGREGATE_SOURCE_COUNT_MISMATCH',
      400,
    );
  }
  const keys = [...rows, ...attributionIssues].map(row => row.externalRowKey);
  if (new Set(keys).size !== keys.length) {
    fail('월별 집계 스냅샷에 중복 외부 행 키가 있습니다.', 'PLATFORM_AGGREGATE_DUPLICATE_ROWS', 400);
  }
  const canonicalRows = rows.map(row => ({
    externalRowKey: row.externalRowKey,
    externalSalespersonName: row.externalSalespersonName,
    externalNameNormalized: row.externalNameNormalized,
    salesAmount: row.salesAmount,
    profitAmount: row.profitAmount,
    profitBasis: row.profitBasis,
    sourceRecordCount: row.sourceRecordCount,
    preassigned: row.preassigned,
  })).sort((left, right) => left.externalRowKey.localeCompare(right.externalRowKey));
  const canonicalIssues = attributionIssues.map(issue => ({
    externalRowKey: issue.externalRowKey,
    externalSalespersonName: issue.externalSalespersonName,
    externalNameNormalized: issue.externalNameNormalized,
    issueCode: issue.issueCode,
    issueDetail: issue.issueDetail,
  })).sort((left, right) => left.externalRowKey.localeCompare(right.externalRowKey));
  const canonical = {
    provider, month, coveredFrom, coveredTo, sourceTotalCount, globalUnmatchedCount,
    sourceExcludedCount,
    sourceState, sourceDrift, rows: canonicalRows, attributionIssues: canonicalIssues,
  };
  return {
    ...canonical,
    rows,
    attributionIssues,
    sourceDigest: sha256(JSON.stringify(canonical)),
  };
}

function calculatePlatformMonthlyAggregateDigest(payload) {
  return normalizedAggregateSnapshotPayload(payload).sourceDigest;
}

function tableColumnRows() {
  return Object.entries(REQUIRED_COLUMN_DEFINITIONS).flatMap(([tableName, columns]) => (
    Object.entries(columns).map(([columnName, [type, notNull, defaultExpression]]) => (
      [tableName, columnName, type, notNull, defaultExpression]
    ))
  ));
}

function normalizedSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function ensurePeakosPlatformSettlementInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query가 필요합니다.');
  const required = tableColumnRows();
  const params = [];
  const values = required.map(([tableName, columnName, type, notNull, defaultExpression]) => {
    params.push(tableName, columnName, type, notNull, defaultExpression);
    return `($${params.length - 4}::text,$${params.length - 3}::text,$${params.length - 2}::text,$${params.length - 1}::boolean,$${params.length}::text)`;
  });
  const missingColumns = await pool.query(
    `WITH required(table_name, column_name, data_type, is_not_null, default_expression) AS (VALUES ${values.join(',')})
     SELECT required.table_name, required.column_name
       FROM required
       LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
       LEFT JOIN pg_class relation
         ON relation.relnamespace = namespace.oid
        AND relation.relname = required.table_name
        AND relation.relkind IN ('r','p')
       LEFT JOIN pg_attribute actual
         ON actual.attrelid = relation.oid
        AND actual.attname = required.column_name
        AND actual.attnum > 0
        AND NOT actual.attisdropped
       LEFT JOIN pg_attrdef column_default
         ON column_default.adrelid = relation.oid
        AND column_default.adnum = actual.attnum
      WHERE actual.attnum IS NULL
         OR format_type(actual.atttypid, actual.atttypmod) <> required.data_type
         OR actual.attnotnull <> required.is_not_null
         OR COALESCE(pg_get_expr(column_default.adbin, column_default.adrelid), '') <> required.default_expression
      ORDER BY 1, 2`,
    params,
  );
  if (missingColumns.rows.length) {
    const detail = missingColumns.rows.slice(0, 8)
      .map(row => `${row.table_name}.${row.column_name}`).join(', ');
    const error = new Error(`플랫폼 월 정산 migration이 필요합니다: ${detail}`);
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED';
    throw error;
  }

  const constraints = await pool.query(
    `SELECT constraint_catalog.conname, constraint_catalog.contype,
            constraint_catalog.convalidated,
            relation.relname AS table_name,
            pg_get_constraintdef(constraint_catalog.oid) AS definition
       FROM pg_constraint constraint_catalog
       JOIN pg_class relation ON relation.oid = constraint_catalog.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE constraint_catalog.conname = ANY($1::text[])
        AND namespace.nspname = 'public'`,
    [REQUIRED_CONSTRAINTS],
  );
  const foundConstraints = new Map(constraints.rows.map(row => [row.conname, row]));
  const missingConstraints = REQUIRED_CONSTRAINTS.filter(name => {
    const row = foundConstraints.get(name);
    const [expectedType, expectedDefinition] = REQUIRED_CONSTRAINT_DEFINITIONS[name];
    const expectedTable = APPEND_ONLY_TABLES.find(table => name.startsWith(`${table}_`));
    return !row
      || row.table_name !== expectedTable
      || String(row.contype) !== expectedType
      || row.convalidated !== true
      || normalizedSql(row.definition) !== normalizedSql(expectedDefinition);
  });
  if (missingConstraints.length) {
    const error = new Error(`플랫폼 월 정산 constraint가 누락되었습니다: ${missingConstraints.slice(0, 8).join(', ')}`);
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED';
    throw error;
  }

  const triggerNames = APPEND_ONLY_TABLES.flatMap(table => [
    `${table}_no_mutation`, `${table}_no_truncate`,
  ]);
  const triggers = await pool.query(
    `SELECT trigger_table.relname AS table_name, pg_trigger.tgname, pg_trigger.tgtype,
            pg_trigger.tgenabled, pg_trigger.tgdeferrable, pg_trigger.tginitdeferred,
            pg_trigger.tgconstraint, pg_trigger.tgqual, pg_trigger.tgnargs,
            octet_length(pg_trigger.tgargs) AS args_length, pg_trigger.tgattr::text AS trigger_attributes,
            pg_get_triggerdef(pg_trigger.oid) AS definition,
            function_namespace.nspname AS function_schema,
            trigger_function.proname AS function_name,
            trigger_function.pronargs AS function_args,
            trigger_function.prorettype = 'trigger'::regtype AS returns_trigger,
            trigger_function.prokind, trigger_function.provolatile, trigger_function.prosecdef,
            trigger_language.lanname AS function_language, trigger_function.prosrc AS function_source
       FROM pg_trigger
       JOIN pg_class trigger_table ON trigger_table.oid = pg_trigger.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = trigger_table.relnamespace
       JOIN pg_proc trigger_function ON trigger_function.oid = pg_trigger.tgfoid
       JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
       JOIN pg_language trigger_language ON trigger_language.oid = trigger_function.prolang
      WHERE namespace.nspname = 'public'
        AND pg_trigger.tgname = ANY($1::text[])
        AND NOT pg_trigger.tgisinternal`,
    [triggerNames],
  );
  const foundTriggers = new Map(triggers.rows.map(row => [row.tgname, row]));
  const invalidTriggers = triggerNames.filter(name => {
    const row = foundTriggers.get(name);
    const expectedType = name.endsWith('_no_truncate') ? 34 : 27;
    const tableName = name.replace(/_no_(?:mutation|truncate)$/, '');
    const expectedDefinition = name.endsWith('_no_truncate')
      ? `CREATE TRIGGER ${name} BEFORE TRUNCATE ON public.${tableName} FOR EACH STATEMENT EXECUTE FUNCTION peakos_platform_reject_mutation()`
      : `CREATE TRIGGER ${name} BEFORE DELETE OR UPDATE ON public.${tableName} FOR EACH ROW EXECUTE FUNCTION peakos_platform_reject_mutation()`;
    return !row
      || row.table_name !== tableName
      || Number(row.tgtype) !== expectedType
      || row.tgenabled !== 'O'
      || row.tgdeferrable !== false
      || row.tginitdeferred !== false
      || Number(row.tgconstraint) !== 0
      || row.tgqual !== null
      || Number(row.tgnargs) !== 0
      || Number(row.args_length) !== 0
      || String(row.trigger_attributes || '') !== ''
      || normalizedSql(row.definition) !== normalizedSql(expectedDefinition)
      || row.function_schema !== 'public'
      || row.function_name !== 'peakos_platform_reject_mutation'
      || Number(row.function_args) !== 0
      || row.returns_trigger !== true
      || row.prokind !== 'f'
      || row.provolatile !== 'v'
      || row.prosecdef !== false
      || row.function_language !== 'plpgsql'
      || normalizedSql(row.function_source) !== normalizedSql(APPEND_ONLY_FUNCTION_SOURCE);
  });
  if (invalidTriggers.length) {
    const error = new Error(`플랫폼 월 정산 append-only trigger가 누락·변경되었습니다: ${invalidTriggers.slice(0, 8).join(', ')}`);
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED';
    throw error;
  }

  const indexes = await pool.query(
    `SELECT index_relation.relname AS index_name, table_relation.relname AS table_name,
            catalog.indisunique, catalog.indisprimary, catalog.indisexclusion,
            catalog.indisvalid, catalog.indisready, catalog.indislive,
            pg_get_indexdef(catalog.indexrelid) AS definition,
            COALESCE(pg_get_expr(catalog.indpred, catalog.indrelid), '') AS predicate
       FROM pg_index catalog
       JOIN pg_class index_relation ON index_relation.oid = catalog.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = catalog.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_relation.relname = ANY($1::text[])`,
    [REQUIRED_INDEXES],
  );
  const foundIndexes = new Map(indexes.rows.map(row => [row.index_name, row]));
  const invalidIndexes = REQUIRED_INDEXES.filter(name => {
    const row = foundIndexes.get(name);
    const expected = REQUIRED_INDEX_DEFINITIONS[name];
    return !row
      || row.table_name !== expected.table
      || row.indisunique !== expected.unique
      || row.indisprimary !== false
      || row.indisexclusion !== false
      || row.indisvalid !== true
      || row.indisready !== true
      || row.indislive !== true
      || normalizedSql(row.definition) !== normalizedSql(expected.definition)
      || normalizedSql(row.predicate) !== normalizedSql(expected.predicate);
  });
  if (invalidIndexes.length) {
    const error = new Error(`플랫폼 월 정산 index가 누락·변경되었습니다: ${invalidIndexes.join(', ')}`);
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_MIGRATION_REQUIRED';
    throw error;
  }

  const publicGrants = await pool.query(
    `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND grantee = 'PUBLIC'
        AND table_name = ANY($1::text[])`,
    [APPEND_ONLY_TABLES],
  );
  if (publicGrants.rows.length) {
    const error = new Error('플랫폼 월 정산 테이블에 PUBLIC 권한이 남아 있습니다.');
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_ACL_INVALID';
    throw error;
  }
  const runtimePrivileges = await pool.query(
    `SELECT runtime.rolname, runtime.rolsuper, runtime.rolbypassrls,
            required.table_name,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'SELECT') AS can_select,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'INSERT') AS can_insert,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'UPDATE') AS can_update,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'DELETE') AS can_delete,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'TRUNCATE') AS can_truncate,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'REFERENCES') AS can_reference,
            has_table_privilege(runtime.oid, to_regclass('public.' || required.table_name), 'TRIGGER') AS can_trigger,
            has_function_privilege(
              runtime.oid, to_regprocedure('public.peakos_platform_reject_mutation()'), 'EXECUTE'
            ) AS can_execute_guard
       FROM pg_roles runtime
       CROSS JOIN unnest($1::text[]) AS required(table_name)
      WHERE runtime.rolname = current_user
      ORDER BY required.table_name`,
    [APPEND_ONLY_TABLES],
  );
  const unsafeRuntime = runtimePrivileges.rows.length !== APPEND_ONLY_TABLES.length
    || runtimePrivileges.rows.some(row => (
      row.rolsuper === true
      || row.rolbypassrls === true
      || row.can_select !== true
      || row.can_insert !== true
      || row.can_update !== false
      || row.can_delete !== false
      || row.can_truncate !== false
      || row.can_reference !== false
      || row.can_trigger !== false
      || row.can_execute_guard !== false
    ));
  if (unsafeRuntime) {
    const error = new Error('플랫폼 월 정산 runtime role 권한이 안전한 append-only 계약과 다릅니다.');
    error.code = 'PEAKOS_PLATFORM_SETTLEMENT_ACL_INVALID';
    throw error;
  }
  return true;
}

function safeActor(actor = {}) {
  return {
    uid: cleanText(actor.uid, 200, '작업자 UID'),
    name: String(actor.name || '').trim().slice(0, 160),
  };
}

function mappingFromRow(row) {
  if (!row || row.mapping_state !== 'active' || !row.owner_uid) return null;
  return {
    uid: String(row.owner_uid),
    name: String(row.owner_name_snapshot || ''),
    matchMethod: String(row.match_method || 'exact_name'),
  };
}

async function exactNameAttributions(client, workspaceId, provider, transactions, actor) {
  const names = [...new Set(transactions.map(row => row.externalNameNormalized))];
  if (!names.length) return new Map();
  const stored = await client.query(
    `SELECT DISTINCT ON (external_name_normalized)
            external_name_normalized, mapping_state, match_method, owner_uid, owner_name_snapshot
       FROM public.peakos_platform_salesperson_mappings
      WHERE workspace_id = $1 AND provider = $2
        AND external_name_normalized = ANY($3::text[])
      ORDER BY external_name_normalized, version DESC, created_at DESC, id DESC`,
    [workspaceId, provider, names],
  );
  const current = new Map(stored.rows.map(row => [row.external_name_normalized, row]));
  const members = await client.query(
    `SELECT users.uid, users.name
       FROM public.peakos_workspaces workspace
       JOIN public.peakos_workspace_memberships membership
         ON membership.workspace_id = workspace.id
       JOIN public.users ON users.uid = membership.user_uid
      WHERE workspace.id = $1
        AND workspace.active = TRUE
        AND membership.active = TRUE
        AND membership.role IN ('admin','manager','member')
        AND users.approved = TRUE
        AND COALESCE(users.is_active, TRUE) = TRUE
        AND COALESCE(users.chat_only, FALSE) = FALSE
        AND COALESCE(users.external_calendar_only, FALSE) = FALSE
      ORDER BY users.uid
      FOR SHARE OF workspace, users, membership`,
    [workspaceId],
  );
  const candidatesByName = new Map();
  const eligibleByUid = new Map();
  for (const member of members.rows) {
    const normalized = normalizeExactName(member.name);
    eligibleByUid.set(String(member.uid), { uid: String(member.uid), name: String(member.name || ''), normalized });
    const candidates = candidatesByName.get(normalized) || [];
    candidates.push({ uid: String(member.uid), name: String(member.name || '') });
    candidatesByName.set(normalized, candidates);
  }

  const result = new Map();
  for (const name of names) {
    if (current.has(name)) {
      const mapping = mappingFromRow(current.get(name));
      const eligible = mapping ? eligibleByUid.get(mapping.uid) : null;
      const candidates = candidatesByName.get(name) || [];
      // A pin is never silently moved.  If its account is inactive/restricted,
      // left the workspace, or no longer has the exact source name, new rows
      // remain unattributed until an explicit versioned correction is added.
      const currentNameAllowed = mapping?.matchMethod === 'manual_correction'
        || (
          eligible?.normalized === name
          && candidates.length === 1
          && candidates[0].uid === mapping?.uid
        );
      result.set(name, mapping && eligible && currentNameAllowed
        ? { status: 'mapped', ...mapping }
        : { status: candidates.length > 1 ? 'ambiguous' : 'unmapped' });
      continue;
    }
    const candidates = candidatesByName.get(name) || [];
    if (candidates.length !== 1) {
      result.set(name, { status: candidates.length ? 'ambiguous' : 'unmapped' });
      continue;
    }
    const candidate = candidates[0];
    const sourceName = transactions.find(row => row.externalNameNormalized === name)?.externalSalespersonName || name;
    const id = crypto.randomUUID();
    const operationKey = `auto:${sha256(name)}`;
    const inserted = await client.query(
      `INSERT INTO public.peakos_platform_salesperson_mappings
        (workspace_id,provider,id,version,supersedes_id,operation_key,external_name_normalized,
         external_name_snapshot,owner_uid,owner_name_snapshot,mapping_state,match_method,
         correction_reason,actor_uid,actor_name_snapshot)
       VALUES ($1,$2,$3,1,NULL,$4,$5,$6,$7,$8,'active','exact_name',NULL,$9,$10)
       ON CONFLICT (workspace_id,provider,operation_key) DO NOTHING
       RETURNING owner_uid, owner_name_snapshot, mapping_state, match_method`,
      [
        workspaceId, provider, id, operationKey, name, sourceName,
        candidate.uid, candidate.name, actor.uid, actor.name,
      ],
    );
    let pinned = inserted.rows[0];
    if (!pinned) {
      const raced = await client.query(
        `SELECT mapping_state, match_method, owner_uid, owner_name_snapshot
           FROM public.peakos_platform_salesperson_mappings
          WHERE workspace_id = $1 AND provider = $2 AND external_name_normalized = $3
          ORDER BY version DESC, created_at DESC, id DESC LIMIT 1`,
        [workspaceId, provider, name],
      );
      pinned = raced.rows[0];
    }
    const mapping = mappingFromRow(pinned);
    result.set(name, mapping ? { status: 'mapped', ...mapping } : { status: 'unmapped' });
  }
  return result;
}

// Internal/operator-only correction primitive. It appends a mapping version;
// imported facts are never rewritten. Self reads resolve the latest mapping at
// query time, so a correction/revoke has an auditable, reversible successor.
async function correctPlatformSalespersonMapping({
  pool,
  workspaceId,
  provider: providerInput,
  externalSalespersonName,
  ownerUid: ownerUidInput,
  mappingState: mappingStateInput = 'active',
  idempotencyKey: idempotencyKeyInput,
  reason: reasonInput,
  actor: actorInput,
  now = new Date(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const selectedWorkspace = cleanText(workspaceId, 120, '워크스페이스');
  const provider = validProvider(providerInput);
  const externalNameSnapshot = cleanText(externalSalespersonName, 160, '외부 영업자명');
  const externalNameNormalized = normalizeExactName(externalNameSnapshot);
  const mappingState = String(mappingStateInput || '');
  if (!['active', 'revoked'].includes(mappingState)) {
    fail('매핑 상태가 올바르지 않습니다.', 'PLATFORM_MAPPING_INVALID', 400);
  }
  const ownerUid = mappingState === 'active' ? cleanText(ownerUidInput, 200, '대상 UID') : null;
  if (mappingState === 'revoked' && ownerUidInput !== undefined && ownerUidInput !== null && ownerUidInput !== '') {
    fail('매핑 해제에는 대상 UID를 지정할 수 없습니다.', 'PLATFORM_MAPPING_INVALID', 400);
  }
  const correctionKey = validSimpleIdentifier(idempotencyKeyInput, 200, '교정 멱등성 키');
  const operationKey = `manual:${correctionKey}`;
  const reason = cleanText(reasonInput, 500, '교정 사유');
  if (reason.length < 8) fail('교정 사유는 8자 이상이어야 합니다.', 'PLATFORM_MAPPING_INVALID', 400);
  const actor = safeActor(actorInput);
  const createdAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(createdAt.getTime())) {
    fail('교정 시각이 올바르지 않습니다.', 'PLATFORM_MAPPING_INVALID', 400);
  }
  const matchMethod = mappingState === 'active' ? 'manual_correction' : 'manual_revoke';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `peakos-platform-import-v1:${selectedWorkspace}:${provider}`,
    ]);
    const activeWorkspace = await client.query(
      `SELECT id FROM public.peakos_workspaces
        WHERE id = $1 AND active = TRUE
        FOR SHARE`,
      [selectedWorkspace],
    );
    if (activeWorkspace.rows.length !== 1) {
      fail('활성 워크스페이스의 매핑만 교정할 수 있습니다.', 'PLATFORM_WORKSPACE_UNAVAILABLE', 403);
    }

    const replay = await client.query(
      `SELECT id, version, external_name_normalized, mapping_state, match_method,
              owner_uid, owner_name_snapshot, correction_reason
         FROM public.peakos_platform_salesperson_mappings
        WHERE workspace_id = $1 AND provider = $2 AND operation_key = $3`,
      [selectedWorkspace, provider, operationKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.external_name_normalized !== externalNameNormalized
          || row.mapping_state !== mappingState
          || row.match_method !== matchMethod
          || String(row.owner_uid || '') !== String(ownerUid || '')
          || row.correction_reason !== reason) {
        fail('같은 교정 멱등성 키에 다른 매핑을 사용할 수 없습니다.', 'PLATFORM_MAPPING_IDEMPOTENCY_CONFLICT', 409);
      }
      await client.query('COMMIT');
      return {
        duplicate: true,
        id: String(row.id),
        version: Number(row.version),
        mappingState,
        ownerUid,
      };
    }

    const latest = await client.query(
      `SELECT id, version
         FROM public.peakos_platform_salesperson_mappings
        WHERE workspace_id = $1 AND provider = $2 AND external_name_normalized = $3
        ORDER BY version DESC, created_at DESC, id DESC
        LIMIT 1
        FOR SHARE`,
      [selectedWorkspace, provider, externalNameNormalized],
    );
    if (!latest.rows[0] && mappingState === 'revoked') {
      fail('교정할 기존 exact-name 매핑이 없습니다.', 'PLATFORM_MAPPING_NOT_FOUND', 404);
    }

    let ownerName = null;
    if (mappingState === 'active') {
      const eligible = await client.query(
        `SELECT users.name
           FROM public.peakos_workspaces workspace
           JOIN public.peakos_workspace_memberships membership
             ON membership.workspace_id = workspace.id
           JOIN public.users ON users.uid = membership.user_uid
          WHERE workspace.id = $1 AND workspace.active = TRUE
            AND membership.user_uid = $2
            AND membership.active = TRUE
            AND membership.role IN ('admin','manager','member')
            AND users.approved = TRUE
            AND COALESCE(users.is_active, TRUE) = TRUE
            AND COALESCE(users.chat_only, FALSE) = FALSE
            AND COALESCE(users.external_calendar_only, FALSE) = FALSE
          FOR SHARE OF workspace, users, membership`,
        [selectedWorkspace, ownerUid],
      );
      if (eligible.rows.length !== 1) {
        fail('활성 direct 계정만 매핑 대상으로 지정할 수 있습니다.', 'PLATFORM_MAPPING_OWNER_INELIGIBLE', 422);
      }
      ownerName = String(eligible.rows[0].name || '').trim();
      if (!ownerName) fail('대상 계정 이름이 없습니다.', 'PLATFORM_MAPPING_OWNER_INELIGIBLE', 422);
    }

    const id = crypto.randomUUID();
    const version = latest.rows[0] ? Number(latest.rows[0].version) + 1 : 1;
    const supersedesId = latest.rows[0]?.id || null;
    await client.query(
      `INSERT INTO public.peakos_platform_salesperson_mappings
        (workspace_id,provider,id,version,supersedes_id,operation_key,
         external_name_normalized,external_name_snapshot,owner_uid,owner_name_snapshot,
         mapping_state,match_method,correction_reason,actor_uid,actor_name_snapshot,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        selectedWorkspace, provider, id, version, supersedesId, operationKey,
        externalNameNormalized, externalNameSnapshot, ownerUid, ownerName,
        mappingState, matchMethod, reason, actor.uid, actor.name, createdAt.toISOString(),
      ],
    );
    await client.query('COMMIT');
    return { duplicate: false, id, version, mappingState, ownerUid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function importPlatformTransactionBatch({
  pool,
  workspaceId,
  provider: providerInput,
  idempotencyKey: idempotencyInput,
  sourceDigest: sourceDigestInput,
  adapterVersion: adapterVersionInput,
  coveredFrom: coveredFromInput,
  coveredTo: coveredToInput,
  sourceTotalCount: sourceTotalCountInput,
  snapshotComplete,
  transactions: inputRows,
  actor: actorInput,
  now = new Date(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const selectedWorkspace = cleanText(workspaceId, 120, '워크스페이스');
  const provider = validProvider(providerInput);
  const idempotencyKey = validSimpleIdentifier(idempotencyInput, 240, '멱등성 키');
  const adapterVersion = validSimpleIdentifier(adapterVersionInput, 120, '어댑터 버전');
  const coveredFrom = String(coveredFromInput || '');
  const coveredTo = String(coveredToInput || '');
  if (!validDateKey(coveredFrom) || !validDateKey(coveredTo) || coveredFrom > coveredTo) {
    fail('수집 범위가 올바르지 않습니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }
  if (!Array.isArray(inputRows) || inputRows.length > 10000) {
    fail('한 번에 가져올 거래는 10,000건 이하여야 합니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }
  if (snapshotComplete !== true) {
    fail(
      '전체 페이지 수집이 끝난 완전한 스냅샷만 정산 coverage로 확정할 수 있습니다.',
      'PLATFORM_IMPORT_SNAPSHOT_INCOMPLETE',
      400,
    );
  }
  if (!Number.isSafeInteger(sourceTotalCountInput) || sourceTotalCountInput < 0
      || sourceTotalCountInput !== inputRows.length) {
    fail('원본 전체 건수와 전달된 스냅샷 건수가 일치하지 않습니다.', 'PLATFORM_IMPORT_SOURCE_COUNT_MISMATCH', 400);
  }
  const actor = safeActor(actorInput);
  const normalized = inputRows.map(row => normalizedTransaction(provider, row, coveredFrom, coveredTo));
  const uniqueByFingerprint = new Map(normalized.map(row => [row.eventFingerprint, row]));
  if (uniqueByFingerprint.size !== normalized.length) {
    fail('완전한 원본 스냅샷에 중복 거래 행이 있습니다.', 'PLATFORM_IMPORT_DUPLICATE_SOURCE_ROWS', 400);
  }
  const transactions = [...uniqueByFingerprint.values()];
  const calculatedDigest = sha256(transactions.map(row => row.eventFingerprint).sort().join('\n'));
  const sourceDigest = sourceDigestInput === undefined || sourceDigestInput === null || sourceDigestInput === ''
    ? calculatedDigest : String(sourceDigestInput).trim().toLowerCase();
  if (!DIGEST_PATTERN.test(sourceDigest) || sourceDigest !== calculatedDigest) {
    fail('원본 digest가 정규화된 거래 묶음과 일치하지 않습니다.', 'PLATFORM_IMPORT_DIGEST_MISMATCH', 400);
  }
  const completedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(completedAt.getTime())) {
    fail('수집 완료 시각이 올바르지 않습니다.', 'PLATFORM_IMPORT_INVALID', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `peakos-platform-import-v1:${selectedWorkspace}:${provider}`,
    ]);
    const activeWorkspace = await client.query(
      `SELECT id
         FROM public.peakos_workspaces
        WHERE id = $1 AND active = TRUE
        FOR SHARE`,
      [selectedWorkspace],
    );
    if (activeWorkspace.rows.length !== 1) {
      fail('활성 워크스페이스에만 플랫폼 정산을 가져올 수 있습니다.', 'PLATFORM_WORKSPACE_UNAVAILABLE', 403);
    }
    const duplicate = await client.query(
      `SELECT id, source_digest, adapter_version, source_total_count, snapshot_complete,
              requested_count, inserted_count, mapped_count, unmapped_count, ambiguous_count,
              covered_from::text AS covered_from, covered_to::text AS covered_to, completed_at
         FROM public.peakos_platform_import_runs
        WHERE workspace_id = $1 AND provider = $2 AND idempotency_key = $3`,
      [selectedWorkspace, provider, idempotencyKey],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].source_digest !== sourceDigest
          || duplicate.rows[0].adapter_version !== adapterVersion
          || Number(duplicate.rows[0].source_total_count) !== sourceTotalCountInput
          || duplicate.rows[0].snapshot_complete !== true
          || dbDateKey(duplicate.rows[0].covered_from) !== coveredFrom
          || dbDateKey(duplicate.rows[0].covered_to) !== coveredTo) {
        fail('같은 멱등성 키에 다른 원본이나 수집 범위를 사용할 수 없습니다.', 'PLATFORM_IMPORT_IDEMPOTENCY_CONFLICT', 409);
      }
      await client.query('COMMIT');
      return {
        duplicate: true,
        runId: String(duplicate.rows[0].id),
        requestedCount: Number(duplicate.rows[0].requested_count),
        sourceTotalCount: Number(duplicate.rows[0].source_total_count),
        insertedCount: Number(duplicate.rows[0].inserted_count),
        mappedCount: Number(duplicate.rows[0].mapped_count),
        unmappedCount: Number(duplicate.rows[0].unmapped_count),
        ambiguousCount: Number(duplicate.rows[0].ambiguous_count),
      };
    }

    const byRevision = new Map();
    for (const row of transactions) {
      const revisionKey = `${row.externalTransactionId}\u0000${row.sourceUpdatedAt}`;
      const previous = byRevision.get(revisionKey);
      if (previous && previous !== row.eventFingerprint) {
        fail('같은 거래 수정 시각에 서로 다른 값이 있습니다.', 'PLATFORM_TRANSACTION_REVISION_CONFLICT', 409);
      }
      byRevision.set(revisionKey, row.eventFingerprint);
    }
    if (transactions.length) {
      const existingRevisions = await client.query(
        `SELECT external_transaction_id, source_updated_at, event_fingerprint
           FROM public.peakos_platform_transaction_events
          WHERE workspace_id = $1 AND provider = $2
            AND external_transaction_id = ANY($3::text[])`,
        [selectedWorkspace, provider, [...new Set(transactions.map(row => row.externalTransactionId))]],
      );
      for (const row of existingRevisions.rows) {
        const revisionKey = `${row.external_transaction_id}\u0000${new Date(row.source_updated_at).toISOString()}`;
        const incoming = byRevision.get(revisionKey);
        if (incoming && incoming !== row.event_fingerprint) {
          fail('이미 저장된 거래 revision과 원본이 충돌합니다.', 'PLATFORM_TRANSACTION_REVISION_CONFLICT', 409);
        }
      }
    }

    // A completed coverage run is an adapter-aggregated full snapshot, never a
    // page. Previously active IDs in the covered range may disappear only via
    // an explicit newer `voided` row in the incoming snapshot. Without vendor
    // contracts it is unsafe to infer deletion or silently keep stale payroll.
    const previousActive = await client.query(
      `WITH ranked AS (
         SELECT external_transaction_id, source_updated_at, business_date, record_state,
                ROW_NUMBER() OVER (
                  PARTITION BY workspace_id, provider, external_transaction_id
                  ORDER BY source_updated_at DESC, imported_at DESC, id DESC
                ) AS revision_rank
           FROM public.peakos_platform_transaction_events
          WHERE workspace_id = $1 AND provider = $2
       )
       SELECT external_transaction_id, source_updated_at
         FROM ranked
        WHERE revision_rank = 1
          AND record_state = 'active'
          AND business_date >= $3::date AND business_date <= $4::date
        ORDER BY external_transaction_id`,
      [selectedWorkspace, provider, coveredFrom, coveredTo],
    );
    const incomingLatestById = new Map();
    for (const row of transactions) {
      const current = incomingLatestById.get(row.externalTransactionId);
      if (!current || row.sourceUpdatedAt > current.sourceUpdatedAt) {
        incomingLatestById.set(row.externalTransactionId, row);
      }
    }
    const missingTombstones = previousActive.rows
      .filter(previous => {
        const externalId = String(previous.external_transaction_id || '');
        const incoming = incomingLatestById.get(externalId);
        if (!externalId || !incoming) return true;
        if (incoming.recordState !== 'voided') return false;
        return new Date(incoming.sourceUpdatedAt).getTime()
          <= new Date(previous.source_updated_at).getTime();
      })
      .map(row => String(row.external_transaction_id || ''));
    if (missingTombstones.length) {
      fail(
        '기존 활성 거래가 완전 스냅샷에서 사라졌습니다. 더 최신의 명시적 voided revision이 필요합니다.',
        'PLATFORM_IMPORT_MISSING_TOMBSTONE',
        409,
      );
    }
    const staleSnapshotIds = previousActive.rows
      .filter(previous => {
        const incoming = incomingLatestById.get(String(previous.external_transaction_id || ''));
        return incoming
          && new Date(incoming.sourceUpdatedAt).getTime()
            < new Date(previous.source_updated_at).getTime();
      })
      .map(row => String(row.external_transaction_id || ''));
    if (staleSnapshotIds.length) {
      fail(
        '완전 스냅샷에 이미 저장된 revision보다 오래된 거래가 포함되어 있습니다.',
        'PLATFORM_IMPORT_STALE_SNAPSHOT',
        409,
      );
    }

    const attributions = await exactNameAttributions(client, selectedWorkspace, provider, transactions, actor);
    const attributed = transactions.map(row => ({
      ...row,
      attribution: attributions.get(row.externalNameNormalized) || { status: 'unmapped' },
    }));
    const mappedCount = attributed.filter(row => row.attribution.status === 'mapped').length;
    const ambiguousCount = attributed.filter(row => row.attribution.status === 'ambiguous').length;
    const unmappedCount = attributed.length - mappedCount - ambiguousCount;
    const knownFingerprints = attributed.length
      ? await client.query(
        `SELECT event_fingerprint
           FROM public.peakos_platform_transaction_events
          WHERE workspace_id = $1 AND provider = $2
            AND event_fingerprint = ANY($3::text[])`,
        [selectedWorkspace, provider, attributed.map(row => row.eventFingerprint)],
      ) : { rows: [] };
    const known = new Set(knownFingerprints.rows.map(row => row.event_fingerprint));
    const toInsert = attributed.filter(row => !known.has(row.eventFingerprint));
    const runId = crypto.randomUUID();
    const startedAt = completedAt.toISOString();
    await client.query(
      `INSERT INTO public.peakos_platform_import_runs
        (workspace_id,provider,id,idempotency_key,source_digest,adapter_version,status,
         covered_from,covered_to,source_total_count,snapshot_complete,requested_count,
         inserted_count,mapped_count,unmapped_count,ambiguous_count,actor_uid,
         actor_name_snapshot,error_code,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,TRUE,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$16)`,
      [
        selectedWorkspace, provider, runId, idempotencyKey, sourceDigest, adapterVersion,
        coveredFrom, coveredTo, sourceTotalCountInput, toInsert.length, mappedCount, unmappedCount,
        ambiguousCount, actor.uid, actor.name, startedAt,
      ],
    );
    for (const row of toInsert) {
      const mapping = row.attribution.status === 'mapped' ? row.attribution : null;
      await client.query(
        `INSERT INTO public.peakos_platform_transaction_events
          (workspace_id,provider,id,import_run_id,external_transaction_id,event_fingerprint,
           source_updated_at,business_date,external_salesperson_name,external_name_normalized,
           attribution_status,owner_uid,owner_name_snapshot,record_state,sales_amount,profit_amount,currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'KRW')`,
        [
          selectedWorkspace, provider, crypto.randomUUID(), runId, row.externalTransactionId,
          row.eventFingerprint, row.sourceUpdatedAt, row.businessDate, row.externalSalespersonName,
          row.externalNameNormalized, row.attribution.status, mapping?.uid || null,
          mapping?.name || null, row.recordState, row.salesAmount, row.profitAmount,
        ],
      );
    }
    await client.query('COMMIT');
    return {
      duplicate: false,
      runId,
      requestedCount: attributed.length,
      sourceTotalCount: sourceTotalCountInput,
      insertedCount: toInsert.length,
      mappedCount,
      unmappedCount,
      ambiguousCount,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Aggregate-only vendors do not expose stable transaction revisions. Each
// callback therefore appends one complete monthly response as an immutable run
// and the self read selects that run as a whole.
async function importPlatformMonthlyAggregateSnapshot({
  pool,
  workspaceId,
  provider,
  month,
  coveredFrom,
  coveredTo,
  sourceTotalCount,
  globalUnmatchedCount = 0,
  sourceExcludedCount = 0,
  rows,
  attributionIssues = [],
  sourceState = 'unknown',
  sourceDrift = null,
  idempotencyKey: idempotencyInput,
  sourceDigest: sourceDigestInput,
  adapterVersion: adapterVersionInput,
  actor: actorInput,
  observedAt: observedAtInput,
  now = new Date(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const selectedWorkspace = cleanText(workspaceId, 120, '워크스페이스');
  const normalized = normalizedAggregateSnapshotPayload({
    provider,
    month,
    coveredFrom,
    coveredTo,
    sourceTotalCount,
    globalUnmatchedCount,
    sourceExcludedCount,
    rows,
    attributionIssues,
    sourceState,
    sourceDrift,
  });
  const idempotencyKey = validSimpleIdentifier(idempotencyInput, 240, '멱등성 키');
  const adapterVersion = validSimpleIdentifier(adapterVersionInput, 120, '어댑터 버전');
  const suppliedDigest = sourceDigestInput === undefined || sourceDigestInput === null
    || sourceDigestInput === '' ? normalized.sourceDigest : String(sourceDigestInput).trim().toLowerCase();
  if (!DIGEST_PATTERN.test(suppliedDigest) || suppliedDigest !== normalized.sourceDigest) {
    fail('원본 digest가 정규화된 월별 집계와 일치하지 않습니다.', 'PLATFORM_AGGREGATE_DIGEST_MISMATCH', 400);
  }
  const actor = safeActor(actorInput);
  const observedAt = normalizeTimestamp(observedAtInput, '원본 관측 시각');
  const completedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(completedAt.getTime()) || new Date(observedAt).getTime() > completedAt.getTime()) {
    fail('집계 완료 시각 또는 원본 관측 시각이 올바르지 않습니다.', 'PLATFORM_AGGREGATE_INVALID', 400);
  }
  const completedAtIso = completedAt.toISOString();
  const expectedRowCount = normalized.rows.length + normalized.attributionIssues.length;
  const expectedMappedCount = normalized.rows.length;
  const expectedAmbiguousCount = normalized.attributionIssues.length;

  function duplicateResult(row) {
    return {
      duplicate: true,
      runId: String(row.id),
      month: normalized.month,
      sourceTotalCount: Number(row.source_total_count),
      rowCount: Number(row.row_count),
      mappedCount: Number(row.mapped_count),
      ambiguousCount: Number(row.ambiguous_count),
      globalUnmatchedCount: Number(row.global_unmatched_count),
      sourceExcludedCount: Number(row.source_excluded_count),
      sourceState: String(row.source_state),
      sourceDrift: row.source_drift === null ? null : numericOut(row.source_drift, '원본 drift'),
    };
  }

  function duplicateMatches(row) {
    return row.source_digest === suppliedDigest
      && row.adapter_version === adapterVersion
      && row.settlement_month === normalized.month
      && dbDateKey(row.covered_from) === normalized.coveredFrom
      && dbDateKey(row.covered_to) === normalized.coveredTo
      && Number(row.source_total_count) === normalized.sourceTotalCount
      && Number(row.row_count) === expectedRowCount
      && Number(row.mapped_count) === expectedMappedCount
      && Number(row.ambiguous_count) === expectedAmbiguousCount
      && Number(row.global_unmatched_count) === normalized.globalUnmatchedCount
      && Number(row.source_excluded_count) === normalized.sourceExcludedCount
      && row.source_state === normalized.sourceState
      && String(row.source_drift ?? '') === String(normalized.sourceDrift ?? '');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `peakos-platform-aggregate-v1:${selectedWorkspace}:${normalized.provider}:${normalized.month}`,
    ]);
    const activeWorkspace = await client.query(
      `SELECT id
         FROM public.peakos_workspaces
        WHERE id = $1 AND active = TRUE
        FOR SHARE`,
      [selectedWorkspace],
    );
    if (activeWorkspace.rows.length !== 1) {
      fail('활성 워크스페이스에만 플랫폼 집계를 가져올 수 있습니다.', 'PLATFORM_WORKSPACE_UNAVAILABLE', 403);
    }

    const byIdempotency = await client.query(
      `SELECT id, settlement_month, covered_from::text AS covered_from,
              covered_to::text AS covered_to, source_digest, adapter_version,
              source_total_count, row_count, mapped_count, ambiguous_count,
              global_unmatched_count, source_excluded_count, source_state, source_drift
         FROM public.peakos_platform_aggregate_runs
        WHERE workspace_id = $1 AND provider = $2 AND idempotency_key = $3`,
      [selectedWorkspace, normalized.provider, idempotencyKey],
    );
    if (byIdempotency.rows[0]) {
      if (!duplicateMatches(byIdempotency.rows[0])) {
        fail(
          '같은 집계 멱등성 키에 다른 원본이나 수집 범위를 사용할 수 없습니다.',
          'PLATFORM_AGGREGATE_IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      await client.query('COMMIT');
      return duplicateResult(byIdempotency.rows[0]);
    }

    const identical = await client.query(
      `SELECT id, settlement_month, covered_from::text AS covered_from,
              covered_to::text AS covered_to, source_digest, adapter_version,
              source_total_count, row_count, mapped_count, ambiguous_count,
              global_unmatched_count, source_excluded_count, source_state, source_drift
         FROM public.peakos_platform_aggregate_runs
        WHERE workspace_id = $1 AND provider = $2 AND settlement_month = $3
          AND source_digest = $4 AND adapter_version = $5
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
      [selectedWorkspace, normalized.provider, normalized.month, suppliedDigest, adapterVersion],
    );
    if (identical.rows[0]) {
      if (!duplicateMatches(identical.rows[0])) {
        fail('같은 집계 원본 identity가 다른 메타데이터와 충돌합니다.', 'PLATFORM_AGGREGATE_IDENTITY_CONFLICT', 409);
      }
      await client.query('COMMIT');
      return duplicateResult(identical.rows[0]);
    }

    const attributions = await exactNameAttributions(
      client,
      selectedWorkspace,
      normalized.provider,
      normalized.rows,
      actor,
    );
    const attributedRows = normalized.rows.map(row => ({
      ...row,
      attribution: attributions.get(row.externalNameNormalized) || { status: 'unmapped' },
    }));
    for (const row of attributedRows) {
      if (row.attribution.status !== 'mapped') {
        fail(
          '일반 집계 행은 워크스페이스의 유일한 exact-name 계정에 귀속되어야 합니다.',
          'PLATFORM_AGGREGATE_ATTRIBUTION_UNRESOLVED',
          422,
        );
      }
      if (row.preassigned && (
        row.attribution.matchMethod !== 'exact_name'
        || row.attribution.uid !== row.preassigned.uid
        || normalizeExactName(row.attribution.name) !== normalizeExactName(row.preassigned.name)
      )) {
        fail(
          '사전 귀속 정보가 현재 워크스페이스의 유일한 exact-name 계정과 다릅니다.',
          'PLATFORM_AGGREGATE_PREASSIGNMENT_CONFLICT',
          409,
        );
      }
    }

    const runId = crypto.randomUUID();
    await client.query(
      `INSERT INTO public.peakos_platform_aggregate_runs
        (workspace_id,provider,id,settlement_month,status,covered_from,covered_to,
         idempotency_key,source_digest,adapter_version,source_total_count,row_count,
         mapped_count,ambiguous_count,global_unmatched_count,source_state,source_drift,
         source_excluded_count,observed_at,actor_uid,actor_name_snapshot,completed_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        selectedWorkspace, normalized.provider, runId, normalized.month,
        normalized.coveredFrom, normalized.coveredTo, idempotencyKey, suppliedDigest,
        adapterVersion, normalized.sourceTotalCount, expectedRowCount, expectedMappedCount,
        expectedAmbiguousCount, normalized.globalUnmatchedCount, normalized.sourceState,
        normalized.sourceDrift, normalized.sourceExcludedCount, observedAt,
        actor.uid, actor.name, completedAtIso,
      ],
    );
    for (const row of attributedRows) {
      await client.query(
        `INSERT INTO public.peakos_platform_aggregate_rows
          (workspace_id,provider,id,snapshot_run_id,external_row_key,
           external_salesperson_name,external_name_normalized,attribution_status,
           owner_uid,owner_name_snapshot,sales_amount,profit_amount,profit_basis,
           source_record_count,attribution_issue_code,attribution_issue_detail,currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'mapped',$8,$9,$10,$11,$12,$13,NULL,NULL,'KRW')`,
        [
          selectedWorkspace, normalized.provider, crypto.randomUUID(), runId,
          row.externalRowKey, row.externalSalespersonName, row.externalNameNormalized,
          row.attribution.uid, row.attribution.name, row.salesAmount, row.profitAmount,
          row.profitBasis, row.sourceRecordCount,
        ],
      );
    }
    for (const issue of normalized.attributionIssues) {
      await client.query(
        `INSERT INTO public.peakos_platform_aggregate_rows
          (workspace_id,provider,id,snapshot_run_id,external_row_key,
           external_salesperson_name,external_name_normalized,attribution_status,
           owner_uid,owner_name_snapshot,sales_amount,profit_amount,profit_basis,
           source_record_count,attribution_issue_code,attribution_issue_detail,currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ambiguous',NULL,NULL,NULL,NULL,'unavailable',
                 NULL,$8,$9,'KRW')`,
        [
          selectedWorkspace, normalized.provider, crypto.randomUUID(), runId,
          issue.externalRowKey, issue.externalSalespersonName, issue.externalNameNormalized,
          issue.issueCode, issue.issueDetail,
        ],
      );
    }
    await client.query('COMMIT');
    return {
      duplicate: false,
      runId,
      month: normalized.month,
      sourceTotalCount: normalized.sourceTotalCount,
      rowCount: expectedRowCount,
      mappedCount: expectedMappedCount,
      ambiguousCount: expectedAmbiguousCount,
      globalUnmatchedCount: normalized.globalUnmatchedCount,
      sourceExcludedCount: normalized.sourceExcludedCount,
      sourceState: normalized.sourceState,
      sourceDrift: normalized.sourceDrift === null
        ? null : numericOut(normalized.sourceDrift, '원본 drift'),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function validUuid(value, field) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    fail(`${field} 값이 올바르지 않습니다.`, 'PLATFORM_AGGREGATE_QUARANTINE_INVALID', 400);
  }
  return text;
}

function aggregateQuarantineScope({ workspaceId, provider, month } = {}) {
  const selectedWorkspace = cleanText(workspaceId, 120, '워크스페이스');
  const selectedProvider = validProvider(provider);
  const selectedMonth = String(month || '').trim();
  if (!MONTH_PATTERN.test(selectedMonth)) {
    fail('격리 월은 YYYY-MM 형식이어야 합니다.', 'PLATFORM_AGGREGATE_QUARANTINE_INVALID', 400);
  }
  return { selectedWorkspace, selectedProvider, selectedMonth };
}

// Operator-only primitive. The CLI is the sole production surface for this
// function: browser/self routes never receive a mutation handler. It shares the
// aggregate importer lock and performs a latest-visible-run CAS before appending
// the immutable quarantine audit row.
async function quarantinePlatformMonthlyAggregateRun({
  pool,
  workspaceId,
  provider,
  month,
  runId: runIdInput,
  expectedLatestRunId: expectedLatestRunIdInput,
  operationKey: operationKeyInput,
  reason: reasonInput,
  actor: actorInput,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const { selectedWorkspace, selectedProvider, selectedMonth } = aggregateQuarantineScope({
    workspaceId, provider, month,
  });
  const runId = validUuid(runIdInput, '격리 run ID');
  const expectedLatestRunId = validUuid(expectedLatestRunIdInput, '예상 최신 run ID');
  if (runId !== expectedLatestRunId) {
    fail(
      '격리 run ID와 예상 최신 run ID가 같아야 합니다.',
      'PLATFORM_AGGREGATE_QUARANTINE_INVALID',
      400,
    );
  }
  const operationKey = validSimpleIdentifier(operationKeyInput, 240, '격리 operation key');
  const reason = cleanText(reasonInput, 500, '격리 사유');
  if (reason.length < 8) {
    fail('격리 사유는 8자 이상이어야 합니다.', 'PLATFORM_AGGREGATE_QUARANTINE_INVALID', 400);
  }
  const actor = safeActor(actorInput);
  if (!actor.name) {
    fail('격리 작업자 이름이 필요합니다.', 'PLATFORM_AGGREGATE_QUARANTINE_INVALID', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `peakos-platform-aggregate-v1:${selectedWorkspace}:${selectedProvider}:${selectedMonth}`,
    ]);
    const activeWorkspace = await client.query(
      `SELECT id
         FROM public.peakos_workspaces
        WHERE id = $1 AND active = TRUE
        FOR SHARE`,
      [selectedWorkspace],
    );
    if (activeWorkspace.rows.length !== 1) {
      fail(
        '활성 워크스페이스의 집계 run만 격리할 수 있습니다.',
        'PLATFORM_WORKSPACE_UNAVAILABLE',
        403,
      );
    }

    const replay = await client.query(
      `SELECT quarantine.id, quarantine.aggregate_run_id,
              quarantine.expected_latest_run_id, quarantine.operation_key,
              quarantine.reason, quarantine.actor_uid,
              quarantine.actor_name_snapshot, quarantine.created_at,
              aggregate_run.settlement_month
         FROM public.peakos_platform_aggregate_quarantines quarantine
         JOIN public.peakos_platform_aggregate_runs aggregate_run
           ON aggregate_run.workspace_id = quarantine.workspace_id
          AND aggregate_run.provider = quarantine.provider
          AND aggregate_run.id = quarantine.aggregate_run_id
        WHERE quarantine.workspace_id = $1
          AND quarantine.provider = $2
          AND quarantine.operation_key = $3`,
      [selectedWorkspace, selectedProvider, operationKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (String(row.aggregate_run_id).toLowerCase() !== runId
          || String(row.expected_latest_run_id).toLowerCase() !== expectedLatestRunId
          || String(row.settlement_month) !== selectedMonth
          || String(row.reason) !== reason
          || String(row.actor_uid) !== actor.uid
          || String(row.actor_name_snapshot) !== actor.name) {
        fail(
          '같은 operation key에 다른 격리 요청을 사용할 수 없습니다.',
          'PLATFORM_AGGREGATE_QUARANTINE_IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      await client.query('COMMIT');
      return {
        duplicate: true,
        quarantineId: String(row.id),
        workspaceId: selectedWorkspace,
        provider: selectedProvider,
        month: selectedMonth,
        runId,
        createdAt: new Date(row.created_at).toISOString(),
      };
    }

    const target = await client.query(
      `SELECT id, settlement_month
         FROM public.peakos_platform_aggregate_runs
        WHERE workspace_id = $1 AND provider = $2 AND id = $3
          AND status = 'completed'
        FOR SHARE`,
      [selectedWorkspace, selectedProvider, runId],
    );
    if (!target.rows[0] || String(target.rows[0].settlement_month) !== selectedMonth) {
      fail(
        '지정한 워크스페이스·플랫폼·월의 완료 집계 run을 찾을 수 없습니다.',
        'PLATFORM_AGGREGATE_QUARANTINE_RUN_NOT_FOUND',
        404,
      );
    }

    const latestVisible = await client.query(
      `SELECT aggregate_run.id
         FROM public.peakos_platform_aggregate_runs aggregate_run
        WHERE aggregate_run.workspace_id = $1
          AND aggregate_run.provider = $2
          AND aggregate_run.settlement_month = $3
          AND aggregate_run.status = 'completed'
          AND NOT EXISTS (
            SELECT 1
              FROM public.peakos_platform_aggregate_quarantines quarantine
             WHERE quarantine.workspace_id = aggregate_run.workspace_id
               AND quarantine.provider = aggregate_run.provider
               AND quarantine.aggregate_run_id = aggregate_run.id
          )
        ORDER BY aggregate_run.completed_at DESC, aggregate_run.id DESC
        LIMIT 1
        FOR SHARE OF aggregate_run`,
      [selectedWorkspace, selectedProvider, selectedMonth],
    );
    if (!latestVisible.rows[0]
        || String(latestVisible.rows[0].id).toLowerCase() !== expectedLatestRunId) {
      fail(
        '최신 격리 가능 run이 확인 이후 변경되었습니다. 다시 조회해 확인해야 합니다.',
        'PLATFORM_AGGREGATE_QUARANTINE_LATEST_CHANGED',
        409,
      );
    }

    const quarantineId = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO public.peakos_platform_aggregate_quarantines
        (workspace_id,provider,id,aggregate_run_id,operation_key,expected_latest_run_id,
         reason,actor_uid,actor_name_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING created_at`,
      [
        selectedWorkspace, selectedProvider, quarantineId, runId, operationKey,
        expectedLatestRunId, reason, actor.uid, actor.name,
      ],
    );
    await client.query('COMMIT');
    return {
      duplicate: false,
      quarantineId,
      workspaceId: selectedWorkspace,
      provider: selectedProvider,
      month: selectedMonth,
      runId,
      createdAt: new Date(inserted.rows[0].created_at).toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function inspectLatestPlatformMonthlyAggregateRun({
  pool,
  workspaceId,
  provider,
  month,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  const { selectedWorkspace, selectedProvider, selectedMonth } = aggregateQuarantineScope({
    workspaceId, provider, month,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const activeWorkspace = await client.query(
      `SELECT id FROM public.peakos_workspaces
        WHERE id = $1 AND active = TRUE`,
      [selectedWorkspace],
    );
    if (activeWorkspace.rows.length !== 1) {
      fail('활성 워크스페이스만 조회할 수 있습니다.', 'PLATFORM_WORKSPACE_UNAVAILABLE', 403);
    }
    const summary = await client.query(
      `SELECT COUNT(*)::int AS aggregate_run_count,
              COUNT(quarantine.aggregate_run_id)::int AS quarantined_run_count
         FROM public.peakos_platform_aggregate_runs aggregate_run
         LEFT JOIN public.peakos_platform_aggregate_quarantines quarantine
           ON quarantine.workspace_id = aggregate_run.workspace_id
          AND quarantine.provider = aggregate_run.provider
          AND quarantine.aggregate_run_id = aggregate_run.id
        WHERE aggregate_run.workspace_id = $1
          AND aggregate_run.provider = $2
          AND aggregate_run.settlement_month = $3
          AND aggregate_run.status = 'completed'`,
      [selectedWorkspace, selectedProvider, selectedMonth],
    );
    const latest = await client.query(
      `SELECT aggregate_run.id, aggregate_run.covered_from::text AS covered_from,
              aggregate_run.covered_to::text AS covered_to,
              aggregate_run.source_state, aggregate_run.observed_at,
              aggregate_run.completed_at
         FROM public.peakos_platform_aggregate_runs aggregate_run
        WHERE aggregate_run.workspace_id = $1
          AND aggregate_run.provider = $2
          AND aggregate_run.settlement_month = $3
          AND aggregate_run.status = 'completed'
          AND NOT EXISTS (
            SELECT 1
              FROM public.peakos_platform_aggregate_quarantines quarantine
             WHERE quarantine.workspace_id = aggregate_run.workspace_id
               AND quarantine.provider = aggregate_run.provider
               AND quarantine.aggregate_run_id = aggregate_run.id
          )
        ORDER BY aggregate_run.completed_at DESC, aggregate_run.id DESC
        LIMIT 1`,
      [selectedWorkspace, selectedProvider, selectedMonth],
    );
    await client.query('COMMIT');
    const aggregateRunCount = Number(summary.rows[0]?.aggregate_run_count || 0);
    const quarantinedRunCount = Number(summary.rows[0]?.quarantined_run_count || 0);
    const row = latest.rows[0];
    return {
      workspaceId: selectedWorkspace,
      provider: selectedProvider,
      month: selectedMonth,
      aggregateRunCount,
      quarantinedRunCount,
      allQuarantined: aggregateRunCount > 0 && aggregateRunCount === quarantinedRunCount,
      latestEligibleRun: row ? {
        runId: String(row.id),
        coveredFrom: dbDateKey(row.covered_from),
        coveredTo: dbDateKey(row.covered_to),
        sourceState: String(row.source_state || 'unknown'),
        observedAt: new Date(row.observed_at).toISOString(),
        completedAt: new Date(row.completed_at).toISOString(),
      } : null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function numericOut(value, field) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) {
    const error = new Error(`${field} 합계가 안전한 숫자 범위를 벗어났습니다.`);
    error.code = 'PLATFORM_SETTLEMENT_AMOUNT_RANGE';
    throw error;
  }
  return number;
}

function coverageState(runs, from, through) {
  const intervals = runs
    .map(run => ({ from: dbDateKey(run.covered_from), to: dbDateKey(run.covered_to) }))
    .filter(range => validDateKey(range.from) && validDateKey(range.to) && range.to >= from && range.from <= through)
    .map(range => ({ from: range.from < from ? from : range.from, to: range.to > through ? through : range.to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  if (!intervals.length) return { state: 'none', from: null, to: null };
  let cursor = from;
  let coveredFrom = null;
  let coveredTo = null;
  for (const interval of intervals) {
    if (interval.from > cursor) break;
    if (!coveredFrom) coveredFrom = interval.from;
    if (!coveredTo || interval.to > coveredTo) coveredTo = interval.to;
    if (coveredTo >= through) return { state: 'complete', from: coveredFrom, to: coveredTo };
    cursor = shiftDateKey(coveredTo, 1);
  }
  return { state: 'partial', from: coveredFrom || intervals[0].from, to: coveredTo || intervals[0].to };
}

function latestDate(values) {
  const valid = values.filter(Boolean).map(value => new Date(value)).filter(value => Number.isFinite(value.getTime()));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map(value => value.getTime()))).toISOString();
}

async function runSequentialQueries(operations) {
  const results = [];
  for (const operation of operations) results.push(await operation());
  return results;
}

function routeError(res, error, logger = console) {
  if (error instanceof PlatformSettlementError) {
    return res.status(error.statusCode).json({ code: error.code, error: error.message });
  }
  if (['42P01', '42703', '42883'].includes(String(error?.code || ''))) {
    return res.status(503).json({
      code: 'MONTHLY_SETTLEMENT_SCHEMA_NOT_READY',
      error: '월 정산 데이터 준비가 아직 완료되지 않았습니다.',
    });
  }
  logger.error?.('platform monthly settlement read failed', error?.message || error);
  return res.status(500).json({
    code: 'MONTHLY_SETTLEMENT_READ_FAILED',
    error: '월 정산을 불러오지 못했습니다.',
  });
}

function forbiddenSelfOverride(req) {
  const query = req?.query || {};
  const forbidden = ['owner', 'ownerUid', 'owner_uid', 'uid', 'scope', 'preview', 'persona'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(query, key))) return true;
  const headers = req?.headers || {};
  return Boolean(headers['x-peakos-preview-persona'] || headers['x-peakos-preview-owner']);
}

function directSelfAllowed(req) {
  return Boolean(
    req?.uid
    && req?.userDoc?.approved === true
    && req.userDoc?.is_active !== false
    && req.userDoc?.chat_only !== true
    && req.userDoc?.external_calendar_only !== true
    && req?.workspace?.id
    && req.workspace?.headquartersOversight !== true
    && ['admin', 'manager', 'member'].includes(String(req.workspace?.role || '')),
  );
}

function registerPeakosPlatformMonthlySettlementRoutes({
  app,
  pool,
  middlewares = [],
  peakWorkspaceId = 'ws_peak',
  getWorkspaceId = req => req.workspace?.id,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('app.get이 필요합니다.');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect가 필요합니다.');
  if (!Array.isArray(middlewares)) throw new TypeError('middlewares는 배열이어야 합니다.');

  app.get('/api/peakos/monthly-settlement/self', ...middlewares, async (req, res) => {
    res.set?.('Cache-Control', 'private, no-store');
    res.vary?.('X-PeakOS-Workspace');
    res.vary?.('Authorization');
    if (!directSelfAllowed(req) || forbiddenSelfOverride(req)) {
      return res.status(403).json({
        code: 'MONTHLY_SETTLEMENT_SELF_FORBIDDEN',
        error: '실제 로그인 계정의 본인 월 정산만 볼 수 있습니다.',
      });
    }
    let range;
    let requestNow;
    try {
      requestNow = now();
      range = monthBounds(req.query?.month, requestNow);
    } catch (error) {
      return routeError(res, error, logger);
    }
    const workspaceId = String(getWorkspaceId(req) || '');
    if (!workspaceId || workspaceId !== String(req.workspace.id)) {
      return res.status(403).json({
        code: 'MONTHLY_SETTLEMENT_SELF_FORBIDDEN',
        error: '선택한 워크스페이스의 본인 월 정산만 볼 수 있습니다.',
      });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const ownerExactName = normalizeExactName(req.userDoc?.name || req.userName || '');
      const eligibleDirectoryResult = await client.query(
        `SELECT users.uid, users.name
           FROM public.peakos_workspaces workspace
           JOIN public.peakos_workspace_memberships membership
             ON membership.workspace_id = workspace.id
           JOIN public.users ON users.uid = membership.user_uid
          WHERE workspace.id = $1
            AND workspace.active = TRUE
            AND membership.active = TRUE
            AND membership.role IN ('admin','manager','member')
            AND users.approved = TRUE
            AND COALESCE(users.is_active, TRUE) = TRUE
            AND COALESCE(users.chat_only, FALSE) = FALSE
            AND COALESCE(users.external_calendar_only, FALSE) = FALSE
          ORDER BY users.uid`,
        [workspaceId],
      );
      const eligibleByName = new Map();
      for (const row of eligibleDirectoryResult.rows) {
        const normalizedName = normalizeExactName(row.name);
        const uid = String(row.uid || '');
        if (!normalizedName || !uid) continue;
        const candidates = eligibleByName.get(normalizedName) || [];
        candidates.push(uid);
        eligibleByName.set(normalizedName, candidates);
      }
      const uniqueExactNames = [];
      const uniqueExactOwnerUids = [];
      for (const [normalizedName, candidates] of eligibleByName) {
        if (candidates.length !== 1) continue;
        uniqueExactNames.push(normalizedName);
        uniqueExactOwnerUids.push(candidates[0]);
      }
      const [
        personalResult,
        connectionResult,
        runResult,
        aggregateRunResult,
        aggregateHistoryResult,
        aggregatePlatformResult,
        aggregateAttributionIssueResult,
        platformResult,
        attributionIssueResult,
      ] = await runSequentialQueries([
        () => client.query(
          `SELECT COUNT(*)::int AS transaction_count,
                  COALESCE(SUM(
                    COALESCE(sell,0)::numeric * COALESCE(qty,0)::numeric
                    * CASE WHEN kind = 'refund' THEN -1 ELSE 1 END
                  ),0)::text AS sales,
                  COALESCE(SUM(
                    (COALESCE(sell,0)::numeric - COALESCE(unit,0)::numeric)
                    * COALESCE(qty,0)::numeric
                    * CASE WHEN kind = 'refund' THEN -1 ELSE 1 END
                  ),0)::text AS profit
             FROM public.peakos_intake
            WHERE owner_uid = $2
              AND date >= $3::date AND date < $4::date
              AND COALESCE(final_only,FALSE) = FALSE
              AND kind <> 'reserve'
              AND (workspace_id = $1 OR (workspace_id IS NULL AND $1 = $5))`,
          [workspaceId, req.uid, range.from, range.next, peakWorkspaceId],
        ),
        () => client.query(
          `SELECT DISTINCT ON (provider)
                  provider, connection_state, last_successful_import_at, last_error_code, created_at
             FROM public.peakos_platform_connections
            WHERE workspace_id = $1
            ORDER BY provider, version DESC, created_at DESC`,
          [workspaceId],
        ),
        () => client.query(
          `WITH latest AS (
             SELECT provider, MAX(completed_at) AS latest_completed_at
               FROM public.peakos_platform_import_runs
              WHERE workspace_id = $1 AND status = 'completed' AND snapshot_complete = TRUE
              GROUP BY provider
           )
           SELECT run.provider, run.covered_from::text AS covered_from,
                  run.covered_to::text AS covered_to, run.completed_at
             FROM public.peakos_platform_import_runs run
             LEFT JOIN latest ON latest.provider = run.provider
            WHERE run.workspace_id = $1 AND run.status = 'completed'
              AND run.snapshot_complete = TRUE
              AND (
                (run.covered_to >= $2::date AND run.covered_from <= $3::date)
                OR run.completed_at = latest.latest_completed_at
              )
            ORDER BY run.provider, run.completed_at DESC, run.id DESC`,
          [workspaceId, range.from, range.coverageRequiredThrough],
        ),
        () => client.query(
          `SELECT DISTINCT ON (provider)
                  provider, id, settlement_month,
                  covered_from::text AS covered_from, covered_to::text AS covered_to,
                  source_total_count, row_count, mapped_count, ambiguous_count,
                  global_unmatched_count, source_excluded_count, source_state, source_drift,
                  observed_at, completed_at
             FROM public.peakos_platform_aggregate_runs aggregate_run
            WHERE aggregate_run.workspace_id = $1
              AND aggregate_run.settlement_month = $2
              AND aggregate_run.status = 'completed'
              AND NOT EXISTS (
                SELECT 1
                  FROM public.peakos_platform_aggregate_quarantines quarantine
                 WHERE quarantine.workspace_id = aggregate_run.workspace_id
                   AND quarantine.provider = aggregate_run.provider
                   AND quarantine.aggregate_run_id = aggregate_run.id
              )
            ORDER BY provider, completed_at DESC, id DESC`,
          [workspaceId, range.month],
        ),
        () => client.query(
          `SELECT aggregate_run.provider,
                  COUNT(*)::int AS aggregate_run_count,
                  COUNT(quarantine.aggregate_run_id)::int AS quarantined_run_count
             FROM public.peakos_platform_aggregate_runs aggregate_run
             LEFT JOIN public.peakos_platform_aggregate_quarantines quarantine
               ON quarantine.workspace_id = aggregate_run.workspace_id
              AND quarantine.provider = aggregate_run.provider
              AND quarantine.aggregate_run_id = aggregate_run.id
            WHERE aggregate_run.workspace_id = $1
              AND aggregate_run.settlement_month = $2
              AND aggregate_run.status = 'completed'
            GROUP BY aggregate_run.provider`,
          [workspaceId, range.month],
        ),
        () => client.query(
          `WITH unique_exact(external_name_normalized, owner_uid) AS (
             SELECT * FROM unnest($4::text[], $5::text[])
           ), latest_snapshot AS (
             SELECT DISTINCT ON (aggregate_run.provider)
                    aggregate_run.provider, aggregate_run.id
               FROM public.peakos_platform_aggregate_runs aggregate_run
              WHERE aggregate_run.workspace_id = $1
                AND aggregate_run.settlement_month = $3
                AND aggregate_run.status = 'completed'
                AND NOT EXISTS (
                  SELECT 1
                    FROM public.peakos_platform_aggregate_quarantines quarantine
                   WHERE quarantine.workspace_id = aggregate_run.workspace_id
                     AND quarantine.provider = aggregate_run.provider
                     AND quarantine.aggregate_run_id = aggregate_run.id
                )
              ORDER BY aggregate_run.provider, aggregate_run.completed_at DESC,
                       aggregate_run.id DESC
           ), latest_mapping AS (
             SELECT DISTINCT ON (provider, external_name_normalized)
                    provider, external_name_normalized, mapping_state, match_method, owner_uid
               FROM public.peakos_platform_salesperson_mappings
              WHERE workspace_id = $1
              ORDER BY provider, external_name_normalized, version DESC, created_at DESC, id DESC
           ), eligible_owner AS (
             SELECT membership.user_uid
               FROM public.peakos_workspaces workspace
               JOIN public.peakos_workspace_memberships membership
                 ON membership.workspace_id = workspace.id
               JOIN public.users ON users.uid = membership.user_uid
              WHERE workspace.id = $1
                AND workspace.active = TRUE
                AND membership.active = TRUE
                AND membership.role IN ('admin','manager','member')
                AND users.approved = TRUE
                AND COALESCE(users.is_active, TRUE) = TRUE
                AND COALESCE(users.chat_only, FALSE) = FALSE
                AND COALESCE(users.external_calendar_only, FALSE) = FALSE
           )
           SELECT aggregate_row.provider,
                  COUNT(*)::int AS aggregate_row_count,
                  (COUNT(*) - COUNT(aggregate_row.sales_amount))::int AS missing_sales_count,
                  (COUNT(*) - COUNT(aggregate_row.profit_amount))::int AS missing_profit_count,
                  (COUNT(*) - COUNT(aggregate_row.source_record_count))::int
                    AS missing_source_record_count,
                  COALESCE(SUM(aggregate_row.sales_amount),0)::text AS observed_sales,
                  COALESCE(SUM(aggregate_row.profit_amount),0)::text AS observed_profit,
                  COALESCE(SUM(aggregate_row.source_record_count),0)::text
                    AS observed_source_record_count,
                  COUNT(DISTINCT aggregate_row.profit_basis)::int AS profit_basis_count,
                  MIN(aggregate_row.profit_basis) AS profit_basis
             FROM public.peakos_platform_aggregate_rows aggregate_row
             JOIN latest_snapshot snapshot
               ON snapshot.provider = aggregate_row.provider
              AND snapshot.id = aggregate_row.snapshot_run_id
             JOIN latest_mapping mapping
               ON mapping.provider = aggregate_row.provider
              AND mapping.external_name_normalized = aggregate_row.external_name_normalized
             JOIN eligible_owner eligible ON eligible.user_uid = mapping.owner_uid
             LEFT JOIN unique_exact exact_mapping
               ON exact_mapping.external_name_normalized = mapping.external_name_normalized
              AND exact_mapping.owner_uid = mapping.owner_uid
            WHERE aggregate_row.workspace_id = $1
              AND mapping.mapping_state = 'active'
              AND mapping.owner_uid = $2
              AND (
                mapping.match_method = 'manual_correction'
                OR exact_mapping.owner_uid IS NOT NULL
              )
            GROUP BY aggregate_row.provider`,
          [workspaceId, req.uid, range.month, uniqueExactNames, uniqueExactOwnerUids],
        ),
        () => client.query(
          `WITH unique_exact(external_name_normalized, owner_uid) AS (
             SELECT * FROM unnest($4::text[], $5::text[])
           ), latest_snapshot AS (
             SELECT DISTINCT ON (aggregate_run.provider)
                    aggregate_run.provider, aggregate_run.id
               FROM public.peakos_platform_aggregate_runs aggregate_run
              WHERE aggregate_run.workspace_id = $1
                AND aggregate_run.settlement_month = $3
                AND aggregate_run.status = 'completed'
                AND NOT EXISTS (
                  SELECT 1
                    FROM public.peakos_platform_aggregate_quarantines quarantine
                   WHERE quarantine.workspace_id = aggregate_run.workspace_id
                     AND quarantine.provider = aggregate_run.provider
                     AND quarantine.aggregate_run_id = aggregate_run.id
                )
              ORDER BY aggregate_run.provider, aggregate_run.completed_at DESC,
                       aggregate_run.id DESC
           ), latest_mapping AS (
             SELECT DISTINCT ON (provider, external_name_normalized)
                    provider, external_name_normalized, mapping_state, match_method, owner_uid
               FROM public.peakos_platform_salesperson_mappings
              WHERE workspace_id = $1
              ORDER BY provider, external_name_normalized, version DESC, created_at DESC, id DESC
           ), eligible_mapping AS (
             SELECT mapping.provider, mapping.external_name_normalized
               FROM latest_mapping mapping
               JOIN public.peakos_workspace_memberships membership
                 ON membership.workspace_id = $1 AND membership.user_uid = mapping.owner_uid
               JOIN public.peakos_workspaces workspace
                 ON workspace.id = membership.workspace_id
               JOIN public.users ON users.uid = membership.user_uid
               LEFT JOIN unique_exact exact_mapping
                 ON exact_mapping.external_name_normalized = mapping.external_name_normalized
                AND exact_mapping.owner_uid = mapping.owner_uid
              WHERE mapping.mapping_state = 'active'
                AND (
                  mapping.match_method = 'manual_correction'
                  OR exact_mapping.owner_uid IS NOT NULL
                )
                AND workspace.active = TRUE
                AND membership.active = TRUE
                AND membership.role IN ('admin','manager','member')
                AND users.approved = TRUE
                AND COALESCE(users.is_active, TRUE) = TRUE
                AND COALESCE(users.chat_only, FALSE) = FALSE
                AND COALESCE(users.external_calendar_only, FALSE) = FALSE
           )
           SELECT aggregate_row.provider, COUNT(*)::int AS attribution_issue_count
             FROM public.peakos_platform_aggregate_rows aggregate_row
             JOIN latest_snapshot snapshot
               ON snapshot.provider = aggregate_row.provider
              AND snapshot.id = aggregate_row.snapshot_run_id
             LEFT JOIN latest_mapping current_mapping
               ON current_mapping.provider = aggregate_row.provider
              AND current_mapping.external_name_normalized = aggregate_row.external_name_normalized
             LEFT JOIN eligible_mapping mapping
               ON mapping.provider = aggregate_row.provider
              AND mapping.external_name_normalized = aggregate_row.external_name_normalized
            WHERE aggregate_row.workspace_id = $1
              AND $2 <> ''
              AND (
                (
                  aggregate_row.external_name_normalized = $2
                  AND (
                    aggregate_row.attribution_status = 'ambiguous'
                    OR mapping.external_name_normalized IS NULL
                  )
                )
                OR (
                  current_mapping.mapping_state = 'active'
                  AND current_mapping.match_method = 'exact_name'
                  AND current_mapping.owner_uid = $6
                  AND mapping.external_name_normalized IS NULL
                )
              )
            GROUP BY aggregate_row.provider`,
          [
            workspaceId, ownerExactName, range.month,
            uniqueExactNames, uniqueExactOwnerUids, req.uid,
          ],
        ),
        () => client.query(
          `WITH unique_exact(external_name_normalized, owner_uid) AS (
             SELECT * FROM unnest($5::text[], $6::text[])
           ), ranked AS (
             SELECT provider, external_transaction_id, business_date,
                    external_name_normalized, record_state, sales_amount, profit_amount,
                    ROW_NUMBER() OVER (
                      PARTITION BY workspace_id, provider, external_transaction_id
                      ORDER BY source_updated_at DESC, imported_at DESC, id DESC
                    ) AS revision_rank
               FROM public.peakos_platform_transaction_events
              WHERE workspace_id = $1
           ), latest_mapping AS (
             SELECT DISTINCT ON (provider, external_name_normalized)
                    provider, external_name_normalized, mapping_state, match_method, owner_uid
               FROM public.peakos_platform_salesperson_mappings
              WHERE workspace_id = $1
              ORDER BY provider, external_name_normalized, version DESC, created_at DESC, id DESC
           ), eligible_owner AS (
             SELECT membership.user_uid
               FROM public.peakos_workspaces workspace
               JOIN public.peakos_workspace_memberships membership
                 ON membership.workspace_id = workspace.id
               JOIN public.users ON users.uid = membership.user_uid
              WHERE workspace.id = $1
                AND workspace.active = TRUE
                AND membership.active = TRUE
                AND membership.role IN ('admin','manager','member')
                AND users.approved = TRUE
                AND COALESCE(users.is_active, TRUE) = TRUE
                AND COALESCE(users.chat_only, FALSE) = FALSE
                AND COALESCE(users.external_calendar_only, FALSE) = FALSE
           )
           SELECT ranked.provider,
                  COUNT(*)::int AS transaction_count,
                  (COUNT(*) - COUNT(sales_amount))::int AS missing_sales_count,
                  (COUNT(*) - COUNT(profit_amount))::int AS missing_profit_count,
                  COALESCE(SUM(sales_amount),0)::text AS observed_sales,
                  COALESCE(SUM(profit_amount),0)::text AS observed_profit
             FROM ranked
             JOIN latest_mapping mapping
               ON mapping.provider = ranked.provider
              AND mapping.external_name_normalized = ranked.external_name_normalized
             JOIN eligible_owner eligible ON eligible.user_uid = mapping.owner_uid
             LEFT JOIN unique_exact exact_mapping
               ON exact_mapping.external_name_normalized = mapping.external_name_normalized
              AND exact_mapping.owner_uid = mapping.owner_uid
            WHERE revision_rank = 1
              AND mapping.mapping_state = 'active'
              AND mapping.owner_uid = $2
              AND (
                mapping.match_method = 'manual_correction'
                OR exact_mapping.owner_uid IS NOT NULL
              )
              AND record_state = 'active'
              AND business_date >= $3::date AND business_date < $4::date
            GROUP BY ranked.provider`,
          [
            workspaceId, req.uid, range.from, range.next,
            uniqueExactNames, uniqueExactOwnerUids,
          ],
        ),
        () => client.query(
          `WITH unique_exact(external_name_normalized, owner_uid) AS (
             SELECT * FROM unnest($5::text[], $6::text[])
           ), ranked AS (
             SELECT provider, external_transaction_id, business_date,
                    external_name_normalized, record_state,
                    ROW_NUMBER() OVER (
                      PARTITION BY workspace_id, provider, external_transaction_id
                      ORDER BY source_updated_at DESC, imported_at DESC, id DESC
                    ) AS revision_rank
               FROM public.peakos_platform_transaction_events
              WHERE workspace_id = $1
           ), latest_mapping AS (
             SELECT DISTINCT ON (provider, external_name_normalized)
                    provider, external_name_normalized, mapping_state, match_method, owner_uid
               FROM public.peakos_platform_salesperson_mappings
              WHERE workspace_id = $1
              ORDER BY provider, external_name_normalized, version DESC, created_at DESC, id DESC
           ), eligible_mapping AS (
             SELECT mapping.provider, mapping.external_name_normalized
               FROM latest_mapping mapping
               JOIN public.peakos_workspace_memberships membership
                 ON membership.workspace_id = $1 AND membership.user_uid = mapping.owner_uid
               JOIN public.peakos_workspaces workspace
                 ON workspace.id = membership.workspace_id
             JOIN public.users ON users.uid = membership.user_uid
              LEFT JOIN unique_exact exact_mapping
                ON exact_mapping.external_name_normalized = mapping.external_name_normalized
               AND exact_mapping.owner_uid = mapping.owner_uid
              WHERE mapping.mapping_state = 'active'
                AND (
                  mapping.match_method = 'manual_correction'
                  OR exact_mapping.owner_uid IS NOT NULL
                )
                AND workspace.active = TRUE
                AND membership.active = TRUE
                AND membership.role IN ('admin','manager','member')
                AND users.approved = TRUE
                AND COALESCE(users.is_active, TRUE) = TRUE
                AND COALESCE(users.chat_only, FALSE) = FALSE
                AND COALESCE(users.external_calendar_only, FALSE) = FALSE
           )
           SELECT ranked.provider, COUNT(*)::int AS attribution_issue_count
             FROM ranked
             LEFT JOIN latest_mapping current_mapping
               ON current_mapping.provider = ranked.provider
              AND current_mapping.external_name_normalized = ranked.external_name_normalized
             LEFT JOIN eligible_mapping mapping
               ON mapping.provider = ranked.provider
              AND mapping.external_name_normalized = ranked.external_name_normalized
            WHERE revision_rank = 1
              AND record_state = 'active'
              AND $2 <> ''
              AND (
                (
                  ranked.external_name_normalized = $2
                  AND mapping.external_name_normalized IS NULL
                )
                OR (
                  current_mapping.mapping_state = 'active'
                  AND current_mapping.match_method = 'exact_name'
                  AND current_mapping.owner_uid = $7
                  AND mapping.external_name_normalized IS NULL
                )
              )
              AND business_date >= $3::date AND business_date < $4::date
            GROUP BY ranked.provider`,
          [
            workspaceId, ownerExactName, range.from, range.next,
            uniqueExactNames, uniqueExactOwnerUids, req.uid,
          ],
        ),
      ]);

      const personalRow = personalResult.rows[0] || {};
      const connections = new Map(connectionResult.rows.map(row => [row.provider, row]));
      const runs = new Map();
      for (const row of runResult.rows) {
        const current = runs.get(row.provider) || [];
        current.push(row);
        runs.set(row.provider, current);
      }
      const aggregateRuns = new Map(aggregateRunResult.rows.map(row => [row.provider, row]));
      const aggregateHistory = new Map(
        aggregateHistoryResult.rows.map(row => [row.provider, row]),
      );
      const aggregateMetrics = new Map(
        aggregatePlatformResult.rows.map(row => [row.provider, row]),
      );
      const aggregateAttributionIssues = new Map(
        aggregateAttributionIssueResult.rows.map(row => [row.provider, row]),
      );
      const metrics = new Map(platformResult.rows.map(row => [row.provider, row]));
      const attributionIssues = new Map(attributionIssueResult.rows.map(row => [row.provider, row]));
      const currentKstMonth = formatKstDate(requestNow).slice(0, 7);
      const isCurrentMonth = range.month === currentKstMonth;
      const platforms = PLATFORM_PROVIDERS.map(provider => {
        const connection = connections.get(provider.key);
        const aggregateRun = aggregateRuns.get(provider.key);
        const aggregateHistoryRow = aggregateHistory.get(provider.key);
        const aggregateRunCount = Number(aggregateHistoryRow?.aggregate_run_count || 0);
        const quarantinedRunCount = Number(aggregateHistoryRow?.quarantined_run_count || 0);
        if (aggregateRun) {
          const metric = aggregateMetrics.get(provider.key);
          const providerRuns = [aggregateRun];
          const coverage = coverageState(providerRuns, range.from, range.coverageRequiredThrough);
          const publicCoverageState = isCurrentMonth && coverage.state === 'complete'
            ? 'provisional' : coverage.state;
          const attributionIssueCount = Number(
            aggregateAttributionIssues.get(provider.key)?.attribution_issue_count || 0,
          ) + (Number(aggregateRun.global_unmatched_count || 0) > 0 ? 1 : 0);
          const aggregateRowCount = Number(metric?.aggregate_row_count || 0);
          const missingSalesCount = Number(metric?.missing_sales_count || 0);
          const missingProfitCount = Number(metric?.missing_profit_count || 0);
          const missingSourceRecordCount = Number(metric?.missing_source_record_count || 0);
          const observedSales = numericOut(metric?.observed_sales || 0, `${provider.label} 매출`);
          const basisCount = Number(metric?.profit_basis_count || 0);
          let profitBasis = basisCount === 1 ? String(metric?.profit_basis || '') : 'unavailable';
          if (!aggregateRowCount) {
            if (provider.key === 'rewardspace') profitBasis = 'reward_distributor_margin';
            else if (provider.key === 'reviewspace') profitBasis = 'review_spread_profit';
          }
          if (provider.key === 'keywordmaster') profitBasis = 'unavailable';
          const profitExpected = profitBasis !== 'unavailable';
          const observedProfit = profitExpected
            ? numericOut(metric?.observed_profit || 0, `${provider.label} 영업이익`)
            : null;
          const observedTransactionCount = numericOut(
            metric?.observed_source_record_count || 0,
            `${provider.label} 원본 레코드 수`,
          );
          const connectionState = String(connection?.connection_state || '');
          const connectionUsable = ['ready', 'error'].includes(connectionState);
          const amountsAvailable = coverage.state === 'complete'
            && attributionIssueCount === 0
            && connectionUsable;
          const transactionCount = amountsAvailable && missingSourceRecordCount === 0
            ? observedTransactionCount : null;
          let dataState = coverage.state === 'complete'
            ? (aggregateRowCount ? 'available' : 'no_data')
            : (coverage.state === 'partial' ? 'partial' : 'not_covered');
          if (missingSalesCount || (profitExpected && missingProfitCount) || attributionIssueCount) {
            dataState = 'partial';
          }
          if (!connectionUsable) {
            dataState = connectionState === 'pending' ? 'never_imported' : 'not_connected';
          }
          const status = connectionState === 'error' ? 'sync_error' : dataState;
          return {
            key: provider.key,
            label: provider.label,
            status,
            dataState,
            sales: amountsAvailable && missingSalesCount === 0 ? observedSales : null,
            profit: amountsAvailable && profitExpected && missingProfitCount === 0
              ? observedProfit : null,
            transactionCount,
            missingSalesCount,
            missingProfitCount: profitExpected ? missingProfitCount : 0,
            missingSourceRecordCount,
            attributionIssueCount,
            lastImportedAt: latestDate([
              connection?.last_successful_import_at,
              aggregateRun.completed_at,
            ]),
            sourceState: String(aggregateRun.source_state || 'unknown'),
            // 공급처 drift의 단위·공식은 문서에 없다. 전사 원본 숫자는 개인
            // 응답에 노출하지 않고 지급 확정 후 변동 여부만 전달한다.
            sourceChangedAfterSettlement: aggregateRun.source_drift !== null
              && numericOut(aggregateRun.source_drift, `${provider.label} 원본 drift`) !== 0,
            profitBasis,
            snapshotKind: 'monthly_aggregate',
            rollbackApplied: quarantinedRunCount > 0,
            coverage: {
              state: publicCoverageState,
              from: coverage.from,
              to: coverage.to,
              requiredThrough: range.coverageRequiredThrough,
              attribution: 'latest_versioned_mapping',
              eventOwnerSnapshot: 'aggregate_import_audit_only',
            },
          };
        }
        // Once this provider/month has aggregate history, quarantining every
        // completed run must never resurrect an unrelated legacy transaction
        // event ledger. With no eligible aggregate run we fail closed.
        if (aggregateRunCount > 0) {
          return {
            key: provider.key,
            label: provider.label,
            status: 'not_covered',
            dataState: 'not_covered',
            sales: null,
            profit: null,
            transactionCount: null,
            missingSalesCount: 0,
            missingProfitCount: 0,
            missingSourceRecordCount: 0,
            attributionIssueCount: 0,
            lastImportedAt: latestDate([connection?.last_successful_import_at]),
            sourceState: 'unknown',
            sourceChangedAfterSettlement: false,
            profitBasis: null,
            snapshotKind: 'monthly_aggregate',
            rollbackApplied: quarantinedRunCount > 0,
            coverage: {
              state: 'none',
              from: null,
              to: null,
              requiredThrough: range.coverageRequiredThrough,
              attribution: 'latest_versioned_mapping',
              eventOwnerSnapshot: 'aggregate_import_audit_only',
            },
          };
        }
        const providerRuns = runs.get(provider.key) || [];
        const latestImportedAt = latestDate([
          connection?.last_successful_import_at,
          ...providerRuns.map(run => run.completed_at),
        ]);
        const coverage = coverageState(providerRuns, range.from, range.coverageRequiredThrough);
        const publicCoverageState = isCurrentMonth && coverage.state === 'complete'
          ? 'provisional' : coverage.state;
        const metric = metrics.get(provider.key);
        const attributionIssueCount = Number(
          attributionIssues.get(provider.key)?.attribution_issue_count || 0,
        );
        const transactionCount = Number(metric?.transaction_count || 0);
        const missingSalesCount = Number(metric?.missing_sales_count || 0);
        const missingProfitCount = Number(metric?.missing_profit_count || 0);
        const observedSales = numericOut(metric?.observed_sales || 0, `${provider.label} 매출`);
        const observedProfit = numericOut(metric?.observed_profit || 0, `${provider.label} 영업이익`);
        let dataState = 'not_connected';
        if (providerRuns.length || connection) dataState = 'never_imported';
        if (providerRuns.length && coverage.state === 'none') dataState = 'not_covered';
        if (coverage.state === 'partial') dataState = 'partial';
        if (coverage.state === 'complete') dataState = transactionCount ? 'available' : 'no_data';
        if (missingSalesCount || missingProfitCount || attributionIssueCount) dataState = 'partial';
        const connectionState = String(connection?.connection_state || '');
        const connectionUsable = ['ready', 'error'].includes(connectionState);
        if (!connectionUsable) {
          dataState = connectionState === 'pending' ? 'never_imported' : 'not_connected';
        }
        const status = connection?.connection_state === 'error' ? 'sync_error' : dataState;
        const amountsAvailable = coverage.state === 'complete'
          && attributionIssueCount === 0
          && connectionUsable;
        return {
          key: provider.key,
          label: provider.label,
          status,
          dataState,
          sales: amountsAvailable && missingSalesCount === 0 ? observedSales : null,
          profit: amountsAvailable && missingProfitCount === 0 ? observedProfit : null,
          transactionCount: amountsAvailable ? transactionCount : null,
          missingSalesCount,
          missingProfitCount,
          attributionIssueCount,
          lastImportedAt: latestImportedAt,
          sourceState: 'unknown',
          sourceChangedAfterSettlement: false,
          profitBasis: null,
          snapshotKind: 'transaction_events',
          rollbackApplied: false,
          coverage: {
            state: publicCoverageState,
            from: coverage.from,
            to: coverage.to,
            requiredThrough: range.coverageRequiredThrough,
            attribution: 'latest_versioned_mapping',
            eventOwnerSnapshot: 'import_audit_only',
          },
        };
      });
      const includedSales = platforms.filter(row => typeof row.sales === 'number');
      const includedProfit = platforms.filter(row => typeof row.profit === 'number');
      const includedTransactions = platforms.filter(row => typeof row.transactionCount === 'number');
      const expectedProfitPlatforms = platforms.filter(row => row.key !== 'keywordmaster');
      const sourceAsOf = new Date(requestNow).toISOString();
      const payload = {
        scope: 'self',
        month: range.month,
        timezone: KST_TIME_ZONE,
        provisional: true,
        sourceAsOf,
        provisionalNotice: '연동 원장의 최신 완료 수집본을 기준으로 한 잠정 조회이며 월 마감·승인 전에는 변경될 수 있습니다.',
        period: { from: range.from, to: range.to, coverageRequiredThrough: range.coverageRequiredThrough },
        owner: { uid: String(req.uid), name: String(req.userDoc?.name || req.userName || '') },
        personal: {
          sales: numericOut(personalRow.sales || 0, '개인정산서 매출'),
          profit: numericOut(personalRow.profit || 0, '개인정산서 영업이익'),
          transactionCount: Number(personalRow.transaction_count || 0),
          coverage: { state: 'complete', source: 'peakos_intake', attribution: 'authenticated_uid' },
        },
        platformTotal: {
          sales: includedSales.length ? includedSales.reduce((sum, row) => sum + row.sales, 0) : null,
          profit: includedProfit.length ? includedProfit.reduce((sum, row) => sum + row.profit, 0) : null,
          transactionCount: includedTransactions.length
            ? includedTransactions.reduce((sum, row) => sum + row.transactionCount, 0) : null,
          salesProviderCount: includedSales.length,
          profitProviderCount: includedProfit.length,
          transactionProviderCount: includedTransactions.length,
          providerCount: PLATFORM_PROVIDERS.length,
          complete: !isCurrentMonth
            && includedSales.length === PLATFORM_PROVIDERS.length
            && expectedProfitPlatforms.every(row => typeof row.profit === 'number'),
          note: '개인정산서와 중복될 수 있어 개인정산서 합계와 더하지 않습니다.',
        },
        platforms,
        generatedAt: sourceAsOf,
      };
      await client.query('COMMIT');
      return res.json(payload);
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { /* keep original read error */ }
      }
      return routeError(res, error, logger);
    } finally {
      client?.release?.();
    }
  });
}

module.exports = {
  APPEND_ONLY_FUNCTION_SOURCE,
  KST_TIME_ZONE,
  PLATFORM_CONNECTION_SECRET_REF_CHECK_DEFINITION,
  PLATFORM_PROVIDERS,
  REQUIRED_COLUMN_DEFINITIONS,
  REQUIRED_CONSTRAINT_DEFINITIONS,
  REQUIRED_INDEX_DEFINITIONS,
  PlatformSettlementError,
  calculatePlatformMonthlyAggregateDigest,
  coverageState,
  correctPlatformSalespersonMapping,
  directSelfAllowed,
  ensurePeakosPlatformSettlementInfrastructure,
  forbiddenSelfOverride,
  importPlatformMonthlyAggregateSnapshot,
  importPlatformTransactionBatch,
  inspectLatestPlatformMonthlyAggregateRun,
  monthBounds,
  normalizeExactName,
  quarantinePlatformMonthlyAggregateRun,
  registerPeakosPlatformMonthlySettlementRoutes,
};
