import fs from 'fs';
import path from 'path';

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
};

type AuthResponse = {
  accessToken?: string;
  refreshToken?: string;
  businessId?: string;
  user?: { id: string; email: string; name: string };
  businessSelectionRequired?: boolean;
  businesses?: { businessId: string; businessName: string }[];
};

type PaginatedResponse<T> = {
  items: T[];
  nextCursor?: string | null;
};

type ApprovalPolicy = {
  id: string;
  actionType: string;
};

type Role = {
  id: string;
  name: string;
};

type Transfer = {
  id: string;
};

type CheckpointState = {
  runId: string;
  email: string;
  password: string;
  userId?: string;
  businessId?: string;
  branchId?: string;
  secondaryBranchId?: string;
  unitId?: string;
  categoryId?: string;
  productId?: string;
  variantId?: string;
  supplierId?: string;
  customerId?: string;
  roleId?: string;
  rolePermissionIds?: string[];
  createdUserId?: string;
  createdUserEmail?: string;
  createdUserPassword?: string;
  barcodeId?: string;
  secondaryVariantId?: string;
  purchaseId?: string;
  purchaseOrderId?: string;
  transferId?: string;
  priceListId?: string;
  saleDraftId?: string;
  saleDraftVoidId?: string;
  creditSaleId?: string;
  receiptId?: string;
  noteId?: string;
  reminderId?: string;
  shiftId?: string;
  attachmentId?: string;
  exportJobId?: string;
  supportRequestId?: string;
  platformExportJobId?: string;
  deviceId?: string;
};

type CheckpointData = {
  version: number;
  lastCompletedStep: number;
  lastCompletedLabel: string;
  updatedAt: string;
  state: CheckpointState;
};

const BASE_URL = process.env.BACKEND_BASE_URL ?? 'http://localhost:3000/api/v1';
const CHECKPOINT_ENABLED = process.env.NVI_TEST_CHECKPOINT !== 'false';
const CHECKPOINT_FILE =
  process.env.NVI_TEST_CHECKPOINT_FILE ??
  path.join(process.cwd(), '.nvi-integration-checkpoint.json');
const RESET_CHECKPOINT = process.env.NVI_TEST_RESET_CHECKPOINT === 'true';
const KEEP_CHECKPOINT = process.env.NVI_TEST_KEEP_CHECKPOINT === 'true';
const ALLOW_DESTRUCTIVE = process.env.NVI_TEST_ALLOW_DESTRUCTIVE === 'true';

const readCheckpointRunId = () => {
  if (!CHECKPOINT_ENABLED || RESET_CHECKPOINT) {
    return undefined;
  }
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CheckpointData;
    return parsed?.state?.runId;
  } catch {
    return undefined;
  }
};

const RUN_ID =
  process.env.NVI_TEST_RUN_ID ??
  readCheckpointRunId() ??
  Date.now().toString();
const TEST_EMAIL =
  process.env.NVI_TEST_EMAIL ?? `owner+${RUN_ID}@test.local`;
const TEST_PASSWORD = process.env.NVI_TEST_PASSWORD ?? 'StrongPass123';
const TEST_BUSINESS =
  process.env.NVI_TEST_BUSINESS ?? `NVI Test Business ${RUN_ID}`;
const TEST_OWNER = process.env.NVI_TEST_OWNER ?? 'Test Owner';
const TEST_DEVICE = process.env.NVI_TEST_DEVICE ?? `nvi-test-device-${RUN_ID}`;

const logStep = (label: string) => {
  console.log(`\n==> ${label}`);
};

const request = async <T>(
  path: string,
  { method = 'GET', token, body }: RequestOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error(
      `Request failed ${method} ${path}: ${response.status} ${response.statusText} ${text}`,
    );
    (error as Error & { status?: number; payload?: unknown }).status =
      response.status;
    (error as Error & { payload?: unknown }).payload = data;
    throw error;
  }

  return data as T;
};

const ensure = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const loadCheckpoint = (): CheckpointData | null => {
  if (!CHECKPOINT_ENABLED) {
    return null;
  }
  if (RESET_CHECKPOINT && fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    return null;
  }
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CheckpointData;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const saveCheckpoint = (data: CheckpointData) => {
  if (!CHECKPOINT_ENABLED) {
    return;
  }
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
};

const clearCheckpoint = () => {
  if (!CHECKPOINT_ENABLED || KEEP_CHECKPOINT) {
    return;
  }
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
  }
};

const run = async () => {
  const checkpoint = loadCheckpoint();
  const runMatches = checkpoint?.state?.runId === RUN_ID;
  const state: CheckpointState = runMatches
    ? { ...checkpoint.state }
    : {
        runId: RUN_ID,
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      };
  state.runId = RUN_ID;
  state.email = state.email ?? TEST_EMAIL;
  state.password = state.password ?? TEST_PASSWORD;
  let lastCompletedStep = runMatches
    ? checkpoint?.lastCompletedStep ?? -1
    : -1;
  let stepIndex = 0;
  const runStep = async (
    label: string,
    options: {
      requiredState?: Array<keyof CheckpointState>;
      allowSkip?: boolean;
    } = {},
    fn: () => Promise<void>,
  ) => {
    const requiredState = options.requiredState ?? [];
    const allowSkip = options.allowSkip !== false;
    const currentIndex = stepIndex++;
    const missingRequired = requiredState.filter((key) => !state[key]);
    const shouldSkip =
      CHECKPOINT_ENABLED &&
      runMatches &&
      allowSkip &&
      currentIndex <= lastCompletedStep;
    if (shouldSkip) {
      if (missingRequired.length) {
        console.log(
          `\n==> ${label} (re-running; missing state: ${missingRequired.join(', ')})`,
        );
      } else {
        console.log(`\n==> ${label} (skipped)`);
        return;
      }
    }
    logStep(label);
    await fn();
    lastCompletedStep = Math.max(lastCompletedStep, currentIndex);
    saveCheckpoint({
      version: 1,
      lastCompletedStep,
      lastCompletedLabel: label,
      updatedAt: new Date().toISOString(),
      state,
    });
  };

  await runStep('Health check', {}, async () => {
    await request('/health');
  });

  let verificationToken: string | undefined;
  await runStep(
    'Signup business + owner',
    { requiredState: ['userId', 'businessId'] },
    async () => {
      const signup = await request<{
        verificationRequired: boolean;
        userId: string;
        businessId: string;
        verificationToken?: string;
      }>('/auth/signup', {
        method: 'POST',
        body: {
          businessName: TEST_BUSINESS,
          ownerName: TEST_OWNER,
          email: TEST_EMAIL,
          password: TEST_PASSWORD,
          tier: 'BUSINESS',
        },
      });
      verificationToken = signup.verificationToken;
      state.userId = signup.userId;
      state.businessId = signup.businessId;
    },
  );

  if (verificationToken) {
    await runStep('Confirm email verification', { allowSkip: false }, async () => {
      await request('/auth/email-verification/confirm', {
        method: 'POST',
        body: { token: verificationToken },
      });
    });
  }

  let userId = state.userId ?? '';
  let businessId = state.businessId ?? '';
  ensure(Boolean(userId), 'Missing user id for test run.');
  ensure(Boolean(businessId), 'Missing business id for test run.');

  let token = '';
  let refreshToken: string | null = null;
  let activeBusinessId = businessId;
  await runStep('Login', { allowSkip: false }, async () => {
    const auth = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: {
        email: state.email ?? TEST_EMAIL,
        password: state.password ?? TEST_PASSWORD,
        deviceId: TEST_DEVICE,
      },
    });
    if (!auth.accessToken && auth.businessSelectionRequired) {
      const selected = auth.businesses?.[0]?.businessId;
      ensure(Boolean(selected), 'No business available for selection.');
      const followup = await request<AuthResponse>('/auth/login', {
        method: 'POST',
        body: {
          email: state.email ?? TEST_EMAIL,
          password: state.password ?? TEST_PASSWORD,
          deviceId: TEST_DEVICE,
          businessId: selected,
        },
      });
      if (!followup.accessToken) {
        console.error('Login response:', followup);
      }
      ensure(Boolean(followup.accessToken), 'Missing access token after login.');
      token = followup.accessToken as string;
      refreshToken = followup.refreshToken ?? null;
      activeBusinessId = selected as string;
      state.businessId = activeBusinessId;
      if (followup.user?.id) {
        state.userId = followup.user.id;
      }
    } else {
      if (!auth.accessToken) {
        console.error('Login response:', auth);
      }
      ensure(Boolean(auth.accessToken), 'Missing access token after login.');
      token = auth.accessToken as string;
      refreshToken = auth.refreshToken ?? null;
      if (auth.businessId) {
        activeBusinessId = auth.businessId;
        state.businessId = auth.businessId;
      }
      if (auth.user?.id) {
        state.userId = auth.user.id;
      }
    }
  });
  userId = state.userId ?? userId;
  businessId = state.businessId ?? businessId;
  ensure(Boolean(userId), 'Missing user id after login.');
  ensure(Boolean(businessId), 'Missing business id after login.');

  const isUnauthorized = (error: unknown) => {
    const status = (error as { status?: number }).status;
    return status === 401;
  };

  const refreshAccessToken = async () => {
    if (!refreshToken) {
      return null;
    }
    const refreshed = await request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: {
        userId,
        businessId: activeBusinessId,
        deviceId: TEST_DEVICE,
        refreshToken,
      },
    });
    ensure(Boolean(refreshed.accessToken), 'Missing access token after refresh.');
    token = refreshed.accessToken as string;
    refreshToken = refreshed.refreshToken ?? refreshToken;
    return token;
  };

  const authedRequest = async <T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> => {
    try {
      return await request<T>(path, { ...options, token });
    } catch (error) {
      if (isUnauthorized(error)) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return await request<T>(path, { ...options, token });
        }
      }
      throw error;
    }
  };

  logStep('Refresh token');
  if (refreshToken) {
    await refreshAccessToken();
  }

  await runStep('Current user', { allowSkip: false }, async () => {
    await authedRequest('/users/me');
  });

  let branchId = state.branchId;
  let secondaryBranchId = state.secondaryBranchId;
  await runStep(
    'Create branch',
    { requiredState: ['branchId', 'secondaryBranchId'] },
    async () => {
      const branch = await authedRequest<{ id: string; name: string }>(
        '/branches',
        {
          method: 'POST',
          token,
          body: {
            name: 'Main Branch',
            address: 'HQ',
            phone: '+000000000',
          },
        },
      );
      const secondaryBranch = await authedRequest<{ id: string; name: string }>(
        '/branches',
        {
          method: 'POST',
          token,
          body: {
            name: 'Secondary Branch',
            address: 'Branch 2',
            phone: '+000000001',
          },
        },
      );
      await authedRequest(`/branches/${branch.id}`, {
        method: 'PUT',
        token,
        body: {
          name: 'Main Branch HQ',
          address: 'HQ Updated',
          phone: '+000000000',
        },
      });
      branchId = branch.id;
      secondaryBranchId = secondaryBranch.id;
      state.branchId = branchId;
      state.secondaryBranchId = secondaryBranchId;
    },
  );
  ensure(Boolean(branchId), 'Missing branch id for test run.');
  ensure(Boolean(secondaryBranchId), 'Missing secondary branch id for test run.');

  await runStep('Disable purchase approvals for test run', {}, async () => {
    await authedRequest('/settings', {
      method: 'PUT',
      token,
      body: {
        approvalDefaults: {
          purchase: false,
        },
      },
    });
    const settings = await authedRequest<{
      approvalDefaults?: { purchase?: boolean };
    }>(
      '/settings',
      { token },
    );
    if (settings?.approvalDefaults?.purchase !== false) {
      throw new Error(
        `Approval defaults not updated (purchase=${String(settings?.approvalDefaults?.purchase)})`,
      );
    }
  });

  await runStep('Allow self-approve purchase policies for test run', {}, async () => {
    const purchaseActions = new Set([
      'PURCHASE_CREATE',
      'PURCHASE_ORDER_APPROVAL',
      'PURCHASE_ORDER_EDIT',
      'SUPPLIER_RETURN',
    ]);
    let cursor: string | null | undefined = null;
    do {
      const query = cursor ? `?limit=50&cursor=${cursor}` : '?limit=50';
      const page = await authedRequest<PaginatedResponse<ApprovalPolicy>>(
        `/approval-policies${query}`,
        { token },
      );
      for (const policy of page.items) {
        if (purchaseActions.has(policy.actionType)) {
          await authedRequest(`/approval-policies/${policy.id}`, {
            method: 'PUT',
            token,
            body: { allowSelfApprove: true },
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  });

  let unitId = state.unitId;
  await runStep('Ensure default unit', { requiredState: ['unitId'] }, async () => {
    const units = await authedRequest<Array<{ id: string; code: string }>>(
      '/units',
      {
        token,
      },
    );
    unitId = units.find((unit) => unit.code === 'piece')?.id;
    if (!unitId) {
      const createdUnit = await authedRequest<{ id: string; code: string }>(
        '/units',
        {
          method: 'POST',
          token,
          body: { code: 'piece', label: 'Piece' },
        },
      );
      unitId = createdUnit.id;
    }
    state.unitId = unitId;
  });
  ensure(Boolean(unitId), 'Missing unit id for test run.');

  let categoryId = state.categoryId;
  await runStep('Create category', { requiredState: ['categoryId'] }, async () => {
    const category = await authedRequest<{ id: string }>('/categories', {
      method: 'POST',
      token,
      body: { name: 'Beverages' },
    });
    await authedRequest(`/categories/${category.id}`, {
      method: 'PUT',
      token,
      body: { name: 'Beverages & Drinks' },
    });
    categoryId = category.id;
    state.categoryId = categoryId;
  });
  ensure(Boolean(categoryId), 'Missing category id for test run.');

  let productId = state.productId;
  await runStep('Create product', { requiredState: ['productId'] }, async () => {
    const product = await authedRequest<{ id: string }>('/products', {
      method: 'POST',
      token,
      body: { name: 'Sparkling Water', categoryId },
    });
    await authedRequest(`/products/${product.id}`, {
      method: 'PUT',
      token,
      body: { name: 'Sparkling Water', categoryId },
    });
    productId = product.id;
    state.productId = productId;
  });
  ensure(Boolean(productId), 'Missing product id for test run.');

  let variantId = state.variantId;
  await runStep('Create variant', { requiredState: ['variantId'] }, async () => {
    const variant = await authedRequest<{ id: string }>('/variants', {
      method: 'POST',
      token,
      body: {
        productId,
        name: 'Sparkling Water 500ml',
        defaultPrice: 2.5,
        defaultCost: 1.2,
        baseUnitId: unitId,
        sellUnitId: unitId,
      },
    });
    await authedRequest(`/variants/${variant.id}`, {
      method: 'PUT',
      token,
      body: {
        name: 'Sparkling Water 500ml',
        defaultPrice: 2.5,
        defaultCost: 1.2,
        baseUnitId: unitId,
        sellUnitId: unitId,
      },
    });
    variantId = variant.id;
    state.variantId = variantId;
  });
  ensure(Boolean(variantId), 'Missing variant id for test run.');

  await runStep('Catalog list + barcode actions', {}, async () => {
    await authedRequest('/categories?limit=5', { token });
    await authedRequest('/products?limit=5', { token });
    await authedRequest(`/variants?limit=5&productId=${productId}`, { token });

    const barcode = await authedRequest<{ id: string; code: string }>(
      '/barcodes',
      {
        method: 'POST',
        token,
        body: { variantId, code: `BC-${RUN_ID}` },
      },
    );
    state.barcodeId = barcode.id;
    await authedRequest(`/barcodes/lookup?code=${encodeURIComponent(barcode.code)}`, {
      token,
    });
    await authedRequest('/barcodes/generate', {
      method: 'POST',
      token,
      body: { variantId },
    });

    if (!state.secondaryVariantId) {
      const secondary = await authedRequest<{ id: string }>('/variants', {
        method: 'POST',
        token,
        body: {
          productId,
          name: `Sparkling Water 1L ${RUN_ID}`,
          defaultPrice: 4.5,
          defaultCost: 2.1,
          baseUnitId: unitId,
          sellUnitId: unitId,
        },
      });
      state.secondaryVariantId = secondary.id;
    }

    if (state.barcodeId && state.secondaryVariantId) {
      await authedRequest(`/barcodes/${state.barcodeId}/reassign`, {
        method: 'POST',
        token,
        body: { newVariantId: state.secondaryVariantId, reason: 'Test reassignment' },
      });
    }

    await authedRequest(`/variants/${variantId}/sku`, {
      method: 'POST',
      token,
      body: { sku: `SKU-${RUN_ID}-ALT`, reason: 'Test SKU update' },
    });
    await authedRequest(`/variants/${variantId}/availability`, {
      method: 'POST',
      token,
      body: { branchId, isActive: true },
    });
    await authedRequest('/barcodes/labels', {
      method: 'POST',
      token,
      body: { variantIds: [variantId] },
    });

    const storageReady = Boolean(
      process.env.S3_BUCKET ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    );
    if (storageReady) {
      await authedRequest(`/products/${productId}/images/presign`, {
        method: 'POST',
        token,
        body: {
          filename: `product-${RUN_ID}.jpg`,
          contentType: 'image/jpeg',
        },
      });
      const productImage = await authedRequest<{ id?: string }>(
        `/products/${productId}/images`,
        {
          method: 'POST',
          token,
          body: {
            url: `https://example.com/product-${RUN_ID}.jpg`,
            filename: `product-${RUN_ID}.jpg`,
            mimeType: 'image/jpeg',
            sizeMb: 0.1,
            isPrimary: true,
          },
        },
      );
      if (productImage?.id) {
        await authedRequest(`/products/${productId}/images/${productImage.id}/primary`, {
          method: 'POST',
          token,
        });
        await authedRequest(`/products/${productId}/images/${productImage.id}/remove`, {
          method: 'POST',
          token,
        });
      }

      await authedRequest(`/variants/${variantId}/image/presign`, {
        method: 'POST',
        token,
        body: {
          filename: `variant-${RUN_ID}.jpg`,
          contentType: 'image/jpeg',
        },
      });
      await authedRequest(`/variants/${variantId}/image`, {
        method: 'POST',
        token,
        body: { imageUrl: `https://example.com/variant-${RUN_ID}.jpg` },
      });
    } else {
      console.log('Skipping product/variant image endpoints (storage not configured).');
    }
  });

  let supplierId = state.supplierId;
  await runStep('Create supplier', { requiredState: ['supplierId'] }, async () => {
    const supplier = await authedRequest<{ id: string }>('/suppliers', {
      method: 'POST',
      token,
      body: { name: 'Blue Source', email: 'supply@test.local' },
    });
    supplierId = supplier.id;
    state.supplierId = supplierId;
  });
  ensure(Boolean(supplierId), 'Missing supplier id for test run.');

  let customerId = state.customerId;
  await runStep('Create customer', { requiredState: ['customerId'] }, async () => {
    const customer = await authedRequest<{ id: string }>('/customers', {
      method: 'POST',
      token,
      body: { name: 'City Shopper', email: 'customer@test.local' },
    });
    await authedRequest(`/customers/${customer.id}`, {
      method: 'PUT',
      token,
      body: { name: 'City Shopper', email: 'customer@test.local' },
    });
    customerId = customer.id;
    state.customerId = customerId;
  });
  ensure(Boolean(customerId), 'Missing customer id for test run.');

  let roleId = state.roleId;
  await runStep('Create role + assign', { requiredState: ['roleId'] }, async () => {
    const role = await authedRequest<Role>('/roles', {
      method: 'POST',
      token,
      body: { name: `Cashier ${RUN_ID}` },
    });
    await authedRequest(`/roles/${role.id}/permissions`, {
      method: 'PUT',
      token,
      body: { permissions: ['sales.write', 'sales.read'] },
    });
    await authedRequest(`/users/${userId}/roles`, {
      method: 'POST',
      token,
      body: { roleId: role.id },
    });
    roleId = role.id;
    state.roleId = roleId;
  });
  ensure(Boolean(roleId), 'Missing role id for test run.');

  await runStep('List branches', {}, async () => {
    await authedRequest('/branches?limit=5', { token });
  });

  await runStep('Read settings', {}, async () => {
    await authedRequest('/settings', { token });
  });

  await runStep('Enable credit sales for test run', {}, async () => {
    const settings = await authedRequest<{ posPolicies?: Record<string, unknown> }>(
      '/settings',
      { token },
    );
    await authedRequest('/settings', {
      method: 'PUT',
      token,
      body: {
        posPolicies: {
          ...(settings?.posPolicies ?? {}),
          creditEnabled: true,
        },
      },
    });
  });

  await runStep('Roles catalog checks', {}, async () => {
    await authedRequest('/roles?limit=5', { token });
    const permissions = await authedRequest<Array<{ id?: string } | string>>(
      '/roles/permissions',
      { token },
    );
    const permissionIds = permissions
      .map((permission) =>
        typeof permission === 'string' ? permission : permission.id,
      )
      .filter((id): id is string => Boolean(id));
    if (permissionIds.length) {
      state.rolePermissionIds = permissionIds.slice(0, 5);
      await authedRequest(`/roles/${roleId}/permissions`, {
        method: 'PUT',
        token,
        body: { permissionIds: state.rolePermissionIds },
      });
    }
    await authedRequest(`/roles/${roleId}/permissions`, { token });
    await authedRequest(`/roles/${roleId}`, {
      method: 'PUT',
      token,
      body: { name: `Cashier ${RUN_ID} Updated` },
    });
  });

  let createdUserId = state.createdUserId;
  let createdUserEmail = state.createdUserEmail;
  let createdUserPassword = state.createdUserPassword;
  await runStep(
    'User management checks',
    { requiredState: ['createdUserId', 'createdUserEmail', 'createdUserPassword'] },
    async () => {
      await authedRequest('/users?limit=5', { token });
      createdUserEmail = `user+${RUN_ID}@test.local`;
      createdUserPassword = 'TempPass123!';
      const created = await authedRequest<{ id: string }>('/users', {
        method: 'POST',
        token,
        body: {
          name: `User ${RUN_ID}`,
          email: createdUserEmail,
          tempPassword: createdUserPassword,
          mustResetPassword: true,
        },
      });
      createdUserId = created.id;
      state.createdUserId = createdUserId;
      state.createdUserEmail = createdUserEmail;
      state.createdUserPassword = createdUserPassword;
      await authedRequest(`/users/${createdUserId}`, {
        method: 'PUT',
        token,
        body: { name: `User ${RUN_ID} Updated` },
      });
      await authedRequest(`/users/${createdUserId}/roles`, { token });
      await authedRequest(`/users/${createdUserId}/roles`, {
        method: 'POST',
        token,
        body: { roleId },
      });
      await authedRequest(`/users/${createdUserId}/roles/remove`, {
        method: 'POST',
        token,
        body: { roleId },
      });
      const invite = await authedRequest<{ token?: string }>(
        '/users/invite',
        {
          method: 'POST',
          token,
          body: { email: `invite+${RUN_ID}@test.local`, roleId },
        },
      );
      if (invite?.token) {
        await request('/auth/invite/accept', {
          method: 'POST',
          body: {
            token: invite.token,
            name: `Invited ${RUN_ID}`,
            password: 'InvitePass123!',
          },
        });
      }
    },
  );

  await runStep('Auth auxiliary flows', {}, async () => {
    const businesses = await authedRequest<Array<{ businessId: string }>>(
      '/auth/businesses',
      { token },
    );
    const targetBusinessId =
      businesses?.[0]?.businessId ?? state.businessId ?? businessId;
    if (targetBusinessId) {
      const switchResult = await authedRequest<AuthResponse>(
        '/auth/switch-business',
        {
          method: 'POST',
          token,
          body: { businessId: targetBusinessId, deviceId: TEST_DEVICE },
        },
      );
      if (switchResult?.accessToken) {
        token = switchResult.accessToken;
        refreshToken = switchResult.refreshToken ?? refreshToken;
        activeBusinessId = switchResult.businessId ?? activeBusinessId;
      }
    }

    const smtpConfigured = Boolean(
      process.env.SMTP_HOST &&
        process.env.SMTP_USER &&
        process.env.SMTP_PASS &&
        process.env.SMTP_FROM,
    );
    if (smtpConfigured && createdUserEmail) {
      const reset = await request<{ token: string; userId: string }>(
        '/auth/password-reset/request',
        {
          method: 'POST',
          body: {
            email: createdUserEmail,
            businessId: state.businessId ?? businessId,
          },
        },
      );
      if (reset?.token && reset?.userId) {
        await request('/auth/password-reset/confirm', {
          method: 'POST',
          body: {
            userId: reset.userId,
            token: reset.token,
            password: 'ResetPass123!',
          },
        });
      }

      const verify = await request<{ token?: string }>(
        '/auth/email-verification/request',
        {
          method: 'POST',
          body: {
            email: createdUserEmail,
            businessId: state.businessId ?? businessId,
          },
        },
      );
      if (verify?.token) {
        await request('/auth/email-verification/confirm', {
          method: 'POST',
          body: { token: verify.token },
        });
      }
    } else {
      console.log('Skipping password reset + email verification requests (SMTP not configured).');
    }
  });

  await runStep(
    'Seed stock adjustment',
    { requiredState: ['branchId', 'variantId', 'unitId'] },
    async () => {
      await authedRequest('/stock/adjustments', {
        method: 'POST',
        token,
        body: {
          branchId,
          variantId,
          quantity: 50,
          unitId,
          type: 'POSITIVE',
          reason: 'Seed stock',
        },
      });
    },
  );

  await runStep(
    'Stock count',
    { requiredState: ['branchId', 'variantId', 'unitId'] },
    async () => {
      await authedRequest('/stock/counts', {
        method: 'POST',
        token,
        body: {
          branchId,
          variantId,
          countedQuantity: 48,
          unitId,
          reason: 'Cycle count',
        },
      });
    },
  );

  await runStep(
    'Reorder point',
    { requiredState: ['branchId', 'variantId'] },
    async () => {
      await authedRequest('/stock/reorder-points', {
        method: 'POST',
        token,
        body: {
          branchId,
          variantId,
          minQuantity: 5,
          reorderQuantity: 50,
        },
      });
    },
  );

  await runStep('Stock list + batches', {}, async () => {
    await authedRequest(`/stock?branchId=${branchId}&limit=5`, { token });
    await authedRequest(`/stock/movements?branchId=${branchId}&limit=5`, {
      token,
    });
    await authedRequest(`/stock/batches?branchId=${branchId}&limit=5`, { token });
    await authedRequest('/stock/batches', {
      method: 'POST',
      token,
      body: {
        branchId,
        variantId,
        code: `BATCH-${RUN_ID}`,
        expiryDate: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    await authedRequest(`/stock/batches?branchId=${branchId}&limit=5`, { token });
    await authedRequest(`/stock/reorder-points?branchId=${branchId}&limit=5`, {
      token,
    });
    await authedRequest(`/stock/reorder-suggestions?branchId=${branchId}`, {
      token,
    });
  });

  let purchaseOrderId = state.purchaseOrderId;
  await runStep(
    'Create purchase order',
    { requiredState: ['purchaseOrderId'] },
    async () => {
      const po = await authedRequest<{ id: string }>('/purchase-orders', {
        method: 'POST',
        token,
        body: {
          branchId,
          supplierId,
          lines: [
            { variantId, quantity: 10, unitCost: 1.1, unitId },
          ],
        },
      });
      purchaseOrderId = po.id;
      state.purchaseOrderId = purchaseOrderId;
    },
  );
  ensure(Boolean(purchaseOrderId), 'Missing purchase order id for test run.');

  await runStep(
    'Update purchase order',
    { requiredState: ['purchaseOrderId'] },
    async () => {
      await authedRequest(`/purchase-orders/${purchaseOrderId}`, {
        method: 'PUT',
        token,
        body: {
          lines: [
            { variantId, quantity: 12, unitCost: 1.05, unitId },
          ],
          expectedAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
    },
  );

  logStep('Approve purchase order');
  await runStep(
    'Approve purchase order',
    { requiredState: ['purchaseOrderId'] },
    async () => {
      const poApproval = await authedRequest<{ approvalRequired?: boolean }>(
        `/purchase-orders/${purchaseOrderId}/approve`,
        {
          method: 'POST',
          token,
        },
      );
      if (poApproval?.approvalRequired) {
        throw new Error('Purchase order approval still required after disabling.');
      }
    },
  );

  await runStep(
    'Receive purchase order',
    { requiredState: ['purchaseOrderId'] },
    async () => {
      await authedRequest('/receiving', {
        method: 'POST',
        token,
        body: {
          purchaseOrderId,
          lines: [
            { variantId, quantity: 10, unitCost: 1.1, unitId },
          ],
          overrideReason: 'Integration test override for PO receiving',
        },
      });
    },
  );

  let purchaseId = state.purchaseId;
  await runStep('Create purchase', { requiredState: ['purchaseId'] }, async () => {
    const purchase = await authedRequest<{ id: string }>('/purchases', {
      method: 'POST',
      token,
      body: {
        branchId,
        supplierId,
        lines: [
          { variantId, quantity: 5, unitCost: 1.2, unitId },
        ],
      },
    });
    purchaseId = purchase.id;
    state.purchaseId = purchaseId;
  });
  ensure(Boolean(purchaseId), 'Missing purchase id for test run.');

  await runStep('Purchase payments + returns', { requiredState: ['purchaseId'] }, async () => {
    await authedRequest(`/purchases/${purchaseId}/payments`, {
      method: 'POST',
      token,
      body: { method: 'CASH', amount: 3.0 },
    });
    await authedRequest('/supplier-returns', {
      method: 'POST',
      token,
      body: {
        branchId,
        supplierId,
        purchaseId,
        reason: 'Damaged items',
        lines: [
          { variantId, quantity: 1, unitCost: 1.1, unitId },
        ],
      },
    });
    await authedRequest('/purchases?limit=5', { token });
    await authedRequest('/purchase-orders?limit=5', { token });
    await authedRequest('/receiving?limit=5', { token });
    await authedRequest('/supplier-returns?limit=5', { token });
  });

  let transferId = state.transferId;
  await runStep('Create transfer', { requiredState: ['transferId'] }, async () => {
    const transfer = await authedRequest<Transfer>('/transfers', {
      method: 'POST',
      token,
      body: {
        sourceBranchId: branchId,
        destinationBranchId: secondaryBranchId,
        items: [{ variantId, quantity: 2 }],
      },
    });
    await authedRequest(`/transfers/${transfer.id}/approve`, {
      method: 'POST',
      token,
    });
    await authedRequest(`/transfers/${transfer.id}/receive`, {
      method: 'POST',
      token,
    });
    transferId = transfer.id;
    state.transferId = transferId;
  });
  ensure(Boolean(transferId), 'Missing transfer id for test run.');

  await runStep('Transfer list + cancel', {}, async () => {
    await authedRequest('/transfers?limit=5', { token });
    await authedRequest('/transfers/pending?limit=5', { token });
    const cancelTransfer = await authedRequest<Transfer>('/transfers', {
      method: 'POST',
      token,
      body: {
        sourceBranchId: branchId,
        destinationBranchId: secondaryBranchId,
        items: [{ variantId, quantity: 1 }],
      },
    });
    await authedRequest(`/transfers/${cancelTransfer.id}/cancel`, {
      method: 'POST',
      token,
    });
  });

  await runStep(
    'Create expense',
    { requiredState: ['branchId'] },
    async () => {
      await authedRequest('/expenses', {
        method: 'POST',
        token,
        body: {
          branchId,
          category: 'UTILITIES',
          amount: 15.5,
          expenseDate: new Date().toISOString(),
          note: 'Test expense',
        },
      });
    },
  );

  await runStep('List expenses', {}, async () => {
    await authedRequest(`/expenses?means=all&limit=5`, { token });
  });

  let priceListId = state.priceListId;
  await runStep('Price list', { requiredState: ['priceListId'] }, async () => {
    const priceList = await authedRequest<{ id: string }>('/price-lists', {
      method: 'POST',
      token,
      body: { name: `Promo ${RUN_ID}` },
    });
    await authedRequest(`/price-lists/${priceList.id}/items`, {
      method: 'POST',
      token,
      body: { variantId, price: 2.25 },
    });
    priceListId = priceList.id;
    state.priceListId = priceListId;
  });
  ensure(Boolean(priceListId), 'Missing price list id for test run.');

  await runStep('Price list list + update', {}, async () => {
    await authedRequest('/price-lists?limit=5', { token });
    await authedRequest(`/price-lists/${priceListId}`, {
      method: 'PUT',
      token,
      body: { name: `Promo ${RUN_ID} Updated` },
    });
  });

  let saleDraftId = state.saleDraftId;
  await runStep(
    'Create sales draft',
    { requiredState: ['saleDraftId'] },
    async () => {
      const saleDraft = await authedRequest<{ id: string }>('/sales/draft', {
        method: 'POST',
        token,
        body: {
          branchId,
          customerId,
          lines: [
            {
              variantId,
              quantity: 2,
              unitId,
              unitPrice: 2.5,
            },
          ],
        },
      });
      saleDraftId = saleDraft.id;
      state.saleDraftId = saleDraftId;
    },
  );
  ensure(Boolean(saleDraftId), 'Missing sale draft id for test run.');

  await runStep('Void draft sale', { requiredState: ['saleDraftVoidId'] }, async () => {
    const draft = await authedRequest<{ id: string }>('/sales/draft', {
      method: 'POST',
      token,
      body: {
        branchId,
        customerId,
        lines: [
          {
            variantId,
            quantity: 1,
            unitId,
            unitPrice: 2.5,
          },
        ],
      },
    });
    state.saleDraftVoidId = draft.id;
    await authedRequest(`/sales/${draft.id}/void`, { method: 'POST', token });
  });

  await runStep(
    'Complete sale',
    { requiredState: ['saleDraftId'] },
    async () => {
      await authedRequest<{ receipt?: { receiptNumber?: string } }>(
        '/sales/complete',
        {
          method: 'POST',
          token,
          body: {
            saleId: saleDraftId,
            payments: [{ method: 'CASH', amount: 5 }],
          },
        },
      );
    },
  );

  await runStep('Credit sale + settlement', { requiredState: ['creditSaleId'] }, async () => {
    const creditSettings = await authedRequest<{
      posPolicies?: { creditEnabled?: boolean };
    }>('/settings', { token });
    if (!creditSettings?.posPolicies?.creditEnabled) {
      console.log('Skipping credit sale tests (credit is disabled).');
      return;
    }
    const creditDraft = await authedRequest<{ id: string }>('/sales/draft', {
      method: 'POST',
      token,
      body: {
        branchId,
        customerId,
        lines: [
          {
            variantId,
            quantity: 2,
            unitId,
            unitPrice: 2.5,
          },
        ],
      },
    });
    state.creditSaleId = creditDraft.id;
    await authedRequest('/sales/complete', {
      method: 'POST',
      token,
      body: {
        saleId: creditDraft.id,
        payments: [{ method: 'CASH', amount: 2.5 }],
        creditDueDate: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    await authedRequest(`/sales/${creditDraft.id}/settlements`, {
      method: 'POST',
      token,
      body: { method: 'CASH', amount: 2.5 },
    });
  });

  await runStep(
    'Sale refund',
    { requiredState: ['saleDraftId'] },
    async () => {
      const refund = await authedRequest<{ approvalRequired?: boolean }>(
        `/sales/${saleDraftId}/refund`,
        {
          method: 'POST',
          token,
          body: { reason: 'Return', returnToStock: true },
        },
      );
      if (refund?.approvalRequired) {
        console.log(
          'Refund approval required; skipping further refund validation.',
        );
      }
    },
  );

  await runStep('Receipts', {}, async () => {
    const receipts = await authedRequest<{ items?: Array<{ id: string }> }>(
      '/sales/receipts?limit=5',
      { token },
    );
    const receiptId = receipts?.items?.[0]?.id;
    if (receiptId) {
      state.receiptId = receiptId;
      await authedRequest(`/sales/receipts/${receiptId}/reprint`, {
        method: 'POST',
        token,
      });
    }
    await authedRequest('/sales/returns/without-receipt', {
      method: 'POST',
      token,
      body: {
        branchId,
        reason: 'Return without receipt',
        returnToStock: true,
        items: [
          {
            variantId,
            quantity: 1,
            unitPrice: 2.5,
            unitId,
          },
        ],
      },
    });
  });

  await runStep('Stock report + sales report', {}, async () => {
    await authedRequest(`/reports/stock?branchId=${branchId}`, { token });
    await authedRequest(`/reports/sales?branchId=${branchId}`, { token });
    await authedRequest(`/reports/low-stock?branchId=${branchId}`, { token });
  });

  await runStep('Additional reports', {}, async () => {
    await authedRequest(`/reports/vat?branchId=${branchId}`, { token });
    await authedRequest(`/reports/vat-summary?branchId=${branchId}`, { token });
    await authedRequest(`/reports/pnl?branchId=${branchId}`, { token });
    await authedRequest(`/reports/expiry?branchId=${branchId}`, { token });
    await authedRequest(`/reports/losses/top?branchId=${branchId}`, { token });
    await authedRequest(`/reports/stock-count-variance?branchId=${branchId}`, {
      token,
    });
    await authedRequest(`/reports/staff?branchId=${branchId}`, { token });
    await authedRequest(`/reports/customers/sales?branchId=${branchId}`, {
      token,
    });
    await authedRequest(`/reports/customers/refunds?branchId=${branchId}`, {
      token,
    });
    await authedRequest(`/reports/customers/outstanding?branchId=${branchId}`, {
      token,
    });
    await authedRequest(`/reports/customers/top?branchId=${branchId}`, { token });
    await authedRequest(`/reports/customers/export?branchId=${branchId}`, {
      token,
    });
  });

  await runStep('Approvals + audit logs', {}, async () => {
    await authedRequest('/approvals?limit=10', { token });
    const auditLogs = await authedRequest<{ items?: Array<{ id: string }> }>(
      '/audit-logs?limit=10',
      { token },
    );
    const auditId = auditLogs?.items?.[0]?.id;
    if (auditId) {
      await authedRequest(`/audit-logs/${auditId}`, { token });
    }
    await authedRequest('/audit-logs/export?format=csv', { token });
  });

  await runStep('Exports job', {}, async () => {
    const job = await authedRequest<{ id: string }>('/exports/jobs', {
      method: 'POST',
      token,
      body: { type: 'STOCK', branchId },
    });
    state.exportJobId = job.id;
    await authedRequest('/exports/jobs?limit=5', { token });
    await authedRequest(`/exports/stock?branchId=${branchId}`, { token });
    await authedRequest('/exports/worker/status', { token });
    const storageReady = Boolean(
      process.env.S3_BUCKET ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    );
    if (storageReady) {
      await authedRequest(`/exports/jobs/${job.id}/run`, {
        method: 'POST',
        token,
        body: { acknowledgement: 'Test export' },
      });
      await authedRequest(`/exports/jobs/${job.id}/download`, { token });
    } else {
      console.log('Skipping export run/download (storage not configured).');
    }
  });

  let deviceId = state.deviceId;
  await runStep('Offline device register + status', { requiredState: ['deviceId'] }, async () => {
    const device = await authedRequest<{ id: string }>('/offline/register-device', {
      method: 'POST',
      token,
      body: { deviceName: 'Test device', deviceId: TEST_DEVICE },
    });
    deviceId = device.id;
    state.deviceId = deviceId;
    await authedRequest(`/offline/status?deviceId=${deviceId}`, { token });
  });

  await runStep(
    'Offline risk + conflicts',
    { requiredState: ['deviceId'] },
    async () => {
      await authedRequest('/offline/risk', { token });
      const conflicts = await authedRequest<PaginatedResponse<{ id: string }>>(
        `/offline/conflicts?deviceId=${deviceId}&limit=1`,
        { token },
      );
      const conflictId = conflicts.items?.[0]?.id;
      if (conflictId) {
        await authedRequest('/offline/conflicts/resolve', {
          method: 'POST',
          token,
          body: { actionId: conflictId, resolution: 'DISMISS' },
        });
      }
      await authedRequest('/offline/status', {
        method: 'POST',
        token,
        body: { deviceId, status: 'ONLINE' },
      });
      try {
        await authedRequest('/offline/sync', {
          method: 'POST',
          token,
          body: { userId, deviceId, actions: [] },
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403) {
          console.log('Skipping offline sync (offline mode not enabled).');
        } else {
          throw error;
        }
      }
      await authedRequest('/offline/revoke-device', {
        method: 'POST',
        token,
        body: { deviceId },
      });
    },
  );

  await runStep('Notes + reminders', { requiredState: ['branchId'] }, async () => {
    await authedRequest('/notes?limit=5', { token });
    await authedRequest('/notes/meta', { token });
    await authedRequest('/notes/linkables?type=customer&query=City', { token });
    await authedRequest('/notes/reminders/overview?limit=5', { token });

    const note = await authedRequest<{ id: string }>('/notes', {
      method: 'POST',
      token,
      body: {
        title: `Test Note ${RUN_ID}`,
        body: 'Integration runner note.',
        visibility: 'BUSINESS',
        branchId,
        tags: ['integration'],
        links: [{ resourceType: 'Customer', resourceId: customerId }],
      },
    });
    state.noteId = note.id;
    await authedRequest(`/notes/${note.id}`, { token });
    await authedRequest(`/notes/${note.id}`, {
      method: 'PUT',
      token,
      body: { title: `Test Note ${RUN_ID} Updated` },
    });
    await authedRequest(`/notes/${note.id}/reminders`, { token });
    await authedRequest(`/notes/${note.id}/reminders`, {
      method: 'POST',
      token,
      body: {
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        channels: ['IN_APP'],
      },
    });
    const reminders = await authedRequest<Array<{ id: string }>>(
      `/notes/${note.id}/reminders`,
      { token },
    );
    const reminderId = reminders?.[0]?.id;
    if (reminderId) {
      state.reminderId = reminderId;
      await authedRequest(`/notes/reminders/${reminderId}/cancel`, {
        method: 'POST',
        token,
      });
    }
    await authedRequest(`/notes/${note.id}/archive`, {
      method: 'POST',
      token,
    });
  });

  await runStep('Shifts', { requiredState: ['branchId'] }, async () => {
    const openShift = await authedRequest<{ id?: string } | null>(
      `/shifts/open?branchId=${branchId}`,
      { token },
    );
    let shiftId = openShift?.id ?? state.shiftId;
    if (!shiftId) {
      const opened = await authedRequest<{ id: string }>('/shifts/open', {
        method: 'POST',
        token,
        body: {
          branchId,
          openingCash: 50,
          notes: 'Integration runner shift',
        },
      });
      shiftId = opened.id;
    }
    state.shiftId = shiftId;
    await authedRequest(`/shifts?branchId=${branchId}&limit=5`, { token });
    if (shiftId) {
      await authedRequest(`/shifts/${shiftId}/close`, {
        method: 'POST',
        token,
        body: { closingCash: 50 },
      });
    }
  });

  await runStep(
    'Attachments',
    { requiredState: ['purchaseId'] },
    async () => {
      const storageReady = Boolean(
        process.env.S3_BUCKET ||
          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
      );
      if (storageReady) {
        await authedRequest('/attachments/presign', {
          method: 'POST',
          token,
          body: {
            purchaseId,
            filename: `receipt-${RUN_ID}.pdf`,
            mimeType: 'application/pdf',
          },
        });
      }
      const attachment = await authedRequest<{ id: string }>('/attachments', {
        method: 'POST',
        token,
        body: {
          purchaseId,
          filename: `receipt-${RUN_ID}.pdf`,
          url: `https://example.com/receipt-${RUN_ID}.pdf`,
          mimeType: 'application/pdf',
          sizeMb: 0.05,
        },
      });
      state.attachmentId = attachment.id;
      await authedRequest(`/attachments?purchaseId=${purchaseId}&limit=5`, {
        token,
      });
      await authedRequest(`/attachments/${attachment.id}/remove`, {
        method: 'POST',
        token,
      });
    },
  );

  await runStep('Imports', {}, async () => {
    const csv = `name,status\nImported ${RUN_ID},ACTIVE`;
    await authedRequest('/imports/preview', {
      method: 'POST',
      token,
      body: { type: 'categories', csv },
    });
    await authedRequest('/imports/apply', {
      method: 'POST',
      token,
      body: { type: 'categories', csv },
    });
  });

  await runStep('Access requests', {}, async () => {
    await authedRequest('/access-requests', {
      method: 'POST',
      token,
      body: {
        permission: 'reports.read',
        path: '/reports',
        reason: 'Integration test request',
      },
    });
  });

  await runStep('Business + subscription', {}, async () => {
    await authedRequest('/business', { token });
    await authedRequest('/business', {
      method: 'PUT',
      token,
      body: { name: `${TEST_BUSINESS} Updated`, defaultLanguage: 'en' },
    });
    await authedRequest('/subscription', { token });
    const existingRequests = await authedRequest<
      Array<{ id?: string }> | { items?: Array<{ id?: string }> }
    >('/subscription/requests', { token });
    const requestItems = Array.isArray(existingRequests)
      ? existingRequests
      : existingRequests.items ?? [];
    if (!requestItems.length) {
      await authedRequest('/subscription/requests', {
        method: 'POST',
        token,
        body: {
          type: 'UPGRADE',
          requestedTier: 'BUSINESS',
          reason: 'Integration runner test',
        },
      });
    }
    if (ALLOW_DESTRUCTIVE) {
      await authedRequest('/business/delete', {
        method: 'POST',
        token,
        body: {
          businessId,
          password: state.password ?? TEST_PASSWORD,
          confirmText: 'DELETE',
        },
      });
    } else {
      console.log('Skipping business delete (destructive tests disabled).');
    }
  });

  await runStep('Support access requests', {}, async () => {
    const requests = await authedRequest<PaginatedResponse<{ id: string }>>(
      '/support-access/requests?limit=5',
      { token },
    );
    const requestId = requests.items?.[0]?.id;
    if (requestId) {
      await authedRequest(`/support-access/requests/${requestId}/approve`, {
        method: 'POST',
        token,
        body: { durationHours: 1, decisionNote: 'Test approve' },
      });
    }
  });

  await runStep('Platform admin checks', {}, async () => {
    const platformEmail = process.env.PLATFORM_ADMIN_EMAIL;
    const platformPassword = process.env.PLATFORM_ADMIN_PASSWORD;
    if (!platformEmail || !platformPassword) {
      console.log('Skipping platform admin checks (credentials not set).');
      return;
    }
    const platformAuth = await request<{ accessToken?: string }>(
      '/platform/auth/login',
      {
        method: 'POST',
        body: { email: platformEmail, password: platformPassword },
      },
    );
    const platformToken = platformAuth.accessToken;
    ensure(Boolean(platformToken), 'Missing platform access token.');

    const platformRequest = async <T>(
      path: string,
      options: RequestOptions = {},
    ): Promise<T> => request<T>(path, { ...options, token: platformToken });

    const businesses = await platformRequest<PaginatedResponse<{ id: string }>>(
      '/platform/businesses?limit=5',
    );
    const platformBusinessId = businesses.items?.[0]?.id ?? businessId;
    await platformRequest('/platform/metrics?range=24h');
    await platformRequest('/platform/audit-logs?limit=5');
    await platformRequest('/platform/platform-audit-logs?limit=5');
    await platformRequest('/platform/subscription-requests?limit=5');
    await platformRequest('/platform/exports/jobs?limit=5');

    if (platformBusinessId) {
      await platformRequest(
        `/platform/subscriptions/${platformBusinessId}/history`,
      );
      await platformRequest(
        `/platform/businesses/${platformBusinessId}/health`,
      );
      await platformRequest(
        `/platform/businesses/${platformBusinessId}/devices`,
      );
      await platformRequest('/platform/support-access/requests', {
        method: 'POST',
        body: {
          businessId: platformBusinessId,
          reason: 'Integration runner test',
          durationHours: 1,
        },
      });
      const supportRequests = await platformRequest<
        PaginatedResponse<{ id: string }>
      >('/platform/support-access/requests?limit=5');
      const supportRequestId = supportRequests.items?.[0]?.id;
      if (supportRequestId) {
        await platformRequest(
          `/platform/support-access/requests/${supportRequestId}/activate`,
          { method: 'POST' },
        );
      }
    }
  });

  await runStep('Notifications', {}, async () => {
    const list = await authedRequest<PaginatedResponse<{ id: string }>>(
      '/notifications?limit=5',
      { token },
    );
    const notificationIds = list.items?.map((item) => item.id) ?? [];
    if (notificationIds[0]) {
      await authedRequest(`/notifications/${notificationIds[0]}/read`, {
        method: 'POST',
        token,
      });
      await authedRequest('/notifications/read-bulk', {
        method: 'POST',
        token,
        body: { ids: notificationIds.slice(0, 2) },
      });
      await authedRequest('/notifications/archive-bulk', {
        method: 'POST',
        token,
        body: { ids: notificationIds.slice(0, 2) },
      });
    }
    await authedRequest('/notifications/read-all', { method: 'POST', token });
    await authedRequest('/notifications/announcement', { token });
  });

  await runStep('Search', {}, async () => {
    await authedRequest(`/search?query=${encodeURIComponent('sparkling')}`, {
      token,
    });
  });

  await runStep('Logout', { allowSkip: false }, async () => {
    if (refreshToken) {
      await authedRequest('/auth/logout', {
        method: 'POST',
        token,
        body: { refreshToken },
      });
    }
  });

  logStep('Runner completed successfully.');
  clearCheckpoint();
};

run().catch((error) => {
  console.error('Integration runner failed:', error);
  process.exitCode = 1;
});
