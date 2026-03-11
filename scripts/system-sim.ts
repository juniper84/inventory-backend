import path from 'path';
import {
  type SimulationProfile,
  resolveSimulationProfile,
} from './system-sim.config';
import {
  type CheckpointData,
  clearCheckpoint,
  readCheckpoint,
  saveCheckpoint,
} from './system-sim.checkpoint';
import {
  type RequestMetric,
  type StepMetric,
  writeSimulationReport,
} from './system-sim.report';
import { runSimulationAssertions } from './system-sim.assertions';

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

type Branch = { id: string; name: string };
type Unit = { id: string; code: string; label: string };
type RecordWithId = { id: string };
type BusinessSummary = { id: string; name: string; defaultLanguage?: string };
type SupportChatResponse = {
  summary?: string;
  confidence?: 'low' | 'medium' | 'high' | string;
  escalate?: boolean;
};

type SimulationState = {
  runId: string;
  email: string;
  password: string;
  profile: SimulationProfile['name'];
  businessId?: string;
  userId?: string;
  branchIds: string[];
  unitId?: string;
  categoryIds: string[];
  productIds: string[];
  variantIds: string[];
  supplierIds: string[];
  customerIds: string[];
  completedSaleIds: string[];
  progress: Record<string, number>;
  metrics: {
    createdBranches: number;
    createdRoles: number;
    createdUsers: number;
    createdCategories: number;
    createdProducts: number;
    createdVariants: number;
    createdSuppliers: number;
    createdCustomers: number;
    stockAdjustments: number;
    purchaseOrders: number;
    receivingEvents: number;
    transfers: number;
    salesDrafts: number;
    salesCompleted: number;
    creditSalesCompleted: number;
    settlementsCreated: number;
    refundsRequested: number;
    expensesCreated: number;
    notesCreated: number;
    notificationActions: number;
    reportsCalled: number;
    exportJobsCreated: number;
    assistantCalls: number;
  };
  warnings: string[];
};

const BASE_URL = process.env.BACKEND_BASE_URL ?? 'http://localhost:3000/api/v1';
const CHECKPOINT_ENABLED = process.env.NVI_SIM_CHECKPOINT !== 'false';
const RESET_CHECKPOINT = process.env.NVI_SIM_RESET_CHECKPOINT === 'true';
const KEEP_CHECKPOINT = process.env.NVI_SIM_KEEP_CHECKPOINT === 'true';
const CHECKPOINT_FILE =
  process.env.NVI_SIM_CHECKPOINT_FILE ??
  path.join(process.cwd(), '.nvi-system-sim-checkpoint.json');
const PROFILE = resolveSimulationProfile(process.env.NVI_SIM_PROFILE);

const TEST_EMAIL = process.env.NVI_TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.NVI_TEST_PASSWORD ?? '';
const TEST_DEVICE = process.env.NVI_TEST_DEVICE ?? `nvi-sim-device-${Date.now()}`;
const FAIL_FAST = process.env.NVI_SIM_FAIL_FAST !== 'false';
const CONFIRMED = process.env.NVI_SIM_CONFIRM === 'YES';
const ALLOW_PROD = process.env.NVI_SIM_ALLOW_PROD === 'true';
const MAX_RETRIES = Number(process.env.NVI_SIM_MAX_RETRIES ?? 5);
const SCOPE = process.env.NVI_SIM_SCOPE ?? 'business-only';
const STOCK_SEED_PER_VARIANT = Number(
  process.env.NVI_SIM_STOCK_SEED_PER_VARIANT ?? 40,
);

const ensure = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const normalizePaginated = <T>(input: unknown): PaginatedResponse<T> => {
  if (Array.isArray(input)) {
    return { items: input as T[] };
  }
  if (input && typeof input === 'object' && Array.isArray((input as any).items)) {
    return input as PaginatedResponse<T>;
  }
  return { items: [] };
};

const hashString = (input: string) => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number) => {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(arr: T[], random: () => number): T =>
  arr[Math.floor(random() * arr.length)];

const randomTzs = (random: () => number, min: number, max: number) =>
  Math.round(min + random() * (max - min));

const pushCapped = (arr: string[], value: string, max = 2000) => {
  arr.push(value);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
};

const buildUniqueVariantLines = (
  variantIds: string[],
  count: number,
  random: () => number,
  unitId?: string,
) => {
  const chosen = new Set<string>();
  const lines: Array<{
    variantId: string;
    quantity: number;
    unitCost?: number;
    unitPrice?: number;
    unitId?: string;
  }> = [];
  while (lines.length < count && chosen.size < variantIds.length) {
    const candidate = pick(variantIds, random);
    if (chosen.has(candidate)) {
      continue;
    }
    chosen.add(candidate);
    lines.push({
      variantId: candidate,
      quantity: Math.floor(1 + random() * 4),
      unitId,
    });
  }
  return lines;
};

const logStep = (label: string) => {
  console.log(`\n==> ${label}`);
};

const run = async () => {
  ensure(
    CONFIRMED,
    'Set NVI_SIM_CONFIRM=YES to run simulation. This prevents accidental execution.',
  );
  ensure(
    SCOPE === 'business-only',
    'Set NVI_SIM_SCOPE=business-only to run this simulation.',
  );
  ensure(TEST_EMAIL, 'NVI_TEST_EMAIL is required.');
  ensure(TEST_PASSWORD, 'NVI_TEST_PASSWORD is required.');
  if (
    !ALLOW_PROD &&
    /(api\.newvisioninventory\.com|app\.newvisioninventory\.com|newvisioninventory\.com)/i.test(
      BASE_URL,
    )
  ) {
    throw new Error(
      `Refusing to run against production-like host (${BASE_URL}). Set NVI_SIM_ALLOW_PROD=true to override.`,
    );
  }

  const existing = readCheckpoint<SimulationState>(
    CHECKPOINT_FILE,
    RESET_CHECKPOINT,
    CHECKPOINT_ENABLED,
  );
  const runId = process.env.NVI_TEST_RUN_ID ?? existing?.state.runId ?? Date.now().toString();
  const state: SimulationState = existing?.state ?? {
    runId,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
      profile: PROFILE.name,
    branchIds: [],
    categoryIds: [],
    productIds: [],
    variantIds: [],
    supplierIds: [],
    customerIds: [],
    completedSaleIds: [],
    progress: {},
      metrics: {
        createdBranches: 0,
        createdRoles: 0,
        createdUsers: 0,
        createdCategories: 0,
        createdProducts: 0,
        createdVariants: 0,
        createdSuppliers: 0,
        createdCustomers: 0,
        stockAdjustments: 0,
        purchaseOrders: 0,
        receivingEvents: 0,
        transfers: 0,
        salesDrafts: 0,
        salesCompleted: 0,
        creditSalesCompleted: 0,
        settlementsCreated: 0,
        refundsRequested: 0,
        expensesCreated: 0,
        notesCreated: 0,
        notificationActions: 0,
        reportsCalled: 0,
        exportJobsCreated: 0,
        assistantCalls: 0,
    },
    warnings: [],
  };
  state.email = TEST_EMAIL;
  state.password = TEST_PASSWORD;
  state.profile = PROFILE.name;

  let lastCompletedStep = existing?.lastCompletedStep ?? -1;
  let stepIndex = 0;
  let currentLabel = existing?.lastCompletedLabel ?? 'start';
  const requestMetrics: RequestMetric[] = [];
  const stepMetrics: StepMetric[] = [];

  const request = async <T>(
    route: string,
    { method = 'GET', token, body }: RequestOptions = {},
    retry = 0,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const startedAt = Date.now();
    const response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    const requestBytes = body ? Buffer.byteLength(JSON.stringify(body), 'utf8') : 0;
    const responseBytes = text ? Buffer.byteLength(text, 'utf8') : 0;
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const status = response.status;
      if (retry < MAX_RETRIES && (status === 429 || status >= 500)) {
        const jitter = Math.floor(Math.random() * 150);
        const delay = 300 * Math.pow(2, retry) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return request<T>(route, { method, token, body }, retry + 1);
      }
      requestMetrics.push({
        key: `${method} ${route.split('?')[0]}`,
        method,
        route,
        ms: durationMs,
        ok: false,
        status,
        retryCount: retry,
        requestBytes,
        responseBytes,
      });
      const error = new Error(
        `Request failed ${method} ${route}: ${status} ${response.statusText} ${text}`,
      );
      (error as Error & { status?: number; payload?: unknown }).status = status;
      (error as Error & { payload?: unknown }).payload = payload;
      throw error;
    }
    requestMetrics.push({
      key: `${method} ${route.split('?')[0]}`,
      method,
      route,
      ms: durationMs,
      ok: true,
      status: response.status,
      retryCount: retry,
      requestBytes,
      responseBytes,
    });
    return payload as T;
  };

  let token = '';
  let refreshToken: string | null = null;
  let activeBusinessId = state.businessId ?? '';

  const isUnauthorized = (error: unknown) =>
    (error as { status?: number }).status === 401;

  const refreshAccessToken = async () => {
    if (!refreshToken || !state.userId || !activeBusinessId) {
      return null;
    }
    const refreshed = await request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: {
        userId: state.userId,
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
    route: string,
    options: RequestOptions = {},
  ): Promise<T> => {
    try {
      return await request<T>(route, { ...options, token });
    } catch (error) {
      if (isUnauthorized(error)) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return request<T>(route, { ...options, token });
        }
      }
      throw error;
    }
  };

  const optionalAuthedRequest = async <T>(
    route: string,
    options: RequestOptions = {},
  ): Promise<T | null> => {
    try {
      return await authedRequest<T>(route, options);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 403 || status === 404) {
        addWarning(`Optional route skipped (${status}) ${options.method ?? 'GET'} ${route}`);
        return null;
      }
      throw error;
    }
  };

  const persistCheckpoint = () => {
    saveCheckpoint(CHECKPOINT_FILE, {
      version: 1,
      lastCompletedStep,
      lastCompletedLabel: currentLabel,
      updatedAt: new Date().toISOString(),
      state,
    }, CHECKPOINT_ENABLED);
  };

  const addWarning = (warning: string) => {
    state.warnings.push(warning);
    console.warn(`[warning] ${warning}`);
  };

  const runStep = async (
    label: string,
    fn: () => Promise<void>,
    allowSkip = true,
  ) => {
    const current = stepIndex++;
    if (allowSkip && current <= lastCompletedStep) {
      console.log(`\n==> ${label} (skipped)`);
      return;
    }
    logStep(label);
    currentLabel = label;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    await fn();
    const endedAt = new Date().toISOString();
    stepMetrics.push({
      label,
      startedAt,
      endedAt,
      ms: Date.now() - startedMs,
    });
    lastCompletedStep = current;
    persistCheckpoint();
  };

  const runBatched = async (
    progressKey: string,
    total: number,
    worker: (index: number) => Promise<void>,
    checkpointEvery = 25,
  ) => {
    const start = state.progress[progressKey] ?? 0;
    if (start >= total) {
      return;
    }
    for (let index = start; index < total; index += 1) {
      try {
        await worker(index);
      } catch (error) {
        persistCheckpoint();
        throw error;
      }
      state.progress[progressKey] = index + 1;
      if ((index + 1) % checkpointEvery === 0 || index + 1 === total) {
        persistCheckpoint();
        console.log(
          `[${progressKey}] ${index + 1}/${total}`,
        );
      }
    }
    delete state.progress[progressKey];
    persistCheckpoint();
  };

  const random = mulberry32(hashString(state.runId));

  try {
    await runStep('Health check', async () => {
      await request('/health');
    }, false);

    await runStep('Login', async () => {
      const auth = await request<AuthResponse>('/auth/login', {
        method: 'POST',
        body: {
          email: state.email,
          password: state.password,
          deviceId: TEST_DEVICE,
        },
      });
      if (!auth.accessToken && auth.businessSelectionRequired) {
        const selected = auth.businesses?.[0]?.businessId;
        ensure(Boolean(selected), 'No business available for selection.');
        const followup = await request<AuthResponse>('/auth/login', {
          method: 'POST',
          body: {
            email: state.email,
            password: state.password,
            deviceId: TEST_DEVICE,
            businessId: selected,
          },
        });
        ensure(Boolean(followup.accessToken), 'Missing access token after login.');
        token = followup.accessToken as string;
        refreshToken = followup.refreshToken ?? null;
        activeBusinessId = selected as string;
        state.businessId = activeBusinessId;
        if (followup.user?.id) {
          state.userId = followup.user.id;
        }
      } else {
        ensure(Boolean(auth.accessToken), 'Missing access token after login.');
        token = auth.accessToken as string;
        refreshToken = auth.refreshToken ?? null;
        activeBusinessId = auth.businessId ?? activeBusinessId;
        state.businessId = auth.businessId ?? state.businessId;
        if (auth.user?.id) {
          state.userId = auth.user.id;
        }
      }
      ensure(Boolean(state.businessId), 'Business id missing after login.');
      ensure(Boolean(state.userId), 'User id missing after login.');
    }, false);

    await runStep('Current context', async () => {
      await authedRequest('/users/me');
      const business = await authedRequest<BusinessSummary>('/business');
      state.businessId = business.id;
      activeBusinessId = business.id;
    }, false);

    await runStep('Prepare settings for high-volume simulation', async () => {
      const current = await authedRequest<{
        approvalDefaults?: Record<string, unknown>;
        posPolicies?: Record<string, unknown>;
      }>('/settings');
      await authedRequest('/settings', {
        method: 'PUT',
        body: {
          approvalDefaults: {
            ...(current.approvalDefaults ?? {}),
            stockAdjust: false,
            purchase: false,
            refund: false,
            transfer: false,
            expense: false,
          },
          posPolicies: {
            ...(current.posPolicies ?? {}),
            creditEnabled: true,
            shiftTrackingEnabled: false,
          },
        },
      });
    });

    await runStep('Ensure branches', async () => {
      const branchPage = await authedRequest<PaginatedResponse<Branch> | Branch[]>(
        '/branches?limit=200',
      );
      const existingBranches = normalizePaginated<Branch>(branchPage).items;
      state.branchIds = Array.from(
        new Set([...state.branchIds, ...existingBranches.map((b) => b.id)]),
      );
      const missing = Math.max(0, PROFILE.branches - state.branchIds.length);
      await runBatched(
        'branches.create',
        missing,
        async (index) => {
          const branch = await authedRequest<Branch>('/branches', {
            method: 'POST',
            body: {
              name: `SIM-${state.runId}-Branch-${state.branchIds.length + 1}`,
              address: `Simulation Address ${index + 1}`,
              phone: `+255700${String(index + 1).padStart(6, '0')}`,
            },
          });
          state.branchIds.push(branch.id);
          state.metrics.createdBranches += 1;
        },
        5,
      );
      ensure(state.branchIds.length >= 2, 'At least 2 branches are required.');
    });

    await runStep('Ensure base unit', async () => {
      const units = await authedRequest<Unit[]>('/units');
      const piece =
        units.find((item) => item.code.toLowerCase() === 'piece') ?? units[0];
      if (!piece) {
        const created = await authedRequest<Unit>('/units', {
          method: 'POST',
          body: { code: 'piece', label: 'Piece' },
        });
        state.unitId = created.id;
      } else {
        state.unitId = piece.id;
      }
      ensure(Boolean(state.unitId), 'Unit id is required for simulation.');
    });

    await runStep('Create categories', async () => {
      const existingCount = state.categoryIds.length;
      await runBatched(
        'categories.create',
        PROFILE.categories,
        async (index) => {
          if (index < existingCount || state.categoryIds[index]) {
            return;
          }
          const created = await authedRequest<RecordWithId>('/categories', {
            method: 'POST',
            body: { name: `SIM-${state.runId}-Category-${index + 1}` },
          });
          state.categoryIds[index] = created.id;
          state.metrics.createdCategories += 1;
        },
        10,
      );
    });

    await runStep('Create suppliers', async () => {
      const existingCount = state.supplierIds.length;
      await runBatched(
        'suppliers.create',
        PROFILE.suppliers,
        async (index) => {
          if (index < existingCount || state.supplierIds[index]) {
            return;
          }
          const created = await authedRequest<RecordWithId>('/suppliers', {
            method: 'POST',
            body: {
              name: `SIM-${state.runId}-Supplier-${index + 1}`,
              email: `sim-supplier-${state.runId}-${index + 1}@local.test`,
              phone: `+255711${String(index + 1).padStart(6, '0')}`,
            },
          });
          state.supplierIds[index] = created.id;
          state.metrics.createdSuppliers += 1;
        },
        10,
      );
    });

    await runStep('Create customers', async () => {
      const existingCount = state.customerIds.length;
      await runBatched(
        'customers.create',
        PROFILE.customers,
        async (index) => {
          if (index < existingCount || state.customerIds[index]) {
            return;
          }
          const created = await authedRequest<RecordWithId>('/customers', {
            method: 'POST',
            body: {
              name: `SIM-${state.runId}-Customer-${index + 1}`,
              email: `sim-customer-${state.runId}-${index + 1}@local.test`,
              phone: `+255722${String(index + 1).padStart(6, '0')}`,
            },
          });
          state.customerIds[index] = created.id;
          state.metrics.createdCustomers += 1;
        },
        25,
      );
    });

    await runStep('Create products', async () => {
      ensure(state.categoryIds.length > 0, 'Category ids missing.');
      const existingCount = state.productIds.length;
      await runBatched(
        'products.create',
        PROFILE.products,
        async (index) => {
          if (index < existingCount || state.productIds[index]) {
            return;
          }
          const categoryId = state.categoryIds[index % state.categoryIds.length];
          const created = await authedRequest<RecordWithId>('/products', {
            method: 'POST',
            body: {
              name: `SIM-${state.runId}-Product-${index + 1}`,
              categoryId,
            },
          });
          state.productIds[index] = created.id;
          state.metrics.createdProducts += 1;
        },
        10,
      );
    });

    await runStep('Create variants', async () => {
      ensure(state.productIds.length > 0, 'Product ids missing.');
      ensure(Boolean(state.unitId), 'Unit id missing.');
      const totalVariants = PROFILE.variants;
      const existingCount = state.variantIds.length;
      await runBatched(
        'variants.create',
        totalVariants,
        async (index) => {
          if (index < existingCount || state.variantIds[index]) {
            return;
          }
          const productId = state.productIds[index % state.productIds.length];
          const created = await authedRequest<RecordWithId>('/variants', {
            method: 'POST',
            body: {
              productId,
              name: `SIM-${state.runId}-Variant-${index + 1}`,
              defaultPrice: randomTzs(random, 8_000, 120_000),
              defaultCost: randomTzs(random, 4_000, 80_000),
              baseUnitId: state.unitId,
              sellUnitId: state.unitId,
            },
          });
          state.variantIds[index] = created.id;
          state.metrics.createdVariants += 1;
          await authedRequest('/barcodes/generate', {
            method: 'POST',
            body: { variantId: created.id },
          });
        },
        15,
      );
    });

    await runStep('Seed stock across variants', async () => {
      ensure(state.branchIds.length > 0, 'Branch ids missing.');
      ensure(state.variantIds.length > 0, 'Variant ids missing.');
      await runBatched(
        'stock.seed',
        state.variantIds.length,
        async (index) => {
          const variantId = state.variantIds[index];
          const branchId = state.branchIds[index % state.branchIds.length];
          await authedRequest('/stock/adjustments', {
            method: 'POST',
            body: {
              branchId,
              variantId,
              quantity: STOCK_SEED_PER_VARIANT,
              unitId: state.unitId,
              type: 'POSITIVE',
              reason: `Simulation seed ${state.runId}`,
            },
          });
          state.metrics.stockAdjustments += 1;
        },
        20,
      );
    });

    await runStep('Stock extended operations', async () => {
      const branchId = pick(state.branchIds, random);
      const variantId = pick(state.variantIds, random);
      await optionalAuthedRequest(`/stock?branchId=${branchId}&limit=20`);
      await optionalAuthedRequest(`/stock/movements?branchId=${branchId}&limit=20`);
      await optionalAuthedRequest(`/stock/batches?branchId=${branchId}&limit=20`);
      await optionalAuthedRequest('/stock/batches', {
        method: 'POST',
        body: {
          branchId,
          variantId,
          code: `SIM-BATCH-${state.runId}-${Date.now()}`,
          expiryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      await optionalAuthedRequest('/stock/counts', {
        method: 'POST',
        body: {
          branchId,
          variantId,
          countedQuantity: Math.floor(STOCK_SEED_PER_VARIANT * 0.9),
          unitId: state.unitId,
          reason: `Simulation stock count ${state.runId}`,
        },
      });
      await optionalAuthedRequest('/stock/reorder-points', {
        method: 'POST',
        body: {
          branchId,
          variantId,
          minQuantity: 5,
          reorderQuantity: 40,
        },
      });
      await optionalAuthedRequest(`/stock/reorder-points?branchId=${branchId}&limit=20`);
      await optionalAuthedRequest(`/stock/reorder-suggestions?branchId=${branchId}`);
    });

    await runStep('Stock operations load', async () => {
      await runBatched(
        'stock.ops',
        PROFILE.stockOps,
        async () => {
          const branchId = pick(state.branchIds, random);
          const variantId = pick(state.variantIds, random);
          const asCount = random() < 0.25;
          if (asCount) {
            await authedRequest('/stock/counts', {
              method: 'POST',
              body: {
                branchId,
                variantId,
                countedQuantity: Math.floor(Math.max(1, STOCK_SEED_PER_VARIANT * random())),
                unitId: state.unitId,
                reason: `Simulation stock-count ${state.runId}`,
              },
            });
          } else {
            await authedRequest('/stock/adjustments', {
              method: 'POST',
              body: {
                branchId,
                variantId,
                quantity: Math.floor(1 + random() * 3),
                unitId: state.unitId,
                type: random() < 0.7 ? 'POSITIVE' : 'NEGATIVE',
                reason: `Simulation stock-op ${state.runId}`,
              },
            });
          }
          state.metrics.stockAdjustments += 1;
        },
        20,
      );
    });

    await runStep('Purchase order lifecycle load', async () => {
      ensure(state.supplierIds.length > 0, 'Supplier ids missing.');
      ensure(state.variantIds.length > 0, 'Variant ids missing.');
      await runBatched(
        'purchaseOrders.bulk',
        PROFILE.purchaseOrders,
        async () => {
          const branchId = pick(state.branchIds, random);
          const supplierId = pick(state.supplierIds, random);
          const lineCount = random() < 0.75 ? 1 : 2;
          const lines = buildUniqueVariantLines(
            state.variantIds,
            lineCount,
            random,
            state.unitId,
          ).map((line) => ({
            variantId: line.variantId,
            quantity: Math.max(2, line.quantity),
            unitCost: randomTzs(random, 3_500, 70_000),
            unitId: line.unitId,
          }));
          const po = await authedRequest<RecordWithId | { approvalRequired?: boolean }>(
            '/purchase-orders',
            {
              method: 'POST',
              body: { branchId, supplierId, lines },
            },
          );
          if ('approvalRequired' in po && po.approvalRequired) {
            addWarning('Purchase order approval required unexpectedly; skipping one PO.');
            return;
          }
          const poId = (po as RecordWithId).id;
          await authedRequest(`/purchase-orders/${poId}/approve`, {
            method: 'POST',
          });
          await authedRequest('/receiving', {
            method: 'POST',
            body: {
              purchaseOrderId: poId,
              lines,
              overrideReason: `Simulation receive ${state.runId}`,
            },
          });
          state.metrics.receivingEvents += 1;
          state.metrics.purchaseOrders += 1;
        },
        10,
      );
    });

    await runStep('Transfer lifecycle load', async () => {
      ensure(state.branchIds.length > 1, 'Need at least two branches for transfers.');
      ensure(state.variantIds.length > 0, 'Variant ids missing.');
      await runBatched(
        'transfers.bulk',
        PROFILE.transfers,
        async () => {
          const source = pick(state.branchIds, random);
          let destination = pick(state.branchIds, random);
          if (destination === source) {
            destination =
              state.branchIds[(state.branchIds.indexOf(source) + 1) % state.branchIds.length];
          }
          const items = [
            {
              variantId: pick(state.variantIds, random),
              quantity: Math.floor(1 + random() * 4),
            },
          ];
          const transfer = await authedRequest<RecordWithId>('/transfers', {
            method: 'POST',
            body: {
              sourceBranchId: source,
              destinationBranchId: destination,
              items,
            },
          });
          await authedRequest(`/transfers/${transfer.id}/approve`, {
            method: 'POST',
          });
          if (random() < 0.1) {
            await authedRequest(`/transfers/${transfer.id}/cancel`, {
              method: 'POST',
            });
          } else {
            await authedRequest(`/transfers/${transfer.id}/receive`, {
              method: 'POST',
            });
          }
          state.metrics.transfers += 1;
        },
        20,
      );
    });

    await runStep('Direct purchases + payments + supplier returns load', async () => {
      const directPurchaseCount = Math.max(15, Math.floor(PROFILE.purchaseOrders * 0.35));
      await runBatched(
        'purchases.direct',
        directPurchaseCount,
        async () => {
          const branchId = pick(state.branchIds, random);
          const supplierId = pick(state.supplierIds, random);
          const lines = buildUniqueVariantLines(
            state.variantIds,
            random() < 0.8 ? 1 : 2,
            random,
            state.unitId,
          ).map((line) => ({
            variantId: line.variantId,
            quantity: Math.max(1, line.quantity),
            unitCost: randomTzs(random, 3_500, 70_000),
            unitId: line.unitId,
          }));

          const purchase = await authedRequest<RecordWithId | { approvalRequired?: boolean }>(
            '/purchases',
            {
              method: 'POST',
              body: { branchId, supplierId, lines },
            },
          );
          if ('approvalRequired' in purchase && purchase.approvalRequired) {
            addWarning('Direct purchase unexpectedly required approval; skipped one item.');
            return;
          }
          const purchaseId = (purchase as RecordWithId).id;
          const paymentAmount = Number(
            lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0).toFixed(0),
          );
          await authedRequest(`/purchases/${purchaseId}/payments`, {
            method: 'POST',
            body: {
              method: pick(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'], random),
              amount: paymentAmount,
            },
          });

          if (random() < 0.2) {
            const returnLine = lines[0];
            try {
              await authedRequest('/supplier-returns', {
                method: 'POST',
                body: {
                  branchId,
                  supplierId,
                  purchaseId,
                  reason: `Simulation supplier return ${state.runId}`,
                  lines: [
                    {
                      variantId: returnLine.variantId,
                      quantity: 1,
                      unitCost: returnLine.unitCost,
                      unitId: returnLine.unitId,
                    },
                  ],
                },
              });
            } catch (error) {
              const status = (error as { status?: number }).status;
              const message = String((error as Error).message ?? '');
              if (
                status === 400 &&
                (message.includes('INSUFFICIENT_STOCK_FOR_SUPPLIER_RETURN') ||
                  message.includes('Insufficient stock for supplier return'))
              ) {
                addWarning(
                  `Supplier return skipped for purchase ${purchaseId}; insufficient returnable stock.`,
                );
              } else {
                throw error;
              }
            }
          }
        },
        10,
      );
    });

    await runStep('Expense load', async () => {
      const expenseCategories = [
        'GENERAL',
        'SHIPPING',
        'UTILITIES',
        'RENT',
        'PAYROLL',
        'OTHER',
      ];
      await runBatched(
        'expenses.bulk',
        PROFILE.expenses,
        async () => {
          await authedRequest('/expenses', {
            method: 'POST',
            body: {
              branchId: pick(state.branchIds, random),
              category: pick(expenseCategories, random),
              amount: randomTzs(random, 20_000, 900_000),
              expenseDate: new Date().toISOString(),
              note: `Simulation expense ${state.runId}`,
            },
          });
          state.metrics.expensesCreated += 1;
        },
        25,
      );
    });

    await runStep('Sales draft load', async () => {
      await runBatched(
        'sales.drafts',
        PROFILE.salesDrafts,
        async () => {
          const branchId = pick(state.branchIds, random);
          const customerId = pick(state.customerIds, random);
          const lines = buildUniqueVariantLines(
            state.variantIds,
            random() < 0.7 ? 1 : 2,
            random,
            state.unitId,
          ).map((line) => ({
            variantId: line.variantId,
            quantity: Math.max(1, line.quantity),
            unitId: line.unitId,
            unitPrice: randomTzs(random, 8_000, 130_000),
          }));

          await authedRequest<RecordWithId>('/sales/draft', {
            method: 'POST',
            body: { branchId, customerId, lines },
          });
          state.metrics.salesDrafts += 1;
        },
        20,
      );
    });

    await runStep('Sales + credit + refunds load', async () => {
      ensure(state.customerIds.length > 0, 'Customer ids missing.');
      ensure(state.variantIds.length > 0, 'Variant ids missing.');
      const paymentMethods = ['CASH', 'CARD', 'MOBILE_MONEY', 'BANK_TRANSFER'] as const;
      const refundTarget = PROFILE.refunds;
      let refundsIssued = state.metrics.refundsRequested;
      let creditIssued = state.metrics.creditSalesCompleted;
      let settlementsIssued = state.metrics.settlementsCreated;
      const isInsufficientStockForSale = (error: unknown) => {
        const status = (error as { status?: number }).status;
        const message = String((error as Error).message ?? '');
        return (
          status === 400 &&
          (message.includes('INSUFFICIENT_STOCK_FOR_SALE') ||
            message.includes('Insufficient stock for sale'))
        );
      };
      const buildSalesLinesForBranch = async (
        branchId: string,
        lineCount: number,
      ) => {
        const stockPage = await optionalAuthedRequest<
          PaginatedResponse<Array<{ variantId?: string; quantity?: string | number }>> | Array<{ variantId?: string; quantity?: string | number }>
        >(`/stock?branchId=${branchId}&limit=200`);
        const stockItems = stockPage ? normalizePaginated<{ variantId?: string; quantity?: string | number }>(stockPage).items : [];
        const inStockVariantIds = stockItems
          .filter((item) => Number(item.quantity ?? 0) >= 1 && item.variantId)
          .map((item) => item.variantId as string);
        const sourceVariantIds =
          inStockVariantIds.length > 0 ? inStockVariantIds : state.variantIds;
        return buildUniqueVariantLines(
          sourceVariantIds,
          lineCount,
          random,
          state.unitId,
        ).map((line) => ({
          variantId: line.variantId,
          quantity: Math.max(1, line.quantity),
          unitId: line.unitId,
          unitPrice: randomTzs(random, 8_000, 130_000),
        }));
      };

      await runBatched(
        'sales.bulk',
        PROFILE.completedSales,
        async (index) => {
          const branchId = pick(state.branchIds, random);
          const customerId = pick(state.customerIds, random);
          const lineCount = random() < 0.75 ? 1 : random() < 0.9 ? 2 : 3;
          let completed = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const lines = await buildSalesLinesForBranch(branchId, lineCount);
            const draft = await authedRequest<RecordWithId>('/sales/draft', {
              method: 'POST',
              body: { branchId, customerId, lines },
            });

            const gross = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
            const remaining = PROFILE.completedSales - index;
            const remainingCredit = Math.max(0, PROFILE.creditSales - creditIssued);
            const creditProbability = remaining > 0 ? remainingCredit / remaining : 0;
            const isCredit =
              remainingCredit > 0 && random() < Math.max(creditProbability, 0.05);
            const upfront = isCredit
              ? Number(Math.max(1000, gross * (0.25 + random() * 0.45)).toFixed(0))
              : Number(gross.toFixed(0));
            const method = pick(paymentMethods as unknown as string[], random);

            try {
              await authedRequest('/sales/complete', {
                method: 'POST',
                body: {
                  saleId: draft.id,
                  payments: [{ method, amount: upfront }],
                  ...(isCredit
                    ? {
                        creditDueDate: new Date(
                          Date.now() + 5 * 24 * 60 * 60 * 1000,
                        ).toISOString(),
                      }
                    : {}),
                },
              });
            } catch (error) {
              if (!isInsufficientStockForSale(error)) {
                throw error;
              }
              addWarning(
                `Sale completion skipped for draft ${draft.id}; insufficient stock at completion (attempt ${attempt + 1}/3).`,
              );
              await optionalAuthedRequest(`/sales/${draft.id}/void`, { method: 'POST' });
              continue;
            }

            completed = true;
            state.metrics.salesCompleted += 1;
            pushCapped(state.completedSaleIds, draft.id);
            if (isCredit) {
              creditIssued += 1;
              state.metrics.creditSalesCompleted = creditIssued;
            }

            const canSettle = isCredit && gross - upfront > 0.5;
            const needsSettlement = settlementsIssued < PROFILE.settlements;
            if (canSettle && (needsSettlement || random() < 0.65)) {
              await authedRequest(`/sales/${draft.id}/settlements`, {
                method: 'POST',
                body: {
                  method: pick(paymentMethods as unknown as string[], random),
                  amount: Number((gross - upfront).toFixed(0)),
                },
              });
              settlementsIssued += 1;
              state.metrics.settlementsCreated = settlementsIssued;
            }

            if (
              refundsIssued < refundTarget &&
              state.completedSaleIds.length > 0 &&
              random() < 0.09
            ) {
              try {
                await authedRequest(`/sales/${draft.id}/refund`, {
                  method: 'POST',
                  body: {
                    reason: `Simulation refund ${state.runId}`,
                    returnToStock: true,
                  },
                });
                refundsIssued += 1;
                state.metrics.refundsRequested = refundsIssued;
              } catch (error) {
                const status = (error as { status?: number }).status;
                if (status === 400 || status === 403) {
                  addWarning(
                    `Refund skipped for sale ${draft.id}; business rule rejected request.`,
                  );
                } else {
                  throw error;
                }
              }
            }

            break;
          }
          if (!completed) {
            addWarning(
              `Sale slot ${index + 1} skipped after repeated insufficient stock conflicts.`,
            );
          }
        },
        20,
      );
    });

    await runStep('Sales receipts + refund endpoint smoke', async () => {
      await optionalAuthedRequest('/sales/receipts?limit=20');
      const saleId = state.completedSaleIds[state.completedSaleIds.length - 1];
      if (saleId) {
        await optionalAuthedRequest(`/sales/${saleId}/refund`, {
          method: 'POST',
          body: {
            reason: `Simulation endpoint refund ${state.runId}`,
            returnToStock: true,
          },
        });
      }
    });

    await runStep('Sales return-without-receipt load', async () => {
      const returnCount = Math.max(10, Math.floor(PROFILE.refunds * 0.25));
      await runBatched(
        'sales.returnWithoutReceipt',
        returnCount,
        async () => {
          const branchId = pick(state.branchIds, random);
          const items = buildUniqueVariantLines(
            state.variantIds,
            random() < 0.8 ? 1 : 2,
            random,
            state.unitId,
          ).map((line) => ({
            variantId: line.variantId,
            quantity: 1,
            unitPrice: randomTzs(random, 8_000, 130_000),
            unitId: line.unitId,
          }));
          await authedRequest('/sales/returns/without-receipt', {
            method: 'POST',
            body: {
              branchId,
              reason: `Simulation return without receipt ${state.runId}`,
              returnToStock: true,
              items,
            },
          });
        },
        10,
      );
    });

    await runStep('Price list load', async () => {
      const listCount = Math.max(5, Math.floor(PROFILE.products / 25));
      await runBatched(
        'priceLists.bulk',
        listCount,
        async (index) => {
          const list = await authedRequest<RecordWithId>('/price-lists', {
            method: 'POST',
            body: {
              name: `SIM-${state.runId}-PriceList-${index + 1}`,
            },
          });
          const itemCount = Math.min(8, Math.max(2, Math.floor(random() * 8)));
          const itemVariants = buildUniqueVariantLines(
            state.variantIds,
            itemCount,
            random,
            state.unitId,
          );
          for (const line of itemVariants) {
            await authedRequest(`/price-lists/${list.id}/items`, {
              method: 'POST',
              body: {
                variantId: line.variantId,
                price: randomTzs(random, 7_000, 125_000),
              },
            });
          }
          if (random() < 0.3) {
            await authedRequest(`/price-lists/${list.id}`, {
              method: 'PUT',
              body: { name: `SIM-${state.runId}-PriceList-${index + 1}-Updated` },
            });
          }
        },
        5,
      );
      await authedRequest('/price-lists?limit=20');
    });

    await runStep('Users + roles load', async () => {
      const roleIds: string[] = [];
      const availablePermissions =
        (await optionalAuthedRequest<Array<{ id: string }>>('/roles/permissions')) ?? [];

      await runBatched(
        'roles.create',
        PROFILE.roles,
        async (index) => {
          const role = await optionalAuthedRequest<RecordWithId>('/roles', {
            method: 'POST',
            body: { name: `SIM-${state.runId}-Role-${index + 1}` },
          });
          if (!role?.id) {
            return;
          }
          roleIds.push(role.id);
          state.metrics.createdRoles += 1;
          if (availablePermissions.length > 0) {
            const permissionIds = availablePermissions
              .slice(0, Math.min(8, availablePermissions.length))
              .map((p) => p.id);
            await optionalAuthedRequest(`/roles/${role.id}/permissions`, {
              method: 'PUT',
              body: { permissionIds },
            });
          }
        },
        5,
      );

      await runBatched(
        'users.create',
        PROFILE.users,
        async (index) => {
          const user = await optionalAuthedRequest<RecordWithId>('/users', {
            method: 'POST',
            body: {
              name: `Sim User ${index + 1}`,
              email: `sim-user-${state.runId}-${index + 1}@local.test`,
              phone: `+255733${String(index + 1).padStart(6, '0')}`,
              status: 'ACTIVE',
            },
          });
          if (!user?.id) {
            return;
          }
          state.metrics.createdUsers += 1;
          const roleId = roleIds[index % roleIds.length];
          if (roleId) {
            await optionalAuthedRequest(`/users/${user.id}/roles`, {
              method: 'POST',
              body: {
                roleId,
                branchId: state.branchIds[index % state.branchIds.length] ?? null,
              },
            });
          }
        },
        10,
      );

      await optionalAuthedRequest('/roles?limit=20');
      await optionalAuthedRequest('/users?limit=20');
    });

    await runStep('Attachments + imports smoke', async () => {
      const branchId = pick(state.branchIds, random);
      const supplierId = pick(state.supplierIds, random);
      const line = {
        variantId: pick(state.variantIds, random),
        quantity: 1,
        unitCost: randomTzs(random, 3_500, 70_000),
        unitId: state.unitId,
      };
      const purchase = await optionalAuthedRequest<RecordWithId>('/purchases', {
        method: 'POST',
        body: {
          branchId,
          supplierId,
          lines: [line],
        },
      });
      if (purchase?.id) {
        await optionalAuthedRequest('/attachments/presign', {
          method: 'POST',
          body: {
            purchaseId: purchase.id,
            filename: `sim-${state.runId}.pdf`,
            mimeType: 'application/pdf',
          },
        });
        const attachment = await optionalAuthedRequest<RecordWithId>('/attachments', {
          method: 'POST',
          body: {
            purchaseId: purchase.id,
            filename: `sim-${state.runId}.pdf`,
            url: `https://example.com/sim-${state.runId}.pdf`,
            mimeType: 'application/pdf',
            sizeMb: 0.05,
          },
        });
        await optionalAuthedRequest(`/attachments?purchaseId=${purchase.id}&limit=10`);
        if (attachment?.id) {
          await optionalAuthedRequest(`/attachments/${attachment.id}/remove`, {
            method: 'POST',
          });
        }
      }

      const csv = `name,status\nSIM Import ${state.runId},ACTIVE`;
      await optionalAuthedRequest('/imports/preview', {
        method: 'POST',
        body: { type: 'categories', csv },
      });
      await optionalAuthedRequest('/imports/apply', {
        method: 'POST',
        body: { type: 'categories', csv },
      });
    });

    await runStep('Notes + reminders load', async () => {
      ensure(state.customerIds.length > 0, 'Customer ids missing for notes.');
      await runBatched(
        'notes.bulk',
        PROFILE.notes,
        async (index) => {
          const note = await authedRequest<RecordWithId>('/notes', {
            method: 'POST',
            body: {
              title: `SIM-${state.runId}-Note-${index + 1}`,
              body: 'System simulation note payload.',
              visibility: 'BUSINESS',
              branchId: pick(state.branchIds, random),
              tags: ['simulation', state.runId],
              links: [
                {
                  resourceType: 'Customer',
                  resourceId: pick(state.customerIds, random),
                },
              ],
            },
          });
          state.metrics.notesCreated += 1;

          if (random() < 0.35) {
            await authedRequest(`/notes/${note.id}/reminders`, {
              method: 'POST',
              body: {
                scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
                channels: ['IN_APP'],
              },
            });
          }
          if (random() < 0.12) {
            await authedRequest(`/notes/${note.id}/archive`, {
              method: 'POST',
            });
          }
        },
        20,
      );
    });

    await runStep('Shifts lifecycle', async () => {
      const branchId = pick(state.branchIds, random);
      const maybeOpen = await authedRequest<{ id?: string } | null>(
        `/shifts/open?branchId=${branchId}`,
      );
      const shiftId =
        maybeOpen?.id ??
        (
          await authedRequest<RecordWithId>('/shifts/open', {
            method: 'POST',
            body: {
              branchId,
              openingCash: 200_000,
              notes: `Simulation shift ${state.runId}`,
            },
          })
        ).id;
      await authedRequest(`/shifts?branchId=${branchId}&limit=10`);
      await authedRequest(`/shifts/${shiftId}/close`, {
        method: 'POST',
        body: { closingCash: 200_000 },
      });
    });

    await runStep('Offline lifecycle', async () => {
      let deviceId: string | null = null;
      try {
        const device = await authedRequest<RecordWithId>('/offline/register-device', {
          method: 'POST',
          body: { deviceName: `Sim device ${state.runId}`, deviceId: TEST_DEVICE },
        });
        deviceId = device.id;
        await authedRequest(`/offline/status?deviceId=${deviceId}`);
        await authedRequest('/offline/risk');
        const conflicts = await authedRequest<PaginatedResponse<{ id: string }>>(
          `/offline/conflicts?deviceId=${deviceId}&limit=1`,
        );
        const conflictId = conflicts.items?.[0]?.id;
        if (conflictId) {
          await authedRequest('/offline/conflicts/resolve', {
            method: 'POST',
            body: { actionId: conflictId, resolution: 'DISMISS' },
          });
        }
        await authedRequest('/offline/status', {
          method: 'POST',
          body: { deviceId, status: 'ONLINE' },
        });
        try {
          await authedRequest('/offline/sync', {
            method: 'POST',
            body: {
              userId: state.userId,
              deviceId,
              actions: [],
            },
          });
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 403) {
            addWarning('Offline sync skipped because offline mode is not enabled.');
          } else {
            throw error;
          }
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403) {
          addWarning('Offline lifecycle skipped due to permissions/subscription.');
          return;
        }
        throw error;
      } finally {
        if (deviceId) {
          await authedRequest('/offline/revoke-device', {
            method: 'POST',
            body: { deviceId },
          });
        }
      }
    });

    await runStep('Support + subscription + access requests smoke', async () => {
      await optionalAuthedRequest('/support-access/requests?limit=10');
      await optionalAuthedRequest('/subscription');
      await optionalAuthedRequest('/subscription/requests');
      await optionalAuthedRequest('/access-requests', {
        method: 'POST',
        body: {
          permission: 'reports.read',
          path: '/reports',
          reason: `Simulation access request ${state.runId}`,
        },
      });
    });

    await runStep('Approval lifecycle check', async () => {
      await authedRequest('/settings', {
        method: 'PUT',
        body: {
          approvalDefaults: {
            expense: true,
          },
        },
      });

      const branchId = pick(state.branchIds, random);
      await authedRequest('/expenses', {
        method: 'POST',
        body: {
          branchId,
          category: 'GENERAL',
          amount: 25,
          note: `Simulation approval trigger A ${state.runId}`,
        },
      });
      await authedRequest('/expenses', {
        method: 'POST',
        body: {
          branchId,
          category: 'GENERAL',
          amount: 35,
          note: `Simulation approval trigger B ${state.runId}`,
        },
      });

      const approvals = await authedRequest<PaginatedResponse<{ id: string }>>(
        '/approvals?limit=10',
      );
      const first = approvals.items?.[0]?.id;
      const second = approvals.items?.[1]?.id;
      if (first) {
        await authedRequest(`/approvals/${first}/approve`, {
          method: 'POST',
        });
      }
      if (second) {
        await authedRequest(`/approvals/${second}/reject`, {
          method: 'POST',
          body: { reason: `Simulation reject ${state.runId}` },
        });
      }

      await authedRequest('/settings', {
        method: 'PUT',
        body: {
          approvalDefaults: {
            expense: false,
          },
        },
      });
    });

    await runStep('Reports sweep', async () => {
      const reportPaths = [
        '/reports/stock',
        '/reports/sales',
        '/reports/low-stock',
        '/reports/vat',
        '/reports/vat-summary',
        '/reports/pnl',
        '/reports/expiry',
        '/reports/losses/top',
        '/reports/stock-count-variance',
        '/reports/staff',
        '/reports/customers/sales',
        '/reports/customers/refunds',
        '/reports/customers/outstanding',
        '/reports/customers/top',
        '/reports/customers/export',
      ];
      for (const branchId of state.branchIds) {
        for (const route of reportPaths) {
          await authedRequest(`${route}?branchId=${branchId}`);
          state.metrics.reportsCalled += 1;
        }
      }
      await authedRequest('/purchases?limit=20');
      await authedRequest('/purchase-orders?limit=20');
      await authedRequest('/receiving?limit=20');
      await authedRequest('/supplier-returns?limit=20');
      await authedRequest('/transfers?limit=20');
      await authedRequest('/transfers/pending?limit=20');
      await authedRequest('/expenses?limit=20');

      await runBatched(
        'reports.extra',
        PROFILE.reportQueries,
        async () => {
          const branchId = pick(state.branchIds, random);
          const route = pick(reportPaths, random);
          await authedRequest(`${route}?branchId=${branchId}`);
          state.metrics.reportsCalled += 1;
        },
        25,
      );
    });

    await runStep('Export jobs sweep', async () => {
      await runBatched(
        'exports.bulk',
        PROFILE.exportJobs,
        async () => {
          await authedRequest<RecordWithId>('/exports/jobs', {
            method: 'POST',
            body: {
              type: 'STOCK',
              branchId: pick(state.branchIds, random),
            },
          });
          state.metrics.exportJobsCreated += 1;
        },
        10,
      );
      await authedRequest('/exports/jobs?limit=20');
      await authedRequest('/exports/worker/status');
      await optionalAuthedRequest(
        `/exports/stock?branchId=${pick(state.branchIds, random)}`,
      );
    });

    await runStep('Assistant smoke (EN/SW + error context)', async () => {
      const payloads = [
        {
          question: 'Explain this page simply',
          locale: 'en',
          route: '/en/settings/business',
          intent: 'explain_page',
        },
        {
          question: 'can you help with this error',
          locale: 'en',
          route: '/en/settings/business',
          intent: 'troubleshoot_error',
          selected_error_id: `sim-${state.runId}-err-1`,
          recent_errors: [
            {
              id: `sim-${state.runId}-err-1`,
              error_code: 'SMS_WHATSAPP_PHONE_REQUIRED',
              error_message:
                'SMS/WhatsApp requires phone numbers for selected recipients.',
              error_source: 'backend',
              error_time: new Date().toISOString(),
              error_route: '/en/settings/business',
              business_id: state.businessId,
              branch_id: state.branchIds[0] ?? null,
            },
          ],
        },
        {
          question: 'Nisaidie kuelewa kosa hili',
          locale: 'sw',
          route: '/sw/settings/business',
          intent: 'troubleshoot_error',
        },
      ];

      for (const payload of payloads) {
        try {
          const response = await authedRequest<SupportChatResponse>('/support/chat', {
            method: 'POST',
            body: {
              ...payload,
              response_depth: 'standard',
            },
          });
          if (!response.summary && FAIL_FAST) {
            throw new Error('Support chat response missing summary.');
          }
          state.metrics.assistantCalls += 1;
        } catch (error) {
          const message = String((error as Error).message ?? '');
          if (message.includes('Support chat is disabled.')) {
            addWarning('Support chat is disabled in this environment; assistant step skipped.');
            break;
          }
          throw error;
        }
      }
    });

    await runStep('Final verification snapshots', async () => {
      const branchId = state.branchIds[0];
      await authedRequest(`/stock?branchId=${branchId}&limit=20`);
      await authedRequest(`/stock/movements?branchId=${branchId}&limit=20`);
      await authedRequest('/approvals?limit=20');
      await authedRequest('/audit-logs?limit=20');
      const notifications = await authedRequest<PaginatedResponse<{ id: string }>>(
        '/notifications?limit=20',
      );
      const ids = notifications.items?.map((n) => n.id) ?? [];
      if (ids.length) {
        await optionalAuthedRequest(`/notifications/${ids[0]}/read`, {
          method: 'POST',
        });
        await optionalAuthedRequest('/notifications/read-bulk', {
          method: 'POST',
          body: { ids: ids.slice(0, 5) },
        });
        await optionalAuthedRequest('/notifications/archive-bulk', {
          method: 'POST',
          body: { ids: ids.slice(0, 5) },
        });
      }
      await optionalAuthedRequest('/notifications/read-all', { method: 'POST' });
      await optionalAuthedRequest('/notifications/announcement');
      await authedRequest('/search?q=SIM');
    });

    await runStep('Notification actions load', async () => {
      await runBatched(
        'notifications.actions',
        PROFILE.notificationsActions,
        async () => {
          const notifications = await authedRequest<PaginatedResponse<{ id: string }>>(
            '/notifications?limit=20',
          );
          const ids = notifications.items?.map((n) => n.id) ?? [];
          if (!ids.length) {
            return;
          }
          const action = random();
          if (action < 0.34) {
            await optionalAuthedRequest(`/notifications/${ids[0]}/read`, {
              method: 'POST',
            });
          } else if (action < 0.67) {
            await optionalAuthedRequest('/notifications/read-bulk', {
              method: 'POST',
              body: { ids: ids.slice(0, 5) },
            });
          } else {
            await optionalAuthedRequest('/notifications/archive-bulk', {
              method: 'POST',
              body: { ids: ids.slice(0, 5) },
            });
          }
          state.metrics.notificationActions += 1;
        },
        25,
      );
    });

    const targetChecks: Array<{
      label: string;
      actual: number;
      target: number;
    }> = [
      { label: 'branches', actual: state.metrics.createdBranches, target: PROFILE.branches },
      { label: 'roles', actual: state.metrics.createdRoles, target: PROFILE.roles },
      { label: 'users', actual: state.metrics.createdUsers, target: PROFILE.users },
      {
        label: 'categories',
        actual: state.metrics.createdCategories,
        target: PROFILE.categories,
      },
      { label: 'products', actual: state.metrics.createdProducts, target: PROFILE.products },
      { label: 'variants', actual: state.metrics.createdVariants, target: PROFILE.variants },
      { label: 'suppliers', actual: state.metrics.createdSuppliers, target: PROFILE.suppliers },
      { label: 'customers', actual: state.metrics.createdCustomers, target: PROFILE.customers },
      {
        label: 'purchaseOrders',
        actual: state.metrics.purchaseOrders,
        target: PROFILE.purchaseOrders,
      },
      {
        label: 'receivingEvents',
        actual: state.metrics.receivingEvents,
        target: PROFILE.receivingEvents,
      },
      { label: 'transfers', actual: state.metrics.transfers, target: PROFILE.transfers },
      { label: 'salesDrafts', actual: state.metrics.salesDrafts, target: PROFILE.salesDrafts },
      {
        label: 'completedSales',
        actual: state.metrics.salesCompleted,
        target: PROFILE.completedSales,
      },
      {
        label: 'creditSales',
        actual: state.metrics.creditSalesCompleted,
        target: PROFILE.creditSales,
      },
      {
        label: 'settlements',
        actual: state.metrics.settlementsCreated,
        target: PROFILE.settlements,
      },
      { label: 'refunds', actual: state.metrics.refundsRequested, target: PROFILE.refunds },
      { label: 'expenses', actual: state.metrics.expensesCreated, target: PROFILE.expenses },
      { label: 'stockOps', actual: state.metrics.stockAdjustments, target: PROFILE.stockOps },
      { label: 'notes', actual: state.metrics.notesCreated, target: PROFILE.notes },
      {
        label: 'notificationsActions',
        actual: state.metrics.notificationActions,
        target: PROFILE.notificationsActions,
      },
      { label: 'exportJobs', actual: state.metrics.exportJobsCreated, target: PROFILE.exportJobs },
      { label: 'reportQueries', actual: state.metrics.reportsCalled, target: PROFILE.reportQueries },
    ];
    for (const check of targetChecks) {
      if (check.actual < check.target) {
        addWarning(
          `Target not reached for ${check.label}: actual=${check.actual}, target=${check.target}`,
        );
      }
    }

    const assertions = await runSimulationAssertions({
      branchIds: state.branchIds,
      authedRequest,
    });
    const failedAssertions = assertions.filter((item) => !item.passed);
    failedAssertions.forEach((item) =>
      addWarning(`Assertion failed: ${item.name}${item.detail ? ` (${item.detail})` : ''}`),
    );

    const reportPath = writeSimulationReport({
      runId: state.runId,
      profile: PROFILE,
      metrics: state.metrics as unknown as Record<string, unknown>,
      warnings: state.warnings,
      entityCounts: {
        branches: state.branchIds.length,
        categories: state.categoryIds.length,
        products: state.productIds.length,
        variants: state.variantIds.length,
        suppliers: state.supplierIds.length,
        customers: state.customerIds.length,
        sampledCompletedSales: state.completedSaleIds.length,
      },
      requestMetrics,
      stepMetrics,
      assertions,
    });

    console.log('\nSystem simulation completed.');
    console.log(`Profile: ${PROFILE.name}`);
    console.log(`Run ID: ${state.runId}`);
    console.log(`Report: ${reportPath}`);
    console.log('Metrics:', JSON.stringify(state.metrics, null, 2));
    if (state.warnings.length) {
      console.log('\nWarnings:');
      state.warnings.forEach((warning, index) => {
        console.log(`${index + 1}. ${warning}`);
      });
    }
    clearCheckpoint(CHECKPOINT_FILE, CHECKPOINT_ENABLED, KEEP_CHECKPOINT);
  } catch (error) {
    persistCheckpoint();
    console.error('\nSystem simulation failed.');
    console.error((error as Error).message);
    console.error(`Checkpoint saved: ${CHECKPOINT_FILE}`);
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error('Unhandled simulation error:', error);
  process.exit(1);
});
