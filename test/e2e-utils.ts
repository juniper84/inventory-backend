import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

export const API_PREFIX = '/api/v1';

export type AuthSession = {
  token: string;
  refreshToken: string;
  businessId: string;
  userId: string;
  email: string;
  password: string;
  deviceId: string;
};

export type CoreFixtures = {
  branchId: string;
  unitId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  supplierId: string;
  customerId: string;
};

export const createTestApp = async () => {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  return app as INestApplication<App>;
};

export const expectClientError = (res: { status: number }) => {
  if (res.status < 400) {
    throw new Error(`Expected >=400 response, got ${res.status}`);
  }
};

export const signupAndLogin = async (
  app: INestApplication<App>,
): Promise<AuthSession> => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const fixedEmail = process.env.NVI_TEST_EMAIL?.trim();
  const fixedPassword = process.env.NVI_TEST_PASSWORD?.trim();
  const fixedBusinessId = process.env.NVI_TEST_BUSINESS_ID?.trim();
  const email = fixedEmail || `owner+${runId}@test.local`;
  const password = fixedPassword || 'StrongPass123';
  const deviceId = `nvi-test-device-${runId}`;

  if (fixedEmail) {
    if (!fixedBusinessId) {
      throw new Error(
        'NVI_TEST_BUSINESS_ID is required when using NVI_TEST_EMAIL.',
      );
    }
    const loginRes = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/login`)
      .send({
        email,
        password,
        businessId: fixedBusinessId,
        deviceId,
      })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`Login failed with ${res.status}`);
        }
      });

    const { accessToken, refreshToken, businessId } = loginRes.body as {
      accessToken: string;
      refreshToken: string;
      businessId?: string;
      businessSelectionRequired?: boolean;
    };
    const payloadBase64 = accessToken?.split('.')[1];
    const payload =
      payloadBase64
        ? JSON.parse(
            Buffer.from(
              payloadBase64.replace(/-/g, '+').replace(/_/g, '/'),
              'base64',
            ).toString('utf8'),
          )
        : null;
    return {
      token: accessToken,
      refreshToken,
      businessId: businessId ?? fixedBusinessId,
      userId: payload?.sub ?? '',
      email,
      password,
      deviceId,
    };
  }

  const signupRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/auth/signup`)
    .send({
      businessName: `NVI Test Business ${runId}`,
      ownerName: 'Test Owner',
      email,
      password,
    })
    .expect((res) => {
      if (![200, 201].includes(res.status) && !fixedEmail) {
        throw new Error(`Unexpected signup status ${res.status}`);
      }
    });

  const { userId, businessId, verificationToken } = signupRes.body ?? {};

  if (verificationToken) {
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/email-verification/confirm`)
      .send({ userId, token: verificationToken })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`Email verification failed with ${res.status}`);
        }
      });
  }

  const loginRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/auth/login`)
    .send({
      email,
      password,
      businessId: businessId || undefined,
      deviceId,
    })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Login failed with ${res.status}`);
      }
    });

  const { accessToken, refreshToken } = loginRes.body as {
    accessToken: string;
    refreshToken: string;
  };
  const payloadBase64 = accessToken?.split('.')[1];
  const payload =
    payloadBase64
      ? JSON.parse(
          Buffer.from(
            payloadBase64.replace(/-/g, '+').replace(/_/g, '/'),
            'base64',
          ).toString('utf8'),
        )
      : null;
  const resolvedUserId = userId ?? payload?.sub ?? '';
  const resolvedBusinessId = businessId ?? payload?.businessId ?? '';

  return {
    token: accessToken,
    refreshToken,
    businessId: resolvedBusinessId,
    userId: resolvedUserId,
    email,
    password,
    deviceId,
  };
};

export const seedCoreFixtures = async (
  app: INestApplication<App>,
  token: string,
): Promise<CoreFixtures> => {
  const branchRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/branches`)
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Main Branch' })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Branch create failed with ${res.status}`);
      }
    });

  const unitRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/units`)
    .set('authorization', `Bearer ${token}`)
    .send({ code: 'piece', label: 'Piece' })
    .expect((res) => {
      if (res.status >= 400 && res.status !== 400) {
        throw new Error(`Unit create failed with ${res.status}`);
      }
    });

  let unitId = unitRes.body?.id ?? unitRes.body?.item?.id;
  if (!unitId) {
    const unitListRes = await request(app.getHttpServer())
      .get(`${API_PREFIX}/units?limit=50`)
      .set('authorization', `Bearer ${token}`)
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`Unit list failed with ${res.status}`);
        }
      });
    const units = Array.isArray(unitListRes.body)
      ? unitListRes.body
      : unitListRes.body?.items ?? [];
    unitId = units.find(
      (unit: { code?: string; id?: string }) => unit.code === 'piece',
    )?.id;
  }

  const categoryRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/categories`)
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Beverages' })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Category create failed with ${res.status}`);
      }
    });

  const productRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/products`)
    .set('authorization', `Bearer ${token}`)
    .send({
      name: 'Sparkling Water',
      categoryId: categoryRes.body.id,
    })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Product create failed with ${res.status}`);
      }
    });

  const variantRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/variants`)
    .set('authorization', `Bearer ${token}`)
    .send({
      productId: productRes.body.id,
      name: 'Sparkling Water 500ml',
      defaultPrice: 2.5,
      defaultCost: 1.2,
      baseUnitId: unitId,
      sellUnitId: unitId,
    })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Variant create failed with ${res.status}`);
      }
    });

  const supplierRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/suppliers`)
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Blue Source', email: 'supply@test.local' })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Supplier create failed with ${res.status}`);
      }
    });

  const customerRes = await request(app.getHttpServer())
    .post(`${API_PREFIX}/customers`)
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'City Shopper', email: 'customer@test.local' })
    .expect((res) => {
      if (res.status >= 400) {
        throw new Error(`Customer create failed with ${res.status}`);
      }
    });

  return {
    branchId: branchRes.body.id,
    unitId: unitId ?? '',
    categoryId: categoryRes.body.id,
    productId: productRes.body.id,
    variantId: variantRes.body.id,
    supplierId: supplierRes.body.id,
    customerId: customerRes.body.id,
  };
};
