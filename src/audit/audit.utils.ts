type RequestLike = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function readHeader(
  headers: RequestLike['headers'],
  key: string,
): string | undefined {
  const value = headers?.[key];
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

export function buildRequestMetadata(req?: RequestLike) {
  if (!req) {
    return undefined;
  }
  const ip =
    req.ip || readHeader(req.headers, 'x-forwarded-for')?.split(',')[0]?.trim();
  const userAgent = readHeader(req.headers, 'user-agent');
  const offlineHeader =
    readHeader(req.headers, 'x-offline-mode') ??
    readHeader(req.headers, 'x-offline');
  const offline =
    offlineHeader === 'true' || offlineHeader === '1' ? true : undefined;
  const requestId = readHeader(req.headers, 'x-request-id');
  const sessionId = readHeader(req.headers, 'x-session-id');
  const correlationId =
    readHeader(req.headers, 'x-correlation-id') ??
    readHeader(req.headers, 'x-trace-id');
  const auditOrigin = readHeader(req.headers, 'x-audit-origin') ?? 'app';

  const metadata: Record<string, unknown> = {};
  if (ip) {
    metadata.ip = ip;
  }
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  if (offline !== undefined) {
    metadata.offline = offline;
  }
  if (requestId) {
    metadata.requestId = requestId;
  }
  if (sessionId) {
    metadata.sessionId = sessionId;
  }
  if (correlationId) {
    metadata.correlationId = correlationId;
  }
  metadata.auditOrigin = auditOrigin;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
