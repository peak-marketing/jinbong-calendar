'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE_NAME = 'peakos_os_session';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_USER_LIMIT = 5;
// 본사·지사 직원들이 같은 NAT 공인 IP를 공유할 수 있다. 전사 19명이
// 동시에 첫 인증을 하고 일부가 재전송해도 IP bucket이 정상 사용자를
// 막지 않도록 두되, 계정별 한도(5)는 그대로 강제한다.
const REQUEST_IP_LIMIT = 100;
const VERIFY_USER_LIMIT = 15;
const VERIFY_IP_LIMIT = 300;
const MAX_CODE_FAILURES = 5;
const EMAIL_TRANSPORT_TIMEOUT_MS = 15 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^\d{6}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;

class OsEmailAuthError extends Error {
  constructor(message, code, statusCode, retryAfterSeconds = null, state = null) {
    super(message);
    this.name = 'OsEmailAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.state = state;
  }
}

function positiveInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return candidate;
}

function normalizeOptions(options = {}) {
  const hmacSecret = String(options.hmacSecret || process.env.PEAKOS_OS_AUTH_HMAC_SECRET || '');
  if (Buffer.byteLength(hmacSecret, 'utf8') < 32) {
    throw new TypeError('PEAKOS_OS_AUTH_HMAC_SECRET must contain at least 32 bytes.');
  }
  const maxCodeFailures = positiveInteger(options.maxCodeFailures, MAX_CODE_FAILURES, 'maxCodeFailures');
  if (maxCodeFailures !== MAX_CODE_FAILURES) {
    throw new TypeError(`maxCodeFailures is fixed at ${MAX_CODE_FAILURES}.`);
  }
  return Object.freeze({
    hmacSecret,
    challengeTtlMs: positiveInteger(options.challengeTtlMs, CHALLENGE_TTL_MS, 'challengeTtlMs'),
    sessionTtlMs: positiveInteger(options.sessionTtlMs, SESSION_TTL_MS, 'sessionTtlMs'),
    resendCooldownMs: positiveInteger(options.resendCooldownMs, RESEND_COOLDOWN_MS, 'resendCooldownMs'),
    rateWindowMs: positiveInteger(options.rateWindowMs, RATE_WINDOW_MS, 'rateWindowMs'),
    requestUserLimit: positiveInteger(options.requestUserLimit, REQUEST_USER_LIMIT, 'requestUserLimit'),
    requestIpLimit: positiveInteger(options.requestIpLimit, REQUEST_IP_LIMIT, 'requestIpLimit'),
    verifyUserLimit: positiveInteger(options.verifyUserLimit, VERIFY_USER_LIMIT, 'verifyUserLimit'),
    verifyIpLimit: positiveInteger(options.verifyIpLimit, VERIFY_IP_LIMIT, 'verifyIpLimit'),
    maxCodeFailures,
  });
}

function parseRequiredUids(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map(entry => String(entry).trim()).filter(Boolean));
}

function createOtpRequirementPolicy({
  mode = process.env.OS_EMAIL_OTP_MODE,
  requiredUids = process.env.OS_EMAIL_OTP_REQUIRED_UIDS,
} = {}) {
  const pilotUids = parseRequiredUids(requiredUids);
  const suppliedMode = String(mode || '').trim().toLowerCase();
  const normalizedMode = suppliedMode || (pilotUids.size ? 'pilot' : '');
  if (!normalizedMode) {
    throw new TypeError('Set OS_EMAIL_OTP_MODE=all/off or provide OS_EMAIL_OTP_REQUIRED_UIDS.');
  }
  if (!['all', 'off', 'pilot'].includes(normalizedMode)) {
    throw new TypeError('OS_EMAIL_OTP_MODE must be all, off, or pilot.');
  }
  if (normalizedMode === 'pilot' && pilotUids.size === 0) {
    throw new TypeError('Pilot mode requires at least one OS_EMAIL_OTP_REQUIRED_UIDS entry.');
  }
  return Object.freeze({
    mode: normalizedMode,
    requiredUids: pilotUids,
    isRequired(uid) {
      if (normalizedMode === 'all') return true;
      if (normalizedMode === 'off') return false;
      return pilotUids.has(String(uid || ''));
    },
  });
}

function currentDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now() returned an invalid date.');
  return date;
}

function approvedAndActive(req) {
  return Boolean(
    req?.uid
      && req.userDoc
      && req.userDoc.approved === true
      && req.userDoc.is_active !== false,
  );
}

function requireApprovedAndActive(req) {
  if (!approvedAndActive(req)) {
    throw new OsEmailAuthError(
      '승인된 활성 사용자만 PEAK OS 추가 인증을 사용할 수 있습니다.',
      'OS_AUTH_USER_NOT_ALLOWED',
      403,
    );
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    throw new OsEmailAuthError('등록된 회사 이메일을 확인할 수 없습니다.', 'OS_AUTH_EMAIL_MISSING', 422);
  }
  const email = value.trim();
  if (
    !email
      || email.length > 320
      || /[\r\n\p{Cc}]/u.test(email)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new OsEmailAuthError('등록된 회사 이메일이 올바르지 않습니다.', 'OS_AUTH_EMAIL_INVALID', 422);
  }
  return email;
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length <= 1 ? '' : local.slice(0, Math.min(2, local.length - 1));
  return `${visible || '*'}***@${domain}`;
}

function generateSixDigitCode(randomInt = crypto.randomInt) {
  const number = randomInt(0, 1_000_000);
  if (!Number.isSafeInteger(number) || number < 0 || number >= 1_000_000) {
    throw new TypeError('randomInt returned an out-of-range value.');
  }
  return String(number).padStart(6, '0');
}

function hmacHex(secret, purpose, ...parts) {
  const payload = [purpose, ...parts.map(part => String(part))].join('\u001f');
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function hashOtp(secret, challengeId, uid, code) {
  return hmacHex(secret, 'peakos-os-email-otp:v1', challengeId, uid, code);
}

function hashSessionToken(secret, token) {
  return hmacHex(secret, 'peakos-os-session:v1', token);
}

function hashIp(secret, ip) {
  return hmacHex(secret, 'peakos-os-ip:v1', normalizeIp(ip));
}

function safeEqualHex(left, right) {
  if (!HMAC_PATTERN.test(String(left)) || !HMAC_PATTERN.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizeIp(value) {
  let ip = String(value || 'unknown').trim().slice(0, 256);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

function defaultGetClientIp(req) {
  // Express computes req.ip using its configured trust-proxy policy. Do not
  // read X-Forwarded-For directly here because an untrusted client can forge it.
  return normalizeIp(req?.ip || req?.socket?.remoteAddress || 'unknown');
}

function parseCookies(header) {
  const cookies = Object.create(null);
  for (const fragment of String(header || '').split(';')) {
    const separator = fragment.indexOf('=');
    if (separator <= 0) continue;
    const name = fragment.slice(0, separator).trim();
    const value = fragment.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = '';
    }
  }
  return cookies;
}

function getSessionToken(req) {
  const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME] || '';
  return SESSION_TOKEN_PATTERN.test(token) ? token : '';
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge,
  };
}

function serializeCookie(value, maxAge) {
  const seconds = Math.max(0, Math.floor(maxAge / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Max-Age=${seconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function setSessionCookie(res, token, ttlMs) {
  if (typeof res.cookie === 'function') {
    res.cookie(COOKIE_NAME, token, cookieOptions(ttlMs));
    return;
  }
  res.setHeader('Set-Cookie', serializeCookie(token, ttlMs));
}

function clearSessionCookie(res) {
  if (typeof res.clearCookie === 'function') {
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
    return;
  }
  res.setHeader(
    'Set-Cookie',
    `${serializeCookie('', 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

function preventAuthResponseCaching(res) {
  // 인증 상태는 탭 전환 직후에도 반드시 현재 쿠키를 기준으로 다시 읽어야 한다.
  // 브라우저뿐 아니라 중간 프록시가 이전의 미인증 응답을 재사용하지 않게 한다.
  if (typeof res.set === 'function') {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    res.set('Vary', 'Authorization, Cookie');
    return;
  }
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Authorization, Cookie');
  }
}

function retryAfterSeconds(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function rateRetryAfter(oldest, now, windowMs) {
  if (!oldest) return retryAfterSeconds(windowMs);
  return retryAfterSeconds(new Date(oldest).getTime() + windowMs - now.getTime());
}

async function withTransaction(pool, task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockRateBuckets(client, uid, ipHash) {
  const buckets = [`ip:${ipHash}`, `uid:${uid}`].sort();
  for (const bucket of buckets) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`peakos-os-email-auth:${bucket}`],
    );
  }
}

async function lockUidBucket(client, uid) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`peakos-os-email-auth:uid:${uid}`],
  );
}

function countResult(result) {
  return {
    count: Number(result.rows[0]?.request_count || result.rows[0]?.attempt_count || 0),
    oldest: result.rows[0]?.oldest || null,
  };
}

function createPgOsEmailAuthRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A pg Pool with query() and connect() is required.');
  }

  return Object.freeze({
    async reserveChallenge(challenge, limits) {
      return withTransaction(pool, async client => {
        await lockRateBuckets(client, challenge.uid, challenge.ipHash);
        const windowStart = new Date(challenge.now.getTime() - limits.rateWindowMs);
        const latest = await client.query(
          `SELECT created_at
             FROM peakos_os_email_challenges
            WHERE uid = $1
              AND delivery_status IN ('PENDING', 'SENT')
              AND invalidated_at IS NULL
              AND expires_at > $2
            ORDER BY created_at DESC
            LIMIT 1`,
          [challenge.uid, challenge.now],
        );
        if (latest.rows[0]) {
          const remaining = new Date(latest.rows[0].created_at).getTime()
            + limits.resendCooldownMs - challenge.now.getTime();
          if (remaining > 0) return { ok: false, reason: 'COOLDOWN', retryAfter: retryAfterSeconds(remaining) };
        }

        const userCount = countResult(await client.query(
          `SELECT COUNT(*)::integer AS request_count, MIN(created_at) AS oldest
             FROM peakos_os_email_challenges
            WHERE uid = $1 AND created_at >= $2`,
          [challenge.uid, windowStart],
        ));
        if (userCount.count >= limits.requestUserLimit) {
          return {
            ok: false,
            reason: 'USER_RATE_LIMIT',
            retryAfter: rateRetryAfter(userCount.oldest, challenge.now, limits.rateWindowMs),
          };
        }

        const ipCount = countResult(await client.query(
          `SELECT COUNT(*)::integer AS request_count, MIN(created_at) AS oldest
             FROM peakos_os_email_challenges
            WHERE requester_ip_hash = $1 AND created_at >= $2`,
          [challenge.ipHash, windowStart],
        ));
        if (ipCount.count >= limits.requestIpLimit) {
          return {
            ok: false,
            reason: 'IP_RATE_LIMIT',
            retryAfter: rateRetryAfter(ipCount.oldest, challenge.now, limits.rateWindowMs),
          };
        }

        await client.query(
          `INSERT INTO peakos_os_email_challenges
            (id, uid, code_hash, requester_ip_hash, delivery_status,
             failed_attempts, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'PENDING', 0, $5, $6)`,
          [
            challenge.id,
            challenge.uid,
            challenge.codeHash,
            challenge.ipHash,
            challenge.now,
            challenge.expiresAt,
          ],
        );
        return { ok: true };
      });
    },

    async markChallengeSent(id, uid, now) {
      return withTransaction(pool, async client => {
        await lockUidBucket(client, uid);
        const currentResult = await client.query(
          `SELECT id, created_at
             FROM peakos_os_email_challenges
            WHERE id = $1 AND uid = $2 AND delivery_status = 'PENDING'
            FOR UPDATE`,
          [id, uid],
        );
        const current = currentResult.rows[0];
        if (!current) throw new Error('OS_AUTH_CHALLENGE_STATE_CONFLICT');
        const newerResult = await client.query(
          `SELECT 1
             FROM peakos_os_email_challenges
            WHERE uid = $1 AND id <> $2
              AND created_at > $3
              AND delivery_status IN ('PENDING', 'SENT')
              AND invalidated_at IS NULL
              AND expires_at > $4
            LIMIT 1`,
          [uid, id, current.created_at, now],
        );
        if (newerResult.rows.length) {
          await client.query(
            `UPDATE peakos_os_email_challenges
                SET delivery_status = 'SENT', sent_at = $3, invalidated_at = $3
              WHERE id = $1 AND uid = $2 AND delivery_status = 'PENDING'`,
            [id, uid, now],
          );
          return { active: false };
        }
        const sent = await client.query(
          `UPDATE peakos_os_email_challenges
              SET delivery_status = 'SENT', sent_at = $3
            WHERE id = $1 AND uid = $2 AND delivery_status = 'PENDING'
          RETURNING id`,
          [id, uid, now],
        );
        if (!sent.rows.length) throw new Error('OS_AUTH_CHALLENGE_STATE_CONFLICT');
        await client.query(
          `UPDATE peakos_os_email_challenges
              SET invalidated_at = $3
            WHERE uid = $1 AND id <> $2
              AND delivery_status = 'SENT'
              AND consumed_at IS NULL
              AND invalidated_at IS NULL`,
          [uid, id, now],
        );
        return { active: true };
      });
    },

    async markChallengeDeliveryFailed(id, uid, now) {
      await pool.query(
        `UPDATE peakos_os_email_challenges
            SET delivery_status = 'FAILED', invalidated_at = $3
          WHERE id = $1 AND uid = $2 AND delivery_status = 'PENDING'`,
        [id, uid, now],
      );
    },

    async verifyChallenge(input, limits) {
      return withTransaction(pool, async client => {
        await lockRateBuckets(client, input.uid, input.ipHash);
        const windowStart = new Date(input.now.getTime() - limits.rateWindowMs);
        const userCount = countResult(await client.query(
          `SELECT COUNT(*)::integer AS attempt_count, MIN(created_at) AS oldest
             FROM peakos_os_email_verify_attempts
            WHERE uid = $1 AND created_at >= $2`,
          [input.uid, windowStart],
        ));
        if (userCount.count >= limits.verifyUserLimit) {
          return {
            status: 'RATE_LIMITED',
            retryAfter: rateRetryAfter(userCount.oldest, input.now, limits.rateWindowMs),
          };
        }
        const ipCount = countResult(await client.query(
          `SELECT COUNT(*)::integer AS attempt_count, MIN(created_at) AS oldest
             FROM peakos_os_email_verify_attempts
            WHERE requester_ip_hash = $1 AND created_at >= $2`,
          [input.ipHash, windowStart],
        ));
        if (ipCount.count >= limits.verifyIpLimit) {
          return {
            status: 'RATE_LIMITED',
            retryAfter: rateRetryAfter(ipCount.oldest, input.now, limits.rateWindowMs),
          };
        }

        const challengeResult = await client.query(
          `SELECT id, code_hash, delivery_status, failed_attempts, expires_at,
                  consumed_at, invalidated_at
             FROM peakos_os_email_challenges
            WHERE id = $1 AND uid = $2
            FOR UPDATE`,
          [input.challengeId, input.uid],
        );
        const challenge = challengeResult.rows[0] || null;
        const active = Boolean(
          challenge
            && challenge.delivery_status === 'SENT'
            && !challenge.consumed_at
            && !challenge.invalidated_at
            && Number(challenge.failed_attempts) < limits.maxCodeFailures
            && new Date(challenge.expires_at).getTime() > input.now.getTime(),
        );
        const matched = active && safeEqualHex(challenge.code_hash, input.codeHash);

        if (!matched) {
          let remaining = 0;
          if (active) {
            const failures = Number(challenge.failed_attempts) + 1;
            remaining = Math.max(0, limits.maxCodeFailures - failures);
            await client.query(
              `UPDATE peakos_os_email_challenges
                  SET failed_attempts = $2,
                      invalidated_at = CASE WHEN $2 >= $3 THEN $4 ELSE invalidated_at END
                WHERE id = $1`,
              [challenge.id, failures, limits.maxCodeFailures, input.now],
            );
          }
          await client.query(
            `INSERT INTO peakos_os_email_verify_attempts
              (uid, challenge_id, requester_ip_hash, succeeded, created_at)
             VALUES ($1, $2, $3, false, $4)`,
            [input.uid, challenge?.id || null, input.ipHash, input.now],
          );
          return { status: 'INVALID', attemptsRemaining: remaining };
        }

        await client.query(
          `UPDATE peakos_os_email_challenges
              SET consumed_at = $2
            WHERE id = $1 AND consumed_at IS NULL`,
          [challenge.id, input.now],
        );
        await client.query(
          `INSERT INTO peakos_os_sessions
            (token_hash, uid, requester_ip_hash, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.sessionTokenHash, input.uid, input.ipHash, input.now, input.sessionExpiresAt],
        );
        await client.query(
          `INSERT INTO peakos_os_email_verify_attempts
            (uid, challenge_id, requester_ip_hash, succeeded, created_at)
           VALUES ($1, $2, $3, true, $4)`,
          [input.uid, challenge.id, input.ipHash, input.now],
        );
        return { status: 'VERIFIED', expiresAt: input.sessionExpiresAt };
      });
    },

    async findSession(tokenHash, uid, now) {
      const result = await pool.query(
        `SELECT uid, created_at, expires_at
           FROM peakos_os_sessions
          WHERE token_hash = $1
            AND uid = $2
            AND revoked_at IS NULL
            AND expires_at > $3`,
        [tokenHash, uid, now],
      );
      return result.rows[0] || null;
    },

    async revokeSession(tokenHash, uid, now) {
      await pool.query(
        `UPDATE peakos_os_sessions
            SET revoked_at = COALESCE(revoked_at, $3)
          WHERE token_hash = $1 AND uid = $2`,
        [tokenHash, uid, now],
      );
    },

    async purgeExpired(now) {
      const challengeCutoff = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
      await pool.query(
        'DELETE FROM peakos_os_email_verify_attempts WHERE created_at < $1',
        [challengeCutoff],
      );
      await pool.query(
        'DELETE FROM peakos_os_email_challenges WHERE expires_at < $1',
        [challengeCutoff],
      );
      await pool.query(
        'DELETE FROM peakos_os_sessions WHERE expires_at < $1',
        [challengeCutoff],
      );
    },
  });
}

function buildOtpMessage(code, expiresInMinutes) {
  return {
    subject: '[PEAK OS] 이메일 인증번호',
    text: `PEAK OS 추가 인증번호는 ${code}입니다. ${expiresInMinutes}분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.`,
    html: `<!doctype html><html lang="ko"><body><p>PEAK OS 추가 인증번호입니다.</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>${expiresInMinutes}분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.</p></body></html>`,
  };
}

function normalizeSender(value) {
  const sender = String(value || '').trim();
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(sender);
  if (!match) return { email: normalizeEmail(sender) };
  return { name: match[1].trim(), email: normalizeEmail(match[2]) };
}

function emailTransportTimeout(value = EMAIL_TRANSPORT_TIMEOUT_MS) {
  return positiveInteger(value, EMAIL_TRANSPORT_TIMEOUT_MS, 'transportTimeoutMs');
}

function transportTimeoutError() {
  const error = new Error('OS_AUTH_EMAIL_TRANSPORT_TIMEOUT');
  error.code = 'OS_AUTH_EMAIL_TRANSPORT_TIMEOUT';
  return error;
}

async function withTransportTimeout(operation, timeoutMs, onTimeout = () => {}) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout(); } catch (_) {}
      reject(transportTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } catch (error) {
    if (timedOut) throw transportTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEmailApi(fetchImpl, url, request, timeoutMs) {
  const controller = new AbortController();
  return withTransportTimeout(
    () => fetchImpl(url, { ...request, signal: controller.signal }),
    timeoutMs,
    () => controller.abort(),
  );
}

function createResendMailer({
  apiKey,
  from,
  fetchImpl = globalThis.fetch,
  transportTimeoutMs = EMAIL_TRANSPORT_TIMEOUT_MS,
} = {}) {
  if (!apiKey || !from) throw new TypeError('Resend apiKey and from are required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  const timeoutMs = emailTransportTimeout(transportTimeoutMs);
  return Object.freeze({
    async sendOtp({ to, subject, text, html }) {
      normalizeEmail(to);
      const response = await fetchEmailApi(fetchImpl, 'https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      }, timeoutMs);
      if (!response.ok) {
        const error = new Error('OS_AUTH_EMAIL_TRANSPORT_FAILED');
        error.code = 'OS_AUTH_EMAIL_TRANSPORT_FAILED';
        error.status = response.status;
        throw error;
      }
    },
  });
}

function createSendGridMailer({
  apiKey,
  from,
  fetchImpl = globalThis.fetch,
  transportTimeoutMs = EMAIL_TRANSPORT_TIMEOUT_MS,
} = {}) {
  if (!apiKey || !from) throw new TypeError('SendGrid apiKey and from are required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  const timeoutMs = emailTransportTimeout(transportTimeoutMs);
  const sender = normalizeSender(from);
  return Object.freeze({
    async sendOtp({ to, subject, text, html }) {
      normalizeEmail(to);
      const response = await fetchEmailApi(fetchImpl, 'https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: sender,
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html },
          ],
        }),
      }, timeoutMs);
      if (!response.ok) {
        const error = new Error('OS_AUTH_EMAIL_TRANSPORT_FAILED');
        error.code = 'OS_AUTH_EMAIL_TRANSPORT_FAILED';
        error.status = response.status;
        throw error;
      }
    },
  });
}

function smtpBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new TypeError('SMTP secure must be true or false.');
}

function loadNodemailer() {
  try {
    // Optional on purpose: deployments using Resend/SendGrid do not need this
    // package. SMTP deployments install nodemailer and this adapter picks it up.
    return require('nodemailer');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

function createSmtpMailer({
  host,
  port = 587,
  secure,
  user,
  pass,
  from,
  nodemailerImpl = loadNodemailer(),
  transportTimeoutMs = EMAIL_TRANSPORT_TIMEOUT_MS,
} = {}) {
  const normalizedHost = String(host || '').trim();
  const normalizedPort = Number(port);
  if (!normalizedHost || /[\r\n\p{Cc}\s]/u.test(normalizedHost)) {
    throw new TypeError('SMTP host is required.');
  }
  if (!Number.isSafeInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new TypeError('SMTP port must be between 1 and 65535.');
  }
  if (!user || !pass) throw new TypeError('SMTP user and pass are required.');
  const sender = String(from || user || '').trim();
  normalizeSender(sender);
  if (!nodemailerImpl || typeof nodemailerImpl.createTransport !== 'function') return null;
  const useSecure = smtpBoolean(secure, normalizedPort === 465);
  const timeoutMs = emailTransportTimeout(transportTimeoutMs);
  const transportOptions = {
    host: normalizedHost,
    port: normalizedPort,
    secure: useSecure,
    auth: { user: String(user), pass: String(pass) },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
  return Object.freeze({
    async sendOtp({ to, subject, text, html }) {
      normalizeEmail(to);
      const transport = nodemailerImpl.createTransport(transportOptions);
      if (!transport || typeof transport.sendMail !== 'function') {
        throw new TypeError('nodemailer transport.sendMail() is required.');
      }
      try {
        await withTransportTimeout(
          () => transport.sendMail({ from: sender, to, subject, text, html }),
          timeoutMs,
          () => transport.close?.(),
        );
      } finally {
        try { transport.close?.(); } catch (_) {}
      }
    },
  });
}

function createEmailMailerFromEnv(environment = process.env, options = {}) {
  const provider = String(environment.PEAKOS_OS_EMAIL_PROVIDER || '').trim().toLowerCase();
  const from = environment.PEAKOS_OS_EMAIL_FROM;
  if (!provider) return null;
  if (provider === 'resend') {
    return createResendMailer({
      apiKey: environment.RESEND_API_KEY,
      from,
      fetchImpl: options.fetchImpl,
      transportTimeoutMs: options.transportTimeoutMs,
    });
  }
  if (provider === 'sendgrid') {
    return createSendGridMailer({
      apiKey: environment.SENDGRID_API_KEY,
      from,
      fetchImpl: options.fetchImpl,
      transportTimeoutMs: options.transportTimeoutMs,
    });
  }
  if (provider === 'smtp') {
    return createSmtpMailer({
      host: environment.PEAKOS_OS_SMTP_HOST || environment.SMTP_HOST,
      port: environment.PEAKOS_OS_SMTP_PORT || environment.SMTP_PORT || 587,
      secure: environment.PEAKOS_OS_SMTP_SECURE ?? environment.SMTP_SECURE,
      user: environment.PEAKOS_OS_SMTP_USER || environment.SMTP_USER,
      pass: environment.PEAKOS_OS_SMTP_PASS || environment.SMTP_PASS,
      from: from || environment.PEAKOS_OS_SMTP_USER || environment.SMTP_USER,
      nodemailerImpl: options.nodemailerImpl === undefined
        ? loadNodemailer()
        : options.nodemailerImpl,
      transportTimeoutMs: options.transportTimeoutMs,
    });
  }
  throw new TypeError('PEAKOS_OS_EMAIL_PROVIDER must be smtp, resend, or sendgrid.');
}

function normalizeMailer(mailer) {
  if (mailer === undefined || mailer === null) return null;
  if (typeof mailer === 'function') return { sendOtp: mailer };
  if (mailer && typeof mailer.sendOtp === 'function') return mailer;
  throw new TypeError('mailer.sendOtp() is required.');
}

function safeLog(logger, label, error) {
  if (!logger || typeof logger.error !== 'function') return;
  const rawCode = String(error?.code || '');
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode)
    ? rawCode
    : 'UNEXPECTED';
  // Never pass the original error: a transport may include recipient or body.
  logger.error(`${label}: ${code}`);
}

function sendKnownError(res, error, logger) {
  if (error instanceof OsEmailAuthError) {
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    const state = error.state || {
      verified: false,
      required: true,
      maskedEmail: null,
      challengeId: null,
      expiresInSeconds: null,
      retryAfterSeconds: null,
    };
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      ...state,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  }
  safeLog(logger, 'PEAK OS email auth failure', error);
  return res.status(500).json({
    error: 'PEAK OS 추가 인증을 처리하지 못했습니다.',
    code: 'OS_AUTH_INTERNAL_ERROR',
    verified: false,
    required: true,
    maskedEmail: null,
    challengeId: null,
    expiresInSeconds: null,
    retryAfterSeconds: null,
  });
}

function createOsEmailAuth({
  pool,
  repository,
  mailer,
  logger = console,
  now = () => new Date(),
  randomInt = crypto.randomInt,
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
  getClientIp = defaultGetClientIp,
  otpRequirementPolicy,
  isOtpRequired,
  ...rawOptions
} = {}) {
  const options = normalizeOptions(rawOptions);
  const repo = repository || createPgOsEmailAuthRepository(pool);
  const emailMailer = normalizeMailer(mailer);
  let otpRequiredFor;
  if (typeof isOtpRequired === 'function') {
    otpRequiredFor = isOtpRequired;
  } else {
    const requirementPolicy = otpRequirementPolicy || createOtpRequirementPolicy(rawOptions);
    otpRequiredFor = uid => requirementPolicy.isRequired(uid);
  }
  if (typeof randomInt !== 'function' || typeof randomBytes !== 'function' || typeof randomUUID !== 'function') {
    throw new TypeError('Cryptographic random generators are required.');
  }
  if (typeof getClientIp !== 'function') throw new TypeError('getClientIp must be a function.');

  function requiredFor(req) {
    return otpRequiredFor(String(req.uid)) === true;
  }

  function responseState({
    verified,
    required,
    maskedEmail = null,
    challengeId = null,
    expiresInSeconds = null,
    retryAfterSeconds = null,
  }) {
    return {
      verified: verified === true,
      required: required === true,
      maskedEmail,
      challengeId,
      expiresInSeconds,
      retryAfterSeconds,
    };
  }

  async function requestEmail(req, res) {
    preventAuthResponseCaching(res);
    try {
      requireApprovedAndActive(req);
      const required = requiredFor(req);
      if (!required) {
        return res.json(responseState({ verified: true, required: false }));
      }
      // Deliberately ignore body.email. The database-backed user document loaded
      // by authMiddleware is the only recipient source.
      const email = normalizeEmail(req.userDoc.email);
      if (!emailMailer) {
        throw new OsEmailAuthError(
          '이메일 인증 발송 설정이 준비되지 않았습니다.',
          'OS_AUTH_EMAIL_NOT_CONFIGURED',
          503,
          null,
          responseState({ verified: false, required: true, maskedEmail: maskEmail(email) }),
        );
      }
      const createdAt = currentDate(now);
      const challengeId = randomUUID();
      if (!UUID_PATTERN.test(challengeId)) throw new TypeError('randomUUID returned an invalid UUID.');
      const code = generateSixDigitCode(randomInt);
      const ipHash = hashIp(options.hmacSecret, getClientIp(req));
      const expiresAt = new Date(createdAt.getTime() + options.challengeTtlMs);
      const reservation = await repo.reserveChallenge({
        id: challengeId,
        uid: req.uid,
        codeHash: hashOtp(options.hmacSecret, challengeId, req.uid, code),
        ipHash,
        now: createdAt,
        expiresAt,
      }, options);
      if (!reservation.ok) {
        throw new OsEmailAuthError(
          '인증번호 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
          reservation.reason === 'COOLDOWN' ? 'OS_AUTH_RESEND_COOLDOWN' : 'OS_AUTH_REQUEST_RATE_LIMITED',
          429,
          reservation.retryAfter,
        );
      }

      const expiresInMinutes = Math.ceil(options.challengeTtlMs / 60_000);
      const message = buildOtpMessage(code, expiresInMinutes);
      let activation;
      try {
        await emailMailer.sendOtp({
          to: email,
          code,
          challengeId,
          expiresAt,
          expiresInMinutes,
          ...message,
        });
        activation = await repo.markChallengeSent(challengeId, req.uid, currentDate(now));
      } catch (error) {
        await repo.markChallengeDeliveryFailed(challengeId, req.uid, currentDate(now)).catch(() => {});
        safeLog(logger, 'PEAK OS OTP delivery failure', error);
        throw new OsEmailAuthError(
          '인증번호 이메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.',
          'OS_AUTH_EMAIL_UNAVAILABLE',
          503,
        );
      }
      if (activation?.active === false) {
        throw new OsEmailAuthError(
          '더 최근에 발송된 인증번호를 사용해 주세요.',
          'OS_AUTH_CHALLENGE_SUPERSEDED',
          409,
          null,
          responseState({ verified: false, required: true, maskedEmail: maskEmail(email) }),
        );
      }

      return res.status(202).json({
        ...responseState({
          verified: false,
          required: true,
          challengeId,
          maskedEmail: maskEmail(email),
          expiresInSeconds: retryAfterSeconds(options.challengeTtlMs),
          retryAfterSeconds: retryAfterSeconds(options.resendCooldownMs),
        }),
      });
    } catch (error) {
      return sendKnownError(res, error, logger);
    }
  }

  async function verifyEmail(req, res) {
    preventAuthResponseCaching(res);
    try {
      requireApprovedAndActive(req);
      const required = requiredFor(req);
      if (!required) {
        return res.json(responseState({ verified: true, required: false }));
      }
      const challengeId = String(req.body?.challengeId || '').trim();
      const code = String(req.body?.code || '').trim();
      if (!UUID_PATTERN.test(challengeId) || !CODE_PATTERN.test(code)) {
        throw new OsEmailAuthError(
          '인증번호 형식이 올바르지 않습니다.',
          'OS_AUTH_CODE_FORMAT_INVALID',
          400,
        );
      }
      const verifiedAt = currentDate(now);
      const ipHash = hashIp(options.hmacSecret, getClientIp(req));
      const sessionToken = randomBytes(32).toString('base64url');
      if (!SESSION_TOKEN_PATTERN.test(sessionToken)) throw new TypeError('randomBytes returned invalid data.');
      const sessionExpiresAt = new Date(verifiedAt.getTime() + options.sessionTtlMs);
      const result = await repo.verifyChallenge({
        uid: req.uid,
        challengeId,
        codeHash: hashOtp(options.hmacSecret, challengeId, req.uid, code),
        ipHash,
        now: verifiedAt,
        sessionTokenHash: hashSessionToken(options.hmacSecret, sessionToken),
        sessionExpiresAt,
      }, options);
      if (result.status === 'RATE_LIMITED') {
        throw new OsEmailAuthError(
          '인증번호 확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
          'OS_AUTH_VERIFY_RATE_LIMITED',
          429,
          result.retryAfter,
        );
      }
      if (result.status !== 'VERIFIED') {
        throw new OsEmailAuthError(
          '인증번호가 올바르지 않거나 만료되었습니다.',
          'OS_AUTH_CODE_INVALID',
          401,
        );
      }
      setSessionCookie(res, sessionToken, options.sessionTtlMs);
      return res.json(responseState({
        verified: true,
        required: true,
        maskedEmail: maskEmail(req.userDoc.email),
        challengeId,
        expiresInSeconds: retryAfterSeconds(result.expiresAt.getTime() - verifiedAt.getTime()),
      }));
    } catch (error) {
      return sendKnownError(res, error, logger);
    }
  }

  async function osSessionMiddleware(req, res, next) {
    preventAuthResponseCaching(res);
    try {
      requireApprovedAndActive(req);
      const required = requiredFor(req);
      if (!required) {
        req.osSecondAuth = Object.freeze({ required: false, verified: true });
        return next();
      }
      const token = getSessionToken(req);
      if (!token) {
        // 이 응답이 늦게 도착하는 사이 다른 탭에서 인증을 마칠 수 있다.
        // 여기서 삭제 쿠키를 보내면 그 새 세션까지 지우므로, 명시적 로그아웃
        // 외에는 공유 쿠키를 자동 삭제하지 않는다.
        throw new OsEmailAuthError(
          'PEAK OS 추가 인증이 필요합니다.',
          'OS_AUTH_SESSION_REQUIRED',
          401,
          null,
          responseState({ verified: false, required: true }),
        );
      }
      const checkedAt = currentDate(now);
      const session = await repo.findSession(
        hashSessionToken(options.hmacSecret, token),
        req.uid,
        checkedAt,
      );
      if (!session) {
        throw new OsEmailAuthError(
          'PEAK OS 추가 인증이 만료되었습니다.',
          'OS_AUTH_SESSION_INVALID',
          401,
          null,
          responseState({ verified: false, required: true }),
        );
      }
      req.osSession = Object.freeze({
        uid: session.uid,
        createdAt: new Date(session.created_at),
        expiresAt: new Date(session.expires_at),
      });
      req.osSecondAuth = Object.freeze({
        required: true,
        verified: true,
        uid: session.uid,
        createdAt: new Date(session.created_at),
        expiresAt: new Date(session.expires_at),
      });
      return next();
    } catch (error) {
      return sendKnownError(res, error, logger);
    }
  }

  async function sessionStatus(req, res) {
    preventAuthResponseCaching(res);
    try {
      requireApprovedAndActive(req);
      const required = requiredFor(req);
      if (!required) {
        req.osSecondAuth = Object.freeze({ required: false, verified: true });
        return res.json(responseState({ verified: true, required: false }));
      }
      const maskedEmail = maskEmail(req.userDoc.email);
      const token = getSessionToken(req);
      if (!token) {
        return res.json(responseState({ verified: false, required: true, maskedEmail }));
      }
      const checkedAt = currentDate(now);
      const session = await repo.findSession(
        hashSessionToken(options.hmacSecret, token),
        req.uid,
        checkedAt,
      );
      if (!session) {
        return res.json(responseState({ verified: false, required: true, maskedEmail }));
      }
      req.osSecondAuth = Object.freeze({
        required: true,
        verified: true,
        uid: session.uid,
        createdAt: new Date(session.created_at),
        expiresAt: new Date(session.expires_at),
      });
      return res.json(responseState({
        verified: true,
        required: true,
        maskedEmail,
        expiresInSeconds: Math.max(
          0,
          retryAfterSeconds(req.osSecondAuth.expiresAt.getTime() - checkedAt.getTime()),
        ),
      }));
    } catch (error) {
      return sendKnownError(res, error, logger);
    }
  }

  async function logout(req, res) {
    preventAuthResponseCaching(res);
    try {
      requireApprovedAndActive(req);
      const token = getSessionToken(req);
      if (token) {
        await repo.revokeSession(
          hashSessionToken(options.hmacSecret, token),
          req.uid,
          currentDate(now),
        );
      }
      clearSessionCookie(res);
      return res.status(204).end();
    } catch (error) {
      clearSessionCookie(res);
      return sendKnownError(res, error, logger);
    }
  }

  return Object.freeze({
    requestEmail,
    verifyEmail,
    requireOsSession: osSessionMiddleware,
    sessionStatus,
    logout,
    repository: repo,
  });
}

function requireOsSession(options) {
  return createOsEmailAuth({
    ...options,
    // Session checks never send email, but the common factory validates the
    // interface. A no-op mailer keeps this exported middleware factory small.
    mailer: options?.mailer,
  }).requireOsSession;
}

function registerOsEmailAuth({ app, authMiddleware, ...options } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app.get() and app.post() are required.');
  }
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware is required.');
  const auth = createOsEmailAuth(options);
  app.post('/api/os-auth/email/request', authMiddleware, auth.requestEmail);
  app.post('/api/os-auth/email/verify', authMiddleware, auth.verifyEmail);
  app.get('/api/os-auth/session', authMiddleware, auth.sessionStatus);
  app.post('/api/os-auth/logout', authMiddleware, auth.logout);
  return auth;
}

async function ensureOsEmailAuthInfrastructure(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query() is required.');
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260808_peakos_os_email_auth.sql');
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
}

module.exports = {
  CHALLENGE_TTL_MS,
  COOKIE_NAME,
  EMAIL_TRANSPORT_TIMEOUT_MS,
  MAX_CODE_FAILURES,
  RATE_WINDOW_MS,
  RESEND_COOLDOWN_MS,
  SESSION_TTL_MS,
  OsEmailAuthError,
  approvedAndActive,
  buildOtpMessage,
  createEmailMailerFromEnv,
  createOtpRequirementPolicy,
  createOsEmailAuth,
  createPgOsEmailAuthRepository,
  createResendMailer,
  createSendGridMailer,
  createSmtpMailer,
  defaultGetClientIp,
  ensureOsEmailAuthInfrastructure,
  generateSixDigitCode,
  hashIp,
  hashOtp,
  hashSessionToken,
  maskEmail,
  parseCookies,
  registerOsEmailAuth,
  requireOsSession,
  safeEqualHex,
};
