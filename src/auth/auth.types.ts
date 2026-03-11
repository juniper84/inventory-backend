export type JwtPayload = {
  sub: string;
  email: string;
  businessId: string;
  deviceId?: string;
  roleIds: string[];
  permissions: string[];
  branchScope: string[];
  subscriptionState: string;
  scope?: 'platform' | 'business' | 'support';
  supportScope?: string[];
  iat?: number; // JWT standard claim: issued-at (Unix seconds)
  exp?: number; // JWT standard claim: expiry (Unix seconds)
};
