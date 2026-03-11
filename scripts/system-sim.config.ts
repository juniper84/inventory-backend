export type SimulationProfileName = 'SMALL' | 'MEDIUM' | 'LARGE' | 'XL';

export type SimulationProfile = {
  name: SimulationProfileName;
  branches: number;
  users: number;
  roles: number;
  categories: number;
  products: number;
  variants: number;
  suppliers: number;
  customers: number;
  purchaseOrders: number;
  receivingEvents: number;
  transfers: number;
  salesDrafts: number;
  completedSales: number;
  creditSales: number;
  settlements: number;
  refunds: number;
  expenses: number;
  stockOps: number;
  notes: number;
  notificationsActions: number;
  exportJobs: number;
  reportQueries: number;
};

const SMALL: SimulationProfile = {
  name: 'SMALL',
  branches: 2,
  users: 5,
  roles: 3,
  categories: 8,
  products: 30,
  variants: 60,
  suppliers: 20,
  customers: 80,
  purchaseOrders: 40,
  receivingEvents: 45,
  transfers: 50,
  salesDrafts: 30,
  completedSales: 220,
  creditSales: 20,
  settlements: 25,
  refunds: 14,
  expenses: 90,
  stockOps: 120,
  notes: 30,
  notificationsActions: 80,
  exportJobs: 8,
  reportQueries: 90,
};

const MEDIUM: SimulationProfile = {
  name: 'MEDIUM',
  branches: 4,
  users: 15,
  roles: 5,
  categories: 20,
  products: 140,
  variants: 360,
  suppliers: 70,
  customers: 600,
  purchaseOrders: 260,
  receivingEvents: 320,
  transfers: 500,
  salesDrafts: 350,
  completedSales: 3200,
  creditSales: 320,
  settlements: 420,
  refunds: 210,
  expenses: 1200,
  stockOps: 900,
  notes: 220,
  notificationsActions: 800,
  exportJobs: 20,
  reportQueries: 220,
};

const LARGE: SimulationProfile = {
  name: 'LARGE',
  branches: 6,
  users: 30,
  roles: 8,
  categories: 40,
  products: 500,
  variants: 1500,
  suppliers: 120,
  customers: 2000,
  purchaseOrders: 1000,
  receivingEvents: 1200,
  transfers: 2500,
  salesDrafts: 3000,
  completedSales: 20000,
  creditSales: 2000,
  settlements: 3000,
  refunds: 1200,
  expenses: 8000,
  stockOps: 2500,
  notes: 3000,
  notificationsActions: 5000,
  exportJobs: 80,
  reportQueries: 500,
};

const XL: SimulationProfile = {
  name: 'XL',
  branches: 8,
  users: 50,
  roles: 12,
  categories: 60,
  products: 800,
  variants: 2400,
  suppliers: 220,
  customers: 3500,
  purchaseOrders: 1800,
  receivingEvents: 2400,
  transfers: 4500,
  salesDrafts: 6000,
  completedSales: 35000,
  creditSales: 3500,
  settlements: 5200,
  refunds: 2200,
  expenses: 12000,
  stockOps: 5000,
  notes: 5000,
  notificationsActions: 9000,
  exportJobs: 120,
  reportQueries: 900,
};

export const PROFILES: Record<SimulationProfileName, SimulationProfile> = {
  SMALL,
  MEDIUM,
  LARGE,
  XL,
};

export const resolveSimulationProfile = (
  raw: string | undefined,
): SimulationProfile => {
  const key = (raw ?? 'MEDIUM').toUpperCase() as SimulationProfileName;
  return PROFILES[key] ?? PROFILES.MEDIUM;
};
