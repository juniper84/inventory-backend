import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { API_PREFIX, createTestApp, expectClientError, signupAndLogin } from './e2e-utils';

jest.setTimeout(30000);

describe('Auth negative cases (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects weak password on signup', async () => {
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/signup`)
      .send({
        businessName: 'Weak Pass Business',
        ownerName: 'Weak Owner',
        email: `weak+${Date.now()}@test.local`,
        password: '123',
      })
      .expect(expectClientError);
  });

  it('rejects signup with missing fields', async () => {
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/signup`)
      .send({ email: `missing+${Date.now()}@test.local` })
      .expect(expectClientError);
  });

  it('rejects login without deviceId', async () => {
    const session = await signupAndLogin(app);
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: session.email, password: session.password })
      .expect(expectClientError);
  });

  it('rejects login with invalid credentials', async () => {
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/login`)
      .send({
        email: `missing+${Date.now()}@test.local`,
        password: 'BadPass123',
        deviceId: `device-${Date.now()}`,
      })
      .expect(expectClientError);
  });

  it('rejects refresh with invalid token', async () => {
    const session = await signupAndLogin(app);
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/refresh`)
      .send({
        userId: session.userId,
        businessId: session.businessId,
        refreshToken: 'invalid-refresh-token',
        deviceId: session.deviceId,
      })
      .expect(expectClientError);
  });

  it('rejects password reset confirm with invalid token', async () => {
    const session = await signupAndLogin(app);
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/password-reset/confirm`)
      .send({
        userId: session.userId,
        token: 'invalid-token',
        password: 'StrongPass123',
      })
      .expect(expectClientError);
  });
});
