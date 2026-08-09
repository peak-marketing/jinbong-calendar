'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  COOKIE_NAME,
  EMAIL_TRANSPORT_TIMEOUT_MS,
  createEmailMailerFromEnv,
  createOsEmailAuth,
  createOtpRequirementPolicy,
  createResendMailer,
  createSendGridMailer,
  createSmtpMailer,
  ensureOsEmailAuthInfrastructure,
  generateSixDigitCode,
  hashSessionToken,
  maskEmail,
  registerOsEmailAuth,
  safeEqualHex,
} = require('./peakos-os-email-auth');

const SECRET = 'test-only-hmac-secret-with-at-least-32-bytes';
const FIXED_NOW = new Date('2026-08-08T08:00:00.000Z');
const CHALLENGE_ID = '5fc91199-6e65-4d60-90ca-92a21eb7811d';
const CODE = '041027';

function makeRequest(overrides = {}) {
  return {
    uid: 'owner-uid',
    userDoc: {
      uid: 'owner-uid',
      approved: true,
      is_active: true,
      email: 'owner@paragon-info.kr',
      name: '대표',
    },
    body: {},
    headers: {},
    ip: '203.0.113.10',
    ...overrides,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    cookieCall: null,
    clearCookieCall: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    cookie(name, value, options) {
      this.cookieCall = { name, value, options };
      return this;
    },
    clearCookie(name, options) {
      this.clearCookieCall = { name, options };
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

class MemoryRepository {
  constructor() {
    this.challenges = new Map();
    this.sessions = new Map();
    this.reservationResult = { ok: true };
    this.reserveCalls = [];
    this.revokeCalls = [];
  }

  async reserveChallenge(challenge, limits) {
    this.reserveCalls.push({ challenge, limits });
    if (!this.reservationResult.ok) return this.reservationResult;
    this.challenges.set(challenge.id, {
      ...challenge,
      sent: false,
      consumed: false,
      failures: 0,
      invalidated: false,
    });
    return { ok: true };
  }

  async markChallengeSent(id, uid) {
    const challenge = this.challenges.get(id);
    assert.equal(challenge.uid, uid);
    challenge.sent = true;
    return { active: true };
  }

  async markChallengeDeliveryFailed(id) {
    const challenge = this.challenges.get(id);
    if (challenge) challenge.invalidated = true;
  }

  async verifyChallenge(input, limits) {
    const challenge = this.challenges.get(input.challengeId);
    const active = challenge
      && challenge.uid === input.uid
      && challenge.sent
      && !challenge.consumed
      && !challenge.invalidated
      && challenge.failures < limits.maxCodeFailures
      && challenge.expiresAt > input.now;
    if (!active || !safeEqualHex(challenge.codeHash, input.codeHash)) {
      if (active) {
        challenge.failures += 1;
        if (challenge.failures >= limits.maxCodeFailures) challenge.invalidated = true;
      }
      return { status: 'INVALID', attemptsRemaining: Math.max(0, limits.maxCodeFailures - (challenge?.failures || 0)) };
    }
    challenge.consumed = true;
    this.sessions.set(input.sessionTokenHash, {
      uid: input.uid,
      created_at: input.now,
      expires_at: input.sessionExpiresAt,
      revoked_at: null,
    });
    return { status: 'VERIFIED', expiresAt: input.sessionExpiresAt };
  }

  async findSession(tokenHash, uid, now) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.uid !== uid || session.revoked_at || session.expires_at <= now) return null;
    return session;
  }

  async revokeSession(tokenHash, uid, now) {
    this.revokeCalls.push({ tokenHash, uid, now });
    const session = this.sessions.get(tokenHash);
    if (session?.uid === uid) session.revoked_at = now;
  }
}

function buildAuth(overrides = {}) {
  const repository = overrides.repository || new MemoryRepository();
  const deliveries = [];
  const logs = [];
  const auth = createOsEmailAuth({
    repository,
    hmacSecret: SECRET,
    now: () => FIXED_NOW,
    randomInt: () => Number(CODE),
    randomUUID: () => CHALLENGE_ID,
    randomBytes: () => Buffer.alloc(32, 7),
    isOtpRequired: uid => uid === 'owner-uid',
    mailer: {
      async sendOtp(message) {
        deliveries.push(message);
      },
    },
    logger: { error(message) { logs.push(message); } },
    ...overrides,
  });
  return { auth, repository, deliveries, logs };
}

function assertStateKeys(body) {
  for (const key of [
    'verified',
    'required',
    'maskedEmail',
    'challengeId',
    'expiresInSeconds',
    'retryAfterSeconds',
  ]) {
    assert.equal(Object.hasOwn(body, key), true, `missing response key: ${key}`);
  }
}

test('six-digit code generation includes leading zeroes and rejects a broken RNG', () => {
  assert.equal(generateSixDigitCode(() => 0), '000000');
  assert.equal(generateSixDigitCode(() => 999999), '999999');
  assert.throws(() => generateSixDigitCode(() => 1000000), /out-of-range/);
});

test('email masking never returns the full local part', () => {
  assert.equal(maskEmail('owner@paragon-info.kr'), 'ow***@paragon-info.kr');
  assert.equal(maskEmail('a@paragon-info.kr'), '****@paragon-info.kr');
  assert.throws(() => maskEmail('line\nbreak@example.com'), /이메일/);
});

test('pilot requirement policy defaults to only listed UIDs and supports all/off', () => {
  const pilot = createOtpRequirementPolicy({ requiredUids: 'owner-uid, second-uid' });
  assert.equal(pilot.mode, 'pilot');
  assert.equal(pilot.isRequired('owner-uid'), true);
  assert.equal(pilot.isRequired('other'), false);
  assert.equal(createOtpRequirementPolicy({ mode: 'all' }).isRequired('anyone'), true);
  assert.equal(createOtpRequirementPolicy({ mode: 'off', requiredUids: 'owner-uid' }).isRequired('owner-uid'), false);
  assert.throws(() => createOtpRequirementPolicy({}), /OS_EMAIL_OTP_MODE/);
  assert.throws(() => createOtpRequirementPolicy({ mode: 'pilot' }), /at least one/);
  assert.throws(() => createOtpRequirementPolicy({ mode: 'surprise' }), /all, off, or pilot/);
});

test('request sends only to req.userDoc.email and exposes neither code nor full email', async () => {
  const { auth, repository, deliveries, logs } = buildAuth();
  const response = makeResponse();
  await auth.requestEmail(
    makeRequest({ body: { email: 'attacker@example.net' } }),
    response,
  );

  assert.equal(response.statusCode, 202);
  assertStateKeys(response.body);
  assert.deepEqual(response.body, {
    verified: false,
    required: true,
    maskedEmail: 'ow***@paragon-info.kr',
    challengeId: CHALLENGE_ID,
    expiresInSeconds: 300,
    retryAfterSeconds: 60,
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'owner@paragon-info.kr');
  assert.equal(deliveries[0].code, CODE);
  assert.notEqual(repository.reserveCalls[0].challenge.codeHash, CODE);
  assert.equal(repository.reserveCalls[0].limits.requestUserLimit, 5);
  assert.equal(repository.reserveCalls[0].limits.requestIpLimit, 100);
  assert.equal(repository.reserveCalls[0].limits.verifyUserLimit, 15);
  assert.equal(repository.reserveCalls[0].limits.verifyIpLimit, 300);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(CODE));
  assert.doesNotMatch(JSON.stringify(response.body), /owner@paragon-info\.kr/);
  assert.deepEqual(logs, []);
});

test('missing mail transport fails request with 503 before creating or exposing a code', async () => {
  const repository = new MemoryRepository();
  const auth = createOsEmailAuth({
    repository,
    hmacSecret: SECRET,
    isOtpRequired: () => true,
    logger: { error() { throw new Error('must not log configuration or secrets'); } },
  });
  const response = makeResponse();
  await auth.requestEmail(makeRequest(), response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'OS_AUTH_EMAIL_NOT_CONFIGURED');
  assertStateKeys(response.body);
  assert.equal(repository.reserveCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(response.body), /owner@paragon-info\.kr/);
  assert.doesNotMatch(JSON.stringify(response.body), /\b\d{6}\b/);
});

test('mail transport failures never log the OTP or full recipient address', async () => {
  const logs = [];
  const { auth } = buildAuth({
    mailer: {
      async sendOtp() {
        const error = new Error(`${CODE} owner@paragon-info.kr`);
        throw error;
      },
    },
    logger: { error(message) { logs.push(message); } },
  });
  const response = makeResponse();
  await auth.requestEmail(makeRequest(), response);
  assert.equal(response.statusCode, 503);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], 'PEAK OS OTP delivery failure: UNEXPECTED');
  assert.doesNotMatch(logs.join('\n'), new RegExp(CODE));
  assert.doesNotMatch(logs.join('\n'), /owner@paragon-info\.kr/);
});

test('unapproved or inactive accounts cannot request an OTP', async () => {
  for (const userDoc of [
    { approved: false, is_active: true, email: 'owner@paragon-info.kr' },
    { approved: true, is_active: false, email: 'owner@paragon-info.kr' },
  ]) {
    const { auth, deliveries } = buildAuth();
    const response = makeResponse();
    await auth.requestEmail(makeRequest({ userDoc }), response);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'OS_AUTH_USER_NOT_ALLOWED');
    assert.equal(deliveries.length, 0);
  }
});

test('cooldown uses Retry-After and retryAfterSeconds, never the legacy retryAfter key', async () => {
  const repository = new MemoryRepository();
  repository.reservationResult = { ok: false, reason: 'COOLDOWN', retryAfter: 41 };
  const { auth } = buildAuth({ repository });
  const response = makeResponse();
  await auth.requestEmail(makeRequest(), response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '41');
  assert.equal(response.body.retryAfterSeconds, 41);
  assert.equal(Object.hasOwn(response.body, 'retryAfter'), false);
});

test('successful verification creates an eight-hour hashed session and a hardened cookie', async () => {
  const { auth, repository } = buildAuth();
  await auth.requestEmail(makeRequest(), makeResponse());
  const response = makeResponse();
  await auth.verifyEmail(makeRequest({ body: { challengeId: CHALLENGE_ID, code: CODE } }), response);

  assert.equal(response.statusCode, 200);
  assertStateKeys(response.body);
  assert.equal(response.body.verified, true);
  assert.equal(response.body.required, true);
  assert.equal(response.body.expiresInSeconds, 8 * 60 * 60);
  assert.equal(response.cookieCall.name, COOKIE_NAME);
  assert.equal(response.cookieCall.options.httpOnly, true);
  assert.equal(response.cookieCall.options.secure, true);
  assert.equal(response.cookieCall.options.sameSite, 'strict');
  assert.equal(response.cookieCall.options.path, '/');
  assert.equal(response.cookieCall.options.maxAge, 8 * 60 * 60 * 1000);
  const rawToken = response.cookieCall.value;
  assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(repository.sessions.has(rawToken), false);
  assert.equal(repository.sessions.has(hashSessionToken(SECRET, rawToken)), true);

  const replay = makeResponse();
  await auth.verifyEmail(makeRequest({ body: { challengeId: CHALLENGE_ID, code: CODE } }), replay);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.verified, false);
});

test('a challenge is locked after five failed six-digit attempts', async () => {
  const { auth, repository } = buildAuth();
  await auth.requestEmail(makeRequest(), makeResponse());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = makeResponse();
    await auth.verifyEmail(makeRequest({
      body: { challengeId: CHALLENGE_ID, code: '999999' },
    }), response);
    assert.equal(response.statusCode, 401);
  }
  assert.equal(repository.challenges.get(CHALLENGE_ID).failures, 5);
  assert.equal(repository.challenges.get(CHALLENGE_ID).invalidated, true);

  const afterLock = makeResponse();
  await auth.verifyEmail(makeRequest({ body: { challengeId: CHALLENGE_ID, code: CODE } }), afterLock);
  assert.equal(afterLock.statusCode, 401);
  assert.equal(afterLock.cookieCall, null);
});

test('session middleware binds the cookie session to the current Firebase UID', async () => {
  const { auth } = buildAuth({ isOtpRequired: () => true });
  await auth.requestEmail(makeRequest(), makeResponse());
  const verified = makeResponse();
  await auth.verifyEmail(makeRequest({ body: { challengeId: CHALLENGE_ID, code: CODE } }), verified);
  const cookie = `${COOKIE_NAME}=${verified.cookieCall.value}`;

  const ownerRequest = makeRequest({ headers: { cookie } });
  let nextCalls = 0;
  await auth.requireOsSession(ownerRequest, makeResponse(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(
    { required: ownerRequest.osSecondAuth.required, verified: ownerRequest.osSecondAuth.verified },
    { required: true, verified: true },
  );

  const otherRequest = makeRequest({
    uid: 'different-uid',
    userDoc: { approved: true, is_active: true, email: 'different@paragon-info.kr' },
    headers: { cookie },
  });
  const rejected = makeResponse();
  await auth.requireOsSession(otherRequest, rejected, () => { nextCalls += 1; });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.body.code, 'OS_AUTH_SESSION_INVALID');
  assert.equal(rejected.clearCookieCall, null);
  assert.equal(nextCalls, 1);
});

test('off/non-pilot users pass without a cookie and GET session reports required=false', async () => {
  const { auth, repository, deliveries } = buildAuth();
  const request = makeRequest({
    uid: 'non-pilot-uid',
    userDoc: { approved: true, is_active: true, email: 'staff@paragon-info.kr' },
  });
  let nextCalls = 0;
  await auth.requireOsSession(request, makeResponse(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(request.osSecondAuth, { required: false, verified: true });

  const response = makeResponse();
  await auth.sessionStatus(request, response);
  assertStateKeys(response.body);
  assert.equal(response.body.verified, true);
  assert.equal(response.body.required, false);
  assert.equal(response.body.expiresInSeconds, null);
  assert.equal(repository.reserveCalls.length, 0);
  assert.equal(deliveries.length, 0);
});

test('GET session reports required=true and verified=false with 200 when cookie is absent', async () => {
  const { auth } = buildAuth();
  const response = makeResponse();
  await auth.sessionStatus(makeRequest(), response);
  assert.equal(response.statusCode, 200);
  assertStateKeys(response.body);
  assert.deepEqual(response.body, {
    verified: false,
    required: true,
    maskedEmail: 'ow***@paragon-info.kr',
    challengeId: null,
    expiresInSeconds: null,
    retryAfterSeconds: null,
  });
  // A passive probe may finish after another tab has just verified. It must not
  // carry a deletion Set-Cookie that could erase that newer shared session.
  assert.equal(response.clearCookieCall, null);
  assert.equal(response.headers['Cache-Control'], 'no-store, private');
  assert.equal(response.headers.Vary, 'Authorization, Cookie');
});

test('passive checks reject an invalid cookie without clearing a newer cross-tab session', async () => {
  const { auth } = buildAuth();
  const invalidCookie = `${COOKIE_NAME}=${'A'.repeat(43)}`;

  const statusResponse = makeResponse();
  await auth.sessionStatus(makeRequest({ headers: { cookie: invalidCookie } }), statusResponse);
  assert.equal(statusResponse.statusCode, 200);
  assert.equal(statusResponse.body.verified, false);
  assert.equal(statusResponse.clearCookieCall, null);

  const guardResponse = makeResponse();
  let nextCalls = 0;
  await auth.requireOsSession(
    makeRequest({ headers: { cookie: invalidCookie } }),
    guardResponse,
    () => { nextCalls += 1; },
  );
  assert.equal(guardResponse.statusCode, 401);
  assert.equal(guardResponse.body.code, 'OS_AUTH_SESSION_INVALID');
  assert.equal(guardResponse.clearCookieCall, null);
  assert.equal(guardResponse.headers['Cache-Control'], 'no-store, private');
  assert.equal(nextCalls, 0);
});

test('logout revokes only the current UID-bound token and clears the hardened cookie', async () => {
  const { auth, repository } = buildAuth();
  await auth.requestEmail(makeRequest(), makeResponse());
  const verified = makeResponse();
  await auth.verifyEmail(makeRequest({ body: { challengeId: CHALLENGE_ID, code: CODE } }), verified);
  const response = makeResponse();
  await auth.logout(makeRequest({
    headers: { cookie: `${COOKIE_NAME}=${verified.cookieCall.value}` },
  }), response);
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(repository.revokeCalls.length, 1);
  assert.equal(repository.revokeCalls[0].uid, 'owner-uid');
  assert.equal(response.clearCookieCall.name, COOKIE_NAME);
  assert.equal(response.clearCookieCall.options.httpOnly, true);
  assert.equal(response.clearCookieCall.options.secure, true);
  assert.equal(response.clearCookieCall.options.sameSite, 'strict');
});

test('route registration puts every endpoint behind the supplied Firebase middleware', () => {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
  const authMiddleware = (_req, _res, next) => next();
  registerOsEmailAuth({
    app,
    authMiddleware,
    repository: new MemoryRepository(),
    mailer: { sendOtp: async () => {} },
    hmacSecret: SECRET,
    isOtpRequired: () => true,
  });

  assert.equal(routes.get('POST /api/os-auth/email/request')[0], authMiddleware);
  assert.equal(routes.get('POST /api/os-auth/email/verify')[0], authMiddleware);
  assert.equal(routes.get('GET /api/os-auth/session')[0], authMiddleware);
  assert.equal(routes.get('POST /api/os-auth/logout')[0], authMiddleware);
  assert.equal(routes.get('GET /api/os-auth/session').length, 2);
});

test('Resend and SendGrid adapters use fetch without logging or parsing provider bodies', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 202 };
  };
  await createResendMailer({
    apiKey: 'resend-key',
    from: 'PEAK OS <security@paragon-info.kr>',
    fetchImpl,
  }).sendOtp({
    to: 'owner@paragon-info.kr',
    subject: 'subject',
    text: 'text',
    html: '<p>html</p>',
  });
  await createSendGridMailer({
    apiKey: 'sendgrid-key',
    from: 'PEAK OS <security@paragon-info.kr>',
    fetchImpl,
  }).sendOtp({
    to: 'owner@paragon-info.kr',
    subject: 'subject',
    text: 'text',
    html: '<p>html</p>',
  });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer resend-key');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls[1].url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer sendgrid-key');
  assert.equal(calls[1].options.signal instanceof AbortSignal, true);
  assert.equal(
    createEmailMailerFromEnv({
      PEAKOS_OS_EMAIL_PROVIDER: 'resend',
      PEAKOS_OS_EMAIL_FROM: 'security@paragon-info.kr',
      RESEND_API_KEY: 'key',
    }, { fetchImpl }).sendOtp instanceof Function,
    true,
  );
});

test('Resend and SendGrid abort a hung HTTP request at the transport deadline', async () => {
  for (const createMailer of [createResendMailer, createSendGridMailer]) {
    let signal;
    const mailer = createMailer({
      apiKey: 'api-key',
      from: 'security@paragon-info.kr',
      transportTimeoutMs: 20,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    });
    const startedAt = Date.now();
    await assert.rejects(
      mailer.sendOtp({
        to: 'owner@paragon-info.kr',
        subject: 'subject',
        text: 'text',
        html: '<p>html</p>',
      }),
      error => error?.code === 'OS_AUTH_EMAIL_TRANSPORT_TIMEOUT',
    );
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 500, 'HTTP mail timeout should reject promptly in the test');
  }
});

test('SMTP adapter supports Gmail app-password settings through injected nodemailer', async () => {
  const transportOptions = [];
  const messages = [];
  const nodemailerImpl = {
    createTransport(options) {
      transportOptions.push(options);
      return { async sendMail(message) { messages.push(message); } };
    },
  };
  const mailer = createEmailMailerFromEnv({
    PEAKOS_OS_EMAIL_PROVIDER: 'smtp',
    PEAKOS_OS_EMAIL_FROM: 'PEAK OS <security@paragon-info.kr>',
    PEAKOS_OS_SMTP_HOST: 'smtp.gmail.com',
    PEAKOS_OS_SMTP_PORT: '465',
    PEAKOS_OS_SMTP_SECURE: 'true',
    PEAKOS_OS_SMTP_USER: 'security@paragon-info.kr',
    PEAKOS_OS_SMTP_PASS: 'app-password',
  }, { nodemailerImpl });
  await mailer.sendOtp({
    to: 'owner@paragon-info.kr',
    subject: 'subject',
    text: 'text',
    html: '<p>html</p>',
  });
  assert.deepEqual(transportOptions, [{
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: 'security@paragon-info.kr', pass: 'app-password' },
    connectionTimeout: EMAIL_TRANSPORT_TIMEOUT_MS,
    greetingTimeout: EMAIL_TRANSPORT_TIMEOUT_MS,
    socketTimeout: EMAIL_TRANSPORT_TIMEOUT_MS,
  }]);
  assert.equal(messages[0].from, 'PEAK OS <security@paragon-info.kr>');
  assert.equal(messages[0].to, 'owner@paragon-info.kr');

  assert.equal(createEmailMailerFromEnv({}), null);
  assert.equal(createSmtpMailer({
    host: 'smtp.gmail.com',
    user: 'security@paragon-info.kr',
    pass: 'app-password',
    nodemailerImpl: null,
  }), null);
});

test('SMTP closes and rejects a hung send at the transport deadline', async () => {
  let closeCalls = 0;
  const mailer = createSmtpMailer({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    user: 'security@paragon-info.kr',
    pass: 'app-password',
    transportTimeoutMs: 20,
    nodemailerImpl: {
      createTransport(options) {
        assert.equal(options.connectionTimeout, 20);
        assert.equal(options.greetingTimeout, 20);
        assert.equal(options.socketTimeout, 20);
        return {
          sendMail: async () => new Promise(() => {}),
          close() { closeCalls += 1; },
        };
      },
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    mailer.sendOtp({
      to: 'owner@paragon-info.kr',
      subject: 'subject',
      text: 'text',
      html: '<p>html</p>',
    }),
    error => error?.code === 'OS_AUTH_EMAIL_TRANSPORT_TIMEOUT',
  );
  assert.ok(closeCalls >= 1);
  assert.ok(Date.now() - startedAt < 500, 'SMTP mail timeout should reject promptly in the test');
});

test('migration stores only HMAC hashes, limits failures, and supports UID-bound expiry', async () => {
  const migrationPath = path.join(__dirname, '..', 'migrations', '20260808_peakos_os_email_auth.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS peakos_os_email_challenges/);
  assert.match(migration, /code_hash TEXT NOT NULL/);
  assert.doesNotMatch(migration, /\bcode\s+TEXT\b/i);
  assert.doesNotMatch(migration, /\bemail\s+TEXT\b/i);
  assert.match(migration, /failed_attempts BETWEEN 0 AND 5/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS peakos_os_sessions/);
  assert.match(migration, /token_hash TEXT PRIMARY KEY/);
  assert.match(migration, /uid TEXT NOT NULL REFERENCES users\(uid\)/);

  const calls = [];
  await ensureOsEmailAuthInfrastructure({
    async query(sql) { calls.push(String(sql)); return { rows: [] }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], migration);
});
