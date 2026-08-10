'use strict';

const PEAKOS_COLLABORATION_PREFIX = '/api/peakos/collaboration';
const PEAKOS_COLLABORATION_AUTHENTICATED = Symbol('peakosCollaborationAuthenticated');
const PEAKOS_COLLABORATION_CONTEXT = Symbol('peakosCollaborationContext');

const route = (methods, pattern) => ({
  methods: new Set(methods),
  pattern,
});

// This is deliberately an allowlist instead of a generic /api proxy. Adding a
// new Paragon endpoint does not expose it through the second-factor OS surface
// until it has been reviewed here.
const COLLABORATION_ROUTE_RULES = Object.freeze([
  route(['GET'], /^\/users\/all-approved$/),

  route(['GET', 'POST'], /^\/events$/),
  route(['POST'], /^\/events\/reorder$/),
  route(['GET'], /^\/events\/checklist-summary$/),
  route(['PUT'], /^\/events\/(?!reorder$|checklist-summary$)[^/]+$/),
  route(['POST'], /^\/events\/[^/]+\/delete-repeat-(?:future|all)$/),
  route(['GET'], /^\/events\/[^/]+\/shares$/),
  route(['GET', 'POST'], /^\/events\/[^/]+\/checklist$/),
  route(['PUT', 'DELETE'], /^\/events\/[^/]+\/checklist\/[^/]+$/),
  route(['GET', 'POST'], /^\/events\/[^/]+\/comments$/),
  route(['DELETE'], /^\/events\/[^/]+\/comments\/[^/]+$/),
  route(['GET', 'POST'], /^\/event-types$/),
  route(['DELETE'], /^\/event-types\/[^/]+$/),
  route(['GET', 'POST'], /^\/todo-cats$/),
  route(['DELETE'], /^\/todo-cats\/[^/]+$/),

  route(['GET', 'POST'], /^\/chat-room-groups$/),
  route(['PUT', 'DELETE'], /^\/chat-room-groups\/[^/]+$/),
  route(['GET', 'POST'], /^\/chat-rooms$/),
  route(['GET'], /^\/chat-rooms\/unread$/),
  route(['GET'], /^\/chat-rooms\/delete-requests$/),
  route(['PUT'], /^\/chat-rooms\/bulk\/group$/),
  route(['POST'], /^\/chat-rooms\/bulk\/(?:request-delete|delete)$/),
  route(['PUT', 'DELETE'], /^\/chat-rooms\/(?!unread$|delete-requests$|bulk$)[^/]+$/),
  route(['PUT'], /^\/chat-rooms\/[^/]+\/group$/),
  route(['GET', 'POST'], /^\/chat-rooms\/[^/]+\/members$/),
  route(['DELETE'], /^\/chat-rooms\/[^/]+\/members\/[^/]+$/),
  route(['POST'], /^\/chat-rooms\/[^/]+\/action-items\/convert$/),
  route(['POST'], /^\/chat-rooms\/[^/]+\/(?:leave|request-delete|reject-delete)$/),
  route(['GET', 'POST'], /^\/chat-rooms\/[^/]+\/typing$/),
  route(['GET', 'POST'], /^\/chat-rooms\/[^/]+\/messages$/),
  route(['POST'], /^\/chat-rooms\/[^/]+\/(?:upload|upload-file|read)$/),
  route(['GET'], /^\/chat-rooms\/[^/]+\/unread-counts$/),

  route(['GET', 'POST'], /^\/projects$/),
  route(['POST'], /^\/projects\/upload$/),
  route(['GET'], /^\/projects\/my-tasks$/),
  route(['GET', 'PUT', 'DELETE'], /^\/projects\/(?!upload$|my-tasks$)[^/]+$/),
  route(['POST'], /^\/projects\/[^/]+\/(?:events|meetings|tasks|updates|comments)$/),
  route(['PUT', 'DELETE'], /^\/projects\/[^/]+\/tasks\/[^/]+$/),
  route(['PUT'], /^\/projects\/[^/]+\/tasks\/[^/]+\/completion$/),
  route(['POST'], /^\/projects\/[^/]+\/tasks\/[^/]+\/review$/),
  route(['POST'], /^\/projects\/[^/]+\/tasks\/[^/]+\/comments$/),
  route(['DELETE'], /^\/projects\/[^/]+\/tasks\/[^/]+\/comments\/[^/]+$/),
  route(['PUT', 'DELETE'], /^\/projects\/[^/]+\/updates\/[^/]+$/),
  route(['PUT', 'DELETE'], /^\/projects\/[^/]+\/comments\/[^/]+$/),
]);

function splitRawUrl(rawUrl) {
  const value = String(rawUrl || '');
  const queryIndex = value.indexOf('?');
  return queryIndex === -1
    ? { pathname: value, search: '' }
    : { pathname: value.slice(0, queryIndex), search: value.slice(queryIndex) };
}

function hasUnsafePathEncoding(pathname) {
  if (/[\u0000-\u001f\u007f\\]/.test(pathname) || /%(?:2f|5c|00)/i.test(pathname)) return true;
  try {
    return decodeURIComponent(pathname).split('/').some(segment => segment === '.' || segment === '..');
  } catch (_) {
    return true;
  }
}

function collaborationRouteStatus(method, suffix) {
  const matchingRules = COLLABORATION_ROUTE_RULES.filter(rule => rule.pattern.test(suffix));
  if (!matchingRules.length) return 'not_found';
  const normalizedMethod = String(method || '').toUpperCase() === 'HEAD'
    ? 'GET'
    : String(method || '').toUpperCase();
  return matchingRules.some(rule => rule.methods.has(normalizedMethod)) ? 'allowed' : 'method_not_allowed';
}

function resolvePeakosCollaborationTarget(method, rawUrl) {
  const { pathname, search } = splitRawUrl(rawUrl);
  const isCollaborationPath = pathname === PEAKOS_COLLABORATION_PREFIX
    || pathname.startsWith(`${PEAKOS_COLLABORATION_PREFIX}/`);
  if (!isCollaborationPath) return null;

  const suffix = pathname.slice(PEAKOS_COLLABORATION_PREFIX.length) || '/';
  if (!suffix.startsWith('/') || hasUnsafePathEncoding(suffix)) {
    return { status: 'not_found', suffix };
  }
  const status = collaborationRouteStatus(method, suffix);
  if (status !== 'allowed') return { status, suffix };
  return {
    status,
    suffix,
    canonicalPath: `/api${suffix}`,
    canonicalUrl: `/api${suffix}${search}`,
  };
}

function previewHeaderValue(req) {
  if (typeof req.get === 'function') return req.get('x-peakos-preview');
  return req.headers?.['x-peakos-preview'];
}

function isPreviewMutation(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return false;
  return /^(?:1|true|yes|on)$/i.test(String(previewHeaderValue(req) || '').trim());
}

function sendGatewayError(res, status, code, error) {
  return res.status(status).json({ code, error });
}

function invokeMiddleware(middleware, req, res, next, onSuccess) {
  try {
    const result = middleware(req, res, error => {
      if (error) return next(error);
      return onSuccess();
    });
    if (result && typeof result.catch === 'function') result.catch(next);
    return result;
  } catch (error) {
    return next(error);
  }
}

function createPeakosCollaborationGateway({ authMiddleware, getRequireOsSession, getRequireWorkspace }) {
  if (typeof authMiddleware !== 'function') throw new TypeError('authMiddleware is required.');
  if (typeof getRequireOsSession !== 'function') throw new TypeError('getRequireOsSession is required.');

  return function peakosCollaborationGateway(req, res, next) {
    const target = resolvePeakosCollaborationTarget(req.method, req.url);
    if (!target) return next();
    if (target.status === 'method_not_allowed') {
      return sendGatewayError(res, 405, 'PEAKOS_COLLABORATION_METHOD_NOT_ALLOWED', '허용되지 않은 협업 요청 방식입니다.');
    }
    if (target.status !== 'allowed') {
      return sendGatewayError(res, 404, 'PEAKOS_COLLABORATION_ROUTE_NOT_ALLOWED', '허용되지 않은 협업 API 경로입니다.');
    }

    // Rewriting before auth makes the existing chat_only / external-calendar
    // server policy evaluate the exact same canonical path as legacy Paragon.
    req.url = target.canonicalUrl;
    req[PEAKOS_COLLABORATION_CONTEXT] = {
      prefix: PEAKOS_COLLABORATION_PREFIX,
      suffix: target.suffix,
      canonicalPath: target.canonicalPath,
    };

    return invokeMiddleware(authMiddleware, req, res, next, () => {
      const requireOsSession = getRequireOsSession();
      if (typeof requireOsSession !== 'function') {
        return sendGatewayError(res, 503, 'PEAKOS_OS_AUTH_NOT_READY', 'PEAK OS 추가 인증을 확인할 수 없습니다.');
      }
      return invokeMiddleware(requireOsSession, req, res, next, () => {
        const continueAfterWorkspace = () => {
          if (isPreviewMutation(req)) {
            return sendGatewayError(
              res,
              403,
              'PEAKOS_PREVIEW_WRITE_FORBIDDEN',
              '계정 미리보기에서는 변경할 수 없습니다.',
            );
          }
          req[PEAKOS_COLLABORATION_AUTHENTICATED] = true;
          return next();
        };
        if (typeof getRequireWorkspace !== 'function') return continueAfterWorkspace();
        const requireWorkspace = getRequireWorkspace({ req, target });
        if (typeof requireWorkspace !== 'function') {
          return sendGatewayError(res, 503, 'PEAKOS_WORKSPACE_NOT_READY', '워크스페이스 권한을 확인할 수 없습니다.');
        }
        return invokeMiddleware(requireWorkspace, req, res, next, continueAfterWorkspace);
      });
    });
  };
}

function isPeakosCollaborationAuthenticated(req) {
  return req?.[PEAKOS_COLLABORATION_AUTHENTICATED] === true;
}

function getPeakosCollaborationContext(req) {
  return req?.[PEAKOS_COLLABORATION_CONTEXT] || null;
}

module.exports = {
  COLLABORATION_ROUTE_RULES,
  PEAKOS_COLLABORATION_PREFIX,
  collaborationRouteStatus,
  createPeakosCollaborationGateway,
  getPeakosCollaborationContext,
  isPeakosCollaborationAuthenticated,
  isPreviewMutation,
  resolvePeakosCollaborationTarget,
};
