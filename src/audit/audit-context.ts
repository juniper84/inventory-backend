import { AsyncLocalStorage } from 'async_hooks';

export type AuditContext = {
  businessId?: string;
  userId?: string;
  roleId?: string;
  branchId?: string;
  requestId?: string;
  sessionId?: string;
  correlationId?: string;
  deviceId?: string;
  metadata?: Record<string, unknown>;
};

export class AuditContextStore {
  private readonly storage = new AsyncLocalStorage<AuditContext>();

  run<T>(context: AuditContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  get(): AuditContext | undefined {
    return this.storage.getStore();
  }
}
