-- PEAK OS second-step email OTP challenges and short-lived OS sessions.
-- OTP values and raw session tokens are never stored. Only keyed HMAC hashes
-- produced by the application are persisted.

SELECT pg_advisory_xact_lock(hashtext('peakos-os-email-auth-migration'));

CREATE TABLE IF NOT EXISTS peakos_os_email_challenges (
  id UUID PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  requester_ip_hash TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'PENDING',
  failed_attempts SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  CONSTRAINT peakos_os_email_challenges_code_hash_check
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_os_email_challenges_ip_hash_check
    CHECK (requester_ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_os_email_challenges_delivery_check
    CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  CONSTRAINT peakos_os_email_challenges_attempts_check
    CHECK (failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT peakos_os_email_challenges_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT peakos_os_email_challenges_sent_state_check
    CHECK ((delivery_status = 'SENT' AND sent_at IS NOT NULL)
      OR (delivery_status <> 'SENT'))
);

CREATE INDEX IF NOT EXISTS peakos_os_email_challenges_uid_created_idx
  ON peakos_os_email_challenges(uid, created_at DESC);

CREATE INDEX IF NOT EXISTS peakos_os_email_challenges_ip_created_idx
  ON peakos_os_email_challenges(requester_ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS peakos_os_email_challenges_expiry_idx
  ON peakos_os_email_challenges(expires_at);

CREATE TABLE IF NOT EXISTS peakos_os_email_verify_attempts (
  id BIGSERIAL PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE CASCADE,
  challenge_id UUID REFERENCES peakos_os_email_challenges(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  requester_ip_hash TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT peakos_os_email_verify_attempts_ip_hash_check
    CHECK (requester_ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS peakos_os_email_verify_attempts_uid_created_idx
  ON peakos_os_email_verify_attempts(uid, created_at DESC);

CREATE INDEX IF NOT EXISTS peakos_os_email_verify_attempts_ip_created_idx
  ON peakos_os_email_verify_attempts(requester_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS peakos_os_sessions (
  token_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON UPDATE RESTRICT ON DELETE CASCADE,
  requester_ip_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT peakos_os_sessions_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_os_sessions_ip_hash_check
    CHECK (requester_ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peakos_os_sessions_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS peakos_os_sessions_uid_expiry_idx
  ON peakos_os_sessions(uid, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS peakos_os_sessions_expiry_idx
  ON peakos_os_sessions(expires_at);
