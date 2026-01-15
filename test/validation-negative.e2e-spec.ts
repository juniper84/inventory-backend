import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import {
  API_PREFIX,
  createTestApp,
  expectClientError,
  seedCoreFixtures,
  signupAndLogin,
} from './e2e-utils';

jest.setTimeout(30000);

describe('Validation negative cases (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let fixtures: Awaited<ReturnType<typeof seedCoreFixtures>>;

  beforeAll(async () => {
    app = await createTestApp();
    const session = await signupAndLogin(app);
    token = session.token;
    fixtures = await seedCoreFixtures(app, token);
  });

  afterAll(async () => {
    await app.close();
  });

  const authReq = (method: 'get' | 'post' | 'put' | 'patch', path: string) =>
    request(app.getHttpServer())
      [method](`${API_PREFIX}${path}`)
      .set('authorization', `Bearer ${token}`);

  it('rejects branch creation without name', async () => {
    await authReq('post', '/branches')
      .send({})
      .expect(expectClientError);
  });

  it('rejects category creation without name', async () => {
    await authReq('post', '/categories')
      .send({})
      .expect(expectClientError);
  });

  it('rejects product creation without categoryId', async () => {
    await authReq('post', '/products')
      .send({ name: 'Invalid Product' })
      .expect(expectClientError);
  });

  it('rejects variant creation without unit IDs', async () => {
    await authReq('post', '/variants')
      .send({
        productId: fixtures.productId,
        name: 'Invalid Variant',
        defaultPrice: 2.5,
      })
      .expect(expectClientError);
  });

  it('rejects supplier creation without name', async () => {
    await authReq('post', '/suppliers')
      .send({ email: 'missing@test.local' })
      .expect(expectClientError);
  });

  it('rejects customer creation without name', async () => {
    await authReq('post', '/customers')
      .send({ email: 'missing@test.local' })
      .expect(expectClientError);
  });

  it('rejects stock adjustment without variantId', async () => {
    await authReq('post', '/stock/adjustments')
      .send({ branchId: fixtures.branchId, quantity: 5, reason: 'test' })
      .expect(expectClientError);
  });

  it('rejects stock count without items', async () => {
    await authReq('post', '/stock/counts')
      .send({ branchId: fixtures.branchId })
      .expect(expectClientError);
  });

  it('rejects reorder point without variantId', async () => {
    await authReq('post', '/stock/reorder-points')
      .send({ branchId: fixtures.branchId, minQty: 5 })
      .expect(expectClientError);
  });

  it('rejects purchase order without lines', async () => {
    await authReq('post', '/purchase-orders')
      .send({ supplierId: fixtures.supplierId, branchId: fixtures.branchId })
      .expect(expectClientError);
  });

  it('rejects receiving without purchaseOrderId', async () => {
    await authReq('post', '/receiving')
      .send({ branchId: fixtures.branchId })
      .expect(expectClientError);
  });

  it('rejects transfer without destination branch', async () => {
    await authReq('post', '/transfers')
      .send({
        fromBranchId: fixtures.branchId,
        lines: [{ variantId: fixtures.variantId, quantity: 2 }],
      })
      .expect(expectClientError);
  });

  it('rejects expense with invalid category', async () => {
    await authReq('post', '/expenses')
      .send({
        branchId: fixtures.branchId,
        category: 'InvalidCategory',
        amount: 12.5,
        currency: 'TZS',
      })
      .expect(expectClientError);
  });

  it('rejects price list without name', async () => {
    await authReq('post', '/price-lists')
      .send({})
      .expect(expectClientError);
  });

  it('rejects sales draft without items', async () => {
    await authReq('post', '/sales/draft')
      .send({ branchId: fixtures.branchId, customerId: fixtures.customerId })
      .expect(expectClientError);
  });

  it('rejects sales completion with invalid payload', async () => {
    await authReq('post', '/sales/complete')
      .send({ branchId: fixtures.branchId })
      .expect(expectClientError);
  });

  it('rejects offline status update without deviceId', async () => {
    await authReq('post', '/offline/status')
      .send({ status: 'ONLINE' })
      .expect(expectClientError);
  });

  it('rejects note creation without title', async () => {
    await authReq('post', '/notes')
      .send({ resourceType: 'Customer', resourceId: fixtures.customerId })
      .expect(expectClientError);
  });

  it('rejects import apply without dataset', async () => {
    await authReq('post', '/imports/apply')
      .send({})
      .expect(expectClientError);
  });

  it('rejects access request without reason', async () => {
    await authReq('post', '/access-requests')
      .send({})
      .expect(expectClientError);
  });

  it('rejects subscription request without type', async () => {
    await authReq('post', '/subscription/requests')
      .send({})
      .expect(expectClientError);
  });
});
