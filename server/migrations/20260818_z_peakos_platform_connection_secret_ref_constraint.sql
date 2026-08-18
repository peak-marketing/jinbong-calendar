-- Release the platform connection ledger from PostgreSQL's regular-expression
-- repetition ceiling.  The original oversized interval repetition is outside
-- the supported range and raises SQLSTATE 2201B whenever a non-NULL
-- credential reference is checked.  Length and alphabet are deliberately
-- enforced separately here without changing the intended 1..512 contract.
--
-- Apply as the table owner/DBA after 20260817_peakos_platform_monthly_settlement.sql.
-- Set `peakos.app_role` in this same operator session when the runtime role is
-- not `calendar_user`.

BEGIN;

SET LOCAL search_path = public, pg_temp;

SELECT pg_advisory_xact_lock(
  hashtext('peakos-platform-connection-secret-ref-constraint-v2')
);

DO $platform_connection_secret_ref_prerequisites$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
BEGIN
  IF to_regclass('public.peakos_platform_connections') IS NULL THEN
    RAISE EXCEPTION
      'platform monthly settlement migration must be applied before connection constraint release'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('credential_secret_ref', 'text', FALSE),
        ('connection_state', 'text', TRUE)
      ) AS required(column_name, data_type, is_not_null)
      LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
      LEFT JOIN pg_class relation
        ON relation.relnamespace = namespace.oid
       AND relation.relname = 'peakos_platform_connections'
       AND relation.relkind IN ('r', 'p')
      LEFT JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = required.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     WHERE attribute.attnum IS NULL
        OR format_type(attribute.atttypid, attribute.atttypmod) <> required.data_type
        OR attribute.attnotnull <> required.is_not_null
  ) THEN
    RAISE EXCEPTION
      'platform connection columns do not match the required constraint contract'
      USING ERRCODE = '55000';
  END IF;

  application_role := configured_role;
  IF application_role IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendar_user') THEN
      application_role := 'calendar_user';
    ELSE
      RAISE EXCEPTION
        'set peakos.app_role to the non-owner runtime role before applying connection constraint release'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'PEAK OS application role % does not exist', application_role
      USING ERRCODE = '55000';
  END IF;
  IF application_role = current_user THEN
    RAISE EXCEPTION
      'connection constraint release must run as operator, not runtime role %', application_role
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = application_role
       AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'runtime role % must not be superuser or bypass RLS', application_role
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE public.peakos_platform_connections FROM PUBLIC, %I',
    application_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE public.peakos_platform_connections TO %I',
    application_role
  );
END
$platform_connection_secret_ref_prerequisites$;

-- Recreate the same-named constraint on every operator run.  This removes an
-- invalid or weakened same-name constraint as well as the original 2201B form.
-- NOT VALID protects new writes immediately; validation then proves all
-- existing rows before this transaction can commit.
ALTER TABLE public.peakos_platform_connections
  DROP CONSTRAINT IF EXISTS peakos_platform_connections_secret_ref_check;

ALTER TABLE public.peakos_platform_connections
  ADD CONSTRAINT peakos_platform_connections_secret_ref_check
  CHECK (
    credential_secret_ref IS NULL
    OR (
      char_length(credential_secret_ref) BETWEEN 1 AND 512
      AND credential_secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9:/._-]*$'
    )
  ) NOT VALID;

ALTER TABLE public.peakos_platform_connections
  VALIDATE CONSTRAINT peakos_platform_connections_secret_ref_check;

DO $platform_connection_secret_ref_readiness$
DECLARE
  configured_role TEXT := NULLIF(current_setting('peakos.app_role', TRUE), '');
  application_role TEXT;
  expected_definition CONSTANT TEXT :=
    'CHECK (((credential_secret_ref IS NULL) OR (((char_length(credential_secret_ref) >= 1) AND (char_length(credential_secret_ref) <= 512)) AND (credential_secret_ref ~ ''^[A-Za-z0-9][A-Za-z0-9:/._-]*$''::text))))';
  actual_type "char";
  actual_validated BOOLEAN;
  actual_definition TEXT;
  privilege_name TEXT;
BEGIN
  application_role := COALESCE(configured_role, 'calendar_user');

  SELECT constraint_catalog.contype,
         constraint_catalog.convalidated,
         pg_get_constraintdef(constraint_catalog.oid)
    INTO actual_type, actual_validated, actual_definition
    FROM pg_constraint constraint_catalog
   WHERE constraint_catalog.conrelid = 'public.peakos_platform_connections'::regclass
     AND constraint_catalog.conname = 'peakos_platform_connections_secret_ref_check';

  IF actual_type IS DISTINCT FROM 'c'
     OR actual_validated IS DISTINCT FROM TRUE
     OR actual_definition IS DISTINCT FROM expected_definition THEN
    RAISE EXCEPTION
      'platform connection secret reference constraint is not exact and validated'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name = 'peakos_platform_connections'
       AND grantee = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'PUBLIC privileges remain on platform connections'
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_table_privilege(
       application_role, 'public.peakos_platform_connections', 'SELECT'
     )
     OR NOT has_table_privilege(
       application_role, 'public.peakos_platform_connections', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'runtime role % lacks platform connection read/append privilege',
      application_role USING ERRCODE = '55000';
  END IF;
  FOREACH privilege_name IN ARRAY ARRAY[
    'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]
  LOOP
    IF has_table_privilege(
      application_role, 'public.peakos_platform_connections', privilege_name
    ) THEN
      RAISE EXCEPTION 'runtime role % has unsafe % privilege on platform connections',
        application_role, privilege_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$platform_connection_secret_ref_readiness$;

COMMIT;
