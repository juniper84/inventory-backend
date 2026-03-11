import { UnauthorizedException } from '@nestjs/common';

export function getBusinessId(
  headers: Record<string, string | string[] | undefined>,
) {
  const value = headers['x-business-id'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Extracts and validates businessId from the authenticated request.
 * Throws UnauthorizedException if businessId is absent so callers never
 * silently receive an empty string that would bypass tenant isolation.
 */
export function requireBusinessId(
  req: { user?: { businessId?: string } },
): string {
  const id = req.user?.businessId;
  if (!id) {
    throw new UnauthorizedException('Business context required.');
  }
  return id;
}

/**
 * Extracts and validates the authenticated user's sub (userId) from the request.
 * Throws UnauthorizedException if absent so audit logs are never attributed
 * to a hardcoded 'system' actor due to a missing claim.
 */
export function requireUserId(
  req: { user?: { sub?: string } },
): string {
  const id = req.user?.sub;
  if (!id) {
    throw new UnauthorizedException('User identity required.');
  }
  return id;
}
