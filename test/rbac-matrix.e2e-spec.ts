import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { API_PREFIX, createTestApp, signupAndLogin } from './e2e-utils';

jest.setTimeout(30000);

type Role = { id: string; name: string };
type Permission = { id: string; code: string };
type AuthSession = {
  token: string;
  businessId: string;
};

const expectForbidden = (res: { status: number }) => {
  if (res.status !== 403) {
    throw new Error(`Expected 403, got ${res.status}`);
  }
};

describe('RBAC role-matrix (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let businessId: string;
  let branchA: string;
  let branchB: string;
  let permissions: Map<string, string>;

  const authReq = (
    token: string,
    method: 'get' | 'post' | 'put',
    path: string,
  ) =>
    request(app.getHttpServer())
      [method](`${API_PREFIX}${path}`)
      .set('authorization', `Bearer ${token}`);

  const createRole = async (name: string, codes: string[]) => {
    const roleRes = await authReq(adminToken, 'post', '/roles')
      .send({ name })
      .expect(201);
    const role = roleRes.body as Role;

    const permissionIds = codes
      .map((code) => permissions.get(code))
      .filter((id): id is string => Boolean(id));

    await authReq(adminToken, 'put', `/roles/${role.id}/permissions`)
      .send({ permissionIds })
      .expect(200);

    return role;
  };

  const createUserWithRole = async (
    roleId: string,
    email: string,
    password: string,
    branchId?: string,
  ) => {
    const userRes = await authReq(adminToken, 'post', '/users')
      .send({
        name: email.split('@')[0],
        email,
        status: 'ACTIVE',
        tempPassword: password,
        mustResetPassword: false,
      })
      .expect(201);

    const userId = userRes.body.id as string;

    await authReq(adminToken, 'post', `/users/${userId}/roles`)
      .send({ roleId, branchId })
      .expect(201);

    const loginRes = await request(app.getHttpServer())
      .post(`${API_PREFIX}/auth/login`)
      .send({
        email,
        password,
        businessId,
        deviceId: `device-${Date.now()}`,
      })
      .expect(201);

    return {
      token: loginRes.body.accessToken as string,
      businessId: loginRes.body.businessId as string,
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    const session = await signupAndLogin(app);
    adminToken = session.token;
    businessId = session.businessId;

    const branchARes = await authReq(adminToken, 'post', '/branches')
      .send({ name: `RBAC Branch A ${Date.now()}` })
      .expect(201);
    branchA = branchARes.body.id;

    const branchBRes = await authReq(adminToken, 'post', '/branches')
      .send({ name: `RBAC Branch B ${Date.now()}` })
      .expect(201);
    branchB = branchBRes.body.id;

    const permissionRes = await authReq(adminToken, 'get', '/roles/permissions')
      .expect(200);
    const list = permissionRes.body as Permission[];
    permissions = new Map(list.map((perm) => [perm.code, perm.id]));
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces role permissions and branch scope', async () => {
    const runId = `${Date.now()}`;
    const stockReaderRole = await createRole(`rbac-stock-reader-${runId}`, [
      'stock.read',
    ]);
    const cashierRole = await createRole(`rbac-cashier-${runId}`, [
      'sales.read',
      'sales.write',
    ]);
    const usersRole = await createRole(`rbac-users-${runId}`, ['users.read']);
    const noPermRole = await createRole(`rbac-none-${runId}`, []);

    const stockReader = await createUserWithRole(
      stockReaderRole.id,
      `stockreader+${runId}@test.local`,
      'StrongPass123',
      branchA,
    );
    const cashier = await createUserWithRole(
      cashierRole.id,
      `cashier+${runId}@test.local`,
      'StrongPass123',
    );
    const usersReader = await createUserWithRole(
      usersRole.id,
      `users+${runId}@test.local`,
      'StrongPass123',
    );
    const noPerm = await createUserWithRole(
      noPermRole.id,
      `nopriv+${runId}@test.local`,
      'StrongPass123',
    );

    await authReq(
      stockReader.token,
      'get',
      `/stock?limit=1&branchId=${branchA}`,
    )
      .expect(200);
    await authReq(
      stockReader.token,
      'get',
      `/stock?limit=1&branchId=${branchB}`,
    )
      .expect(expectForbidden);

    await authReq(cashier.token, 'get', '/sales/receipts?limit=1')
      .expect(200);
    await authReq(cashier.token, 'get', '/users?limit=1')
      .expect(expectForbidden);

    await authReq(usersReader.token, 'get', '/users?limit=1')
      .expect(200);
    await authReq(usersReader.token, 'get', '/stock?limit=1')
      .expect(expectForbidden);

    await authReq(noPerm.token, 'get', '/settings')
      .expect(expectForbidden);
  });
});
