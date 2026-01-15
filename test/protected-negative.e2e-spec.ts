import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { API_PREFIX, createTestApp } from './e2e-utils';

jest.setTimeout(30000);

type Endpoint = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
};

const endpoints: Endpoint[] = [
  { method: 'GET', path: '/branches?limit=1' },
  { method: 'POST', path: '/branches', body: { name: 'Test' } },
  { method: 'PUT', path: '/branches/invalid', body: { name: 'Test' } },
  { method: 'GET', path: '/settings' },
  { method: 'PUT', path: '/settings', body: { timezone: 'UTC' } },
  { method: 'GET', path: '/roles?limit=1' },
  { method: 'GET', path: '/roles/permissions' },
  { method: 'GET', path: '/roles/invalid/permissions' },
  { method: 'POST', path: '/roles', body: { name: 'Test Role' } },
  { method: 'PUT', path: '/roles/invalid', body: { name: 'Test Role' } },
  { method: 'PUT', path: '/roles/invalid/permissions', body: { permissionIds: [] } },
  { method: 'GET', path: '/users?limit=1' },
  { method: 'POST', path: '/users', body: { name: 'Test', email: 'x@test.local' } },
  { method: 'PUT', path: '/users/invalid', body: { name: 'Test' } },
  { method: 'POST', path: '/users/invalid/deactivate' },
  { method: 'POST', path: '/users/invite', body: { email: 'x@test.local', roleIds: [] } },
  { method: 'GET', path: '/users/invalid/roles' },
  { method: 'POST', path: '/users/invalid/roles', body: { roleIds: [] } },
  { method: 'POST', path: '/users/invalid/roles/remove', body: { roleIds: [] } },
  { method: 'GET', path: '/categories?limit=1' },
  { method: 'POST', path: '/categories', body: { name: 'Test' } },
  { method: 'PUT', path: '/categories/invalid', body: { name: 'Test' } },
  { method: 'GET', path: '/products?limit=1' },
  { method: 'POST', path: '/products', body: { name: 'Test' } },
  { method: 'PUT', path: '/products/invalid', body: { name: 'Test' } },
  { method: 'GET', path: '/variants?limit=1' },
  { method: 'POST', path: '/variants', body: { name: 'Test' } },
  { method: 'PUT', path: '/variants/invalid', body: { name: 'Test' } },
  { method: 'GET', path: '/barcodes/lookup?code=missing' },
  { method: 'POST', path: '/barcodes', body: { variantId: 'invalid', code: 'x' } },
  { method: 'POST', path: '/barcodes/generate', body: { variantId: 'invalid' } },
  { method: 'POST', path: '/barcodes/invalid/reassign', body: { newVariantId: 'invalid' } },
  { method: 'POST', path: '/barcodes/labels', body: { variantIds: ['invalid'] } },
  { method: 'POST', path: '/variants/invalid/sku', body: { sku: 'SKU-1', reason: 'test' } },
  { method: 'POST', path: '/variants/invalid/availability', body: { branchId: 'invalid', isActive: true } },
  { method: 'POST', path: '/products/invalid/images/presign', body: { filename: 'x.jpg', contentType: 'image/jpeg' } },
  { method: 'POST', path: '/products/invalid/images', body: { url: 'x', filename: 'x', mimeType: 'image/jpeg', sizeMb: 1 } },
  { method: 'POST', path: '/products/invalid/images/invalid/primary' },
  { method: 'POST', path: '/products/invalid/images/invalid/remove' },
  { method: 'POST', path: '/variants/invalid/image/presign', body: { filename: 'x.jpg', contentType: 'image/jpeg' } },
  { method: 'POST', path: '/variants/invalid/image', body: { imageUrl: 'x' } },
  { method: 'GET', path: '/stock?limit=1' },
  { method: 'GET', path: '/stock/movements?limit=1' },
  { method: 'GET', path: '/stock/batches?limit=1' },
  { method: 'POST', path: '/stock/batches', body: {} },
  { method: 'POST', path: '/stock/adjustments', body: {} },
  { method: 'POST', path: '/stock/counts', body: {} },
  { method: 'GET', path: '/stock/reorder-points?limit=1' },
  { method: 'POST', path: '/stock/reorder-points', body: {} },
  { method: 'GET', path: '/stock/reorder-suggestions?branchId=invalid' },
  { method: 'POST', path: '/purchase-orders', body: {} },
  { method: 'PUT', path: '/purchase-orders/invalid', body: {} },
  { method: 'POST', path: '/purchase-orders/invalid/approve' },
  { method: 'POST', path: '/receiving', body: {} },
  { method: 'GET', path: '/purchases?limit=1' },
  { method: 'POST', path: '/purchases', body: {} },
  { method: 'GET', path: '/purchase-orders?limit=1' },
  { method: 'GET', path: '/receiving?limit=1' },
  { method: 'GET', path: '/supplier-returns?limit=1' },
  { method: 'POST', path: '/supplier-returns', body: {} },
  { method: 'POST', path: '/purchases/invalid/payments', body: {} },
  { method: 'GET', path: '/transfers?limit=1' },
  { method: 'GET', path: '/transfers/pending?limit=1' },
  { method: 'POST', path: '/transfers', body: {} },
  { method: 'POST', path: '/transfers/invalid/approve' },
  { method: 'POST', path: '/transfers/invalid/receive' },
  { method: 'POST', path: '/transfers/invalid/cancel' },
  { method: 'GET', path: '/expenses?limit=1' },
  { method: 'POST', path: '/expenses', body: {} },
  { method: 'GET', path: '/price-lists?limit=1' },
  { method: 'POST', path: '/price-lists', body: {} },
  { method: 'PUT', path: '/price-lists/invalid', body: {} },
  { method: 'POST', path: '/price-lists/invalid/items', body: {} },
  { method: 'POST', path: '/price-lists/invalid/items/invalid/remove', body: {} },
  { method: 'POST', path: '/sales/draft', body: {} },
  { method: 'POST', path: '/sales/complete', body: {} },
  { method: 'POST', path: '/sales/invalid/void' },
  { method: 'POST', path: '/sales/invalid/refund', body: {} },
  { method: 'POST', path: '/sales/invalid/settlements', body: {} },
  { method: 'POST', path: '/sales/returns/without-receipt', body: {} },
  { method: 'GET', path: '/sales/receipts?limit=1' },
  { method: 'POST', path: '/sales/receipts/invalid/reprint' },
  { method: 'GET', path: '/reports/stock?branchId=invalid' },
  { method: 'GET', path: '/reports/sales?branchId=invalid' },
  { method: 'GET', path: '/reports/vat?branchId=invalid' },
  { method: 'GET', path: '/reports/vat-summary?branchId=invalid' },
  { method: 'GET', path: '/reports/pnl?branchId=invalid' },
  { method: 'GET', path: '/reports/expiry?branchId=invalid' },
  { method: 'GET', path: '/reports/losses/top?branchId=invalid' },
  { method: 'GET', path: '/reports/stock-count-variance?branchId=invalid' },
  { method: 'GET', path: '/reports/staff?branchId=invalid' },
  { method: 'GET', path: '/reports/customers/sales?branchId=invalid' },
  { method: 'GET', path: '/reports/customers/refunds?branchId=invalid' },
  { method: 'GET', path: '/reports/customers/outstanding?branchId=invalid' },
  { method: 'GET', path: '/reports/customers/top?branchId=invalid' },
  { method: 'GET', path: '/reports/customers/export?branchId=invalid' },
  { method: 'GET', path: '/approvals?limit=1' },
  { method: 'POST', path: '/approvals/invalid/approve' },
  { method: 'POST', path: '/approvals/invalid/reject', body: { reason: 'test' } },
  { method: 'GET', path: '/audit-logs?limit=1' },
  { method: 'GET', path: '/audit-logs/invalid' },
  { method: 'GET', path: '/audit-logs/export?format=csv' },
  { method: 'GET', path: '/exports/stock?branchId=invalid' },
  { method: 'POST', path: '/exports/jobs', body: {} },
  { method: 'GET', path: '/exports/jobs?limit=1' },
  { method: 'POST', path: '/exports/jobs/invalid/run' },
  { method: 'GET', path: '/exports/jobs/invalid/download' },
  { method: 'GET', path: '/exports/worker/status' },
  { method: 'POST', path: '/offline/register-device', body: {} },
  { method: 'POST', path: '/offline/revoke-device', body: {} },
  { method: 'GET', path: '/offline/status?deviceId=invalid' },
  { method: 'GET', path: '/offline/risk' },
  { method: 'GET', path: '/offline/conflicts' },
  { method: 'POST', path: '/offline/conflicts/resolve', body: {} },
  { method: 'POST', path: '/offline/status', body: {} },
  { method: 'POST', path: '/offline/sync', body: {} },
  { method: 'GET', path: '/notes?limit=1' },
  { method: 'GET', path: '/notes/linkables?type=customer&query=x' },
  { method: 'GET', path: '/notes/meta' },
  { method: 'GET', path: '/notes/reminders/overview?limit=1' },
  { method: 'GET', path: '/notes/invalid' },
  { method: 'GET', path: '/notes/invalid/reminders' },
  { method: 'POST', path: '/notes', body: {} },
  { method: 'PUT', path: '/notes/invalid', body: {} },
  { method: 'POST', path: '/notes/invalid/archive' },
  { method: 'POST', path: '/notes/invalid/reminders', body: {} },
  { method: 'POST', path: '/notes/reminders/invalid/cancel' },
  { method: 'GET', path: '/shifts?limit=1' },
  { method: 'GET', path: '/shifts/open' },
  { method: 'POST', path: '/shifts/open', body: {} },
  { method: 'POST', path: '/shifts/invalid/close', body: {} },
  { method: 'POST', path: '/attachments', body: {} },
  { method: 'GET', path: '/attachments?limit=1' },
  { method: 'POST', path: '/attachments/presign', body: {} },
  { method: 'POST', path: '/attachments/invalid/remove' },
  { method: 'POST', path: '/imports/preview', body: {} },
  { method: 'POST', path: '/imports/apply', body: {} },
  { method: 'POST', path: '/access-requests', body: {} },
  { method: 'GET', path: '/business' },
  { method: 'PUT', path: '/business', body: {} },
  { method: 'POST', path: '/business/delete' },
  { method: 'GET', path: '/subscription' },
  { method: 'GET', path: '/subscription/requests' },
  { method: 'POST', path: '/subscription/requests', body: {} },
  { method: 'GET', path: '/support-access/requests' },
  { method: 'POST', path: '/support-access/requests/invalid/approve' },
  { method: 'POST', path: '/support-access/requests/invalid/reject' },
  { method: 'POST', path: '/platform/auth/login', body: {} },
  { method: 'POST', path: '/platform/businesses', body: {} },
  { method: 'GET', path: '/platform/businesses?limit=1' },
  { method: 'GET', path: '/platform/metrics' },
  { method: 'GET', path: '/platform/audit-logs?limit=1' },
  { method: 'GET', path: '/platform/platform-audit-logs?limit=1' },
  { method: 'PATCH', path: '/platform/businesses/invalid/status', body: {} },
  { method: 'PATCH', path: '/platform/businesses/invalid/read-only', body: {} },
  { method: 'PATCH', path: '/platform/subscriptions/invalid', body: {} },
  { method: 'POST', path: '/platform/businesses/invalid/purge' },
  { method: 'POST', path: '/platform/support-access/requests', body: {} },
  { method: 'GET', path: '/platform/support-access/requests?limit=1' },
  { method: 'POST', path: '/platform/support-access/requests/invalid/activate' },
  { method: 'POST', path: '/platform/support-access/login', body: {} },
  { method: 'POST', path: '/platform/exports/on-exit', body: {} },
  { method: 'PATCH', path: '/platform/exports/invalid/delivered', body: {} },
  { method: 'GET', path: '/platform/subscription-requests?limit=1' },
  { method: 'GET', path: '/platform/exports/jobs?limit=1' },
  { method: 'POST', path: '/platform/subscription-requests/invalid/approve' },
  { method: 'POST', path: '/platform/subscription-requests/invalid/reject' },
  { method: 'PATCH', path: '/platform/businesses/invalid/review', body: {} },
  { method: 'POST', path: '/platform/businesses/invalid/revoke-sessions' },
  { method: 'PATCH', path: '/platform/businesses/invalid/rate-limits', body: {} },
  { method: 'GET', path: '/platform/subscriptions/invalid/history' },
  { method: 'GET', path: '/platform/businesses/invalid/health' },
  { method: 'GET', path: '/platform/businesses/invalid/devices' },
  { method: 'POST', path: '/platform/devices/invalid/revoke' },
  { method: 'POST', path: '/platform/announcements', body: {} },
  { method: 'GET', path: '/platform/announcements?limit=1' },
  { method: 'PATCH', path: '/platform/announcements/invalid/end', body: {} },
  { method: 'GET', path: '/notifications?limit=1' },
  { method: 'POST', path: '/notifications/read-all' },
  { method: 'POST', path: '/notifications/read-bulk', body: {} },
  { method: 'POST', path: '/notifications/archive-bulk', body: {} },
  { method: 'POST', path: '/notifications/invalid/read' },
  { method: 'GET', path: '/notifications/announcement' },
  { method: 'GET', path: '/search?query=test' },
];

describe('Protected endpoints require auth (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it.each(endpoints)('rejects unauthenticated %s %s', async ({ method, path, body }) => {
    const req = request(app.getHttpServer());
    const fullPath = `${API_PREFIX}${path}`;
    const res = await (method === 'GET'
      ? req.get(fullPath)
      : method === 'POST'
      ? req.post(fullPath).send(body ?? {})
      : method === 'PUT'
      ? req.put(fullPath).send(body ?? {})
      : method === 'PATCH'
      ? req.patch(fullPath).send(body ?? {})
      : req.delete(fullPath));

    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
