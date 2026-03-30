import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

type ManualLocale = 'en' | 'sw';

type LatestErrorInput = {
  error_code?: string | null;
  error_message?: string | null;
  error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
  error_time?: string | null;
  error_route?: string | null;
};

type BuildContextInput = {
  route?: string;
  locale?: string;
  branchId?: string;
  selected_error_id?: string | null;
  latest_error?: LatestErrorInput;
};

type JwtUser = {
  sub: string;
  email: string;
  businessId: string;
  roleIds: string[];
  permissions: string[];
  branchScope: string[];
  scope?: 'platform' | 'business' | 'support';
};

type RouteModuleRecord = {
  route: string;
  module: string;
};

@Injectable()
export class SupportChatContextService {
  constructor(private readonly prisma: PrismaService) {}

  private routeModuleCache:
    | {
        map: Map<string, string>;
      }
    | null = null;

  async buildContext(user: JwtUser, input: BuildContextInput) {
    const locale = this.resolveLocale(input.locale, input.route);
    const route = this.normalizeRoute(input.route, locale);
    const module = this.resolveModuleByRoute(route);

    const branchScope = user.branchScope ?? [];
    const activeBranchId = this.resolveBranchId(input.branchId, branchScope);

    const readiness = await this.computeReadinessSignals({
      businessId: user.businessId,
      route,
      module,
      activeBranchId,
      branchScope,
    });

    return {
      route,
      locale,
      module,
      user: {
        id: user.sub,
        scope: user.scope ?? 'business',
        permission_codes: user.permissions ?? [],
      },
      scope: {
        business_id: user.businessId,
        branch_scope: branchScope,
        active_branch_id: activeBranchId,
      },
      readiness_signals: readiness,
      latest_error: {
        error_code: input.latest_error?.error_code ?? null,
        error_message: input.latest_error?.error_message ?? null,
        error_source: input.latest_error?.error_source ?? 'unknown',
        error_time: input.latest_error?.error_time ?? null,
        error_route: input.latest_error?.error_route
          ? this.normalizeRoute(input.latest_error.error_route, locale)
          : null,
      },
      selected_error_id: input.selected_error_id ?? null,
      generated_at: new Date().toISOString(),
    };
  }

  private resolveLocale(rawLocale?: string, rawRoute?: string): ManualLocale {
    if (rawLocale === 'sw') {
      return 'sw';
    }
    if (rawLocale === 'en') {
      return 'en';
    }
    if (rawRoute?.startsWith('/sw')) {
      return 'sw';
    }
    return 'en';
  }

  private normalizeRoute(route: string | undefined, locale: ManualLocale) {
    if (!route) {
      return '/{locale}';
    }
    const clean = route.split('?')[0].split('#')[0].trim();
    if (!clean) {
      return '/{locale}';
    }
    return clean.replace(/^\/(en|sw)(?=\/|$)/, '/{locale}') || '/{locale}';
  }

  private resolveBranchId(inputBranchId: string | undefined, branchScope: string[]) {
    if (inputBranchId && branchScope.includes(inputBranchId)) {
      return inputBranchId;
    }
    if (branchScope.length === 1) {
      return branchScope[0];
    }
    return null;
  }

  private resolveModuleByRoute(route: string) {
    const map = this.getRouteModuleMap();
    return map.get(route) ?? 'unknown';
  }

  private getRouteModuleMap() {
    if (this.routeModuleCache) {
      return this.routeModuleCache.map;
    }

    const manifestPath = this.resolveFilePath(
      'frontend/docs/manual/manual.freeze.m09.manifest.json',
    );
    const map = new Map<string, string>();
    if (manifestPath && fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        entries?: RouteModuleRecord[];
      };
      for (const entry of manifest.entries ?? []) {
        map.set(entry.route, entry.module);
      }
    }
    this.routeModuleCache = { map };
    return map;
  }

  private async computeReadinessSignals(input: {
    businessId: string;
    route: string;
    module: string;
    activeBranchId: string | null;
    branchScope: string[];
  }) {
    const shouldIncludeCatalogSignals =
      input.module === 'catalog' ||
      input.route.includes('/catalog') ||
      input.route.includes('/price-lists') ||
      input.route.includes('/pos');
    const shouldIncludeSupplierSignals =
      input.module === 'purchases-suppliers' ||
      input.route.includes('/suppliers') ||
      input.route.includes('/purchase-orders') ||
      input.route.includes('/purchases') ||
      input.route.includes('/receiving');
    const shouldIncludeShiftSignals =
      input.route.includes('/pos') || input.route.includes('/shifts');
    const shouldIncludePriceListSignals =
      input.route.includes('/price-lists') || input.route.includes('/pos');

    const [
      categoriesCount,
      productsCount,
      variantsCount,
      suppliersCount,
      openShiftCount,
      priceListsCount,
    ] = await Promise.all([
      shouldIncludeCatalogSignals
        ? this.prisma.category.count({ where: { businessId: input.businessId } })
        : Promise.resolve(0),
      shouldIncludeCatalogSignals
        ? this.prisma.product.count({ where: { businessId: input.businessId } })
        : Promise.resolve(0),
      shouldIncludeCatalogSignals
        ? this.prisma.variant.count({ where: { businessId: input.businessId } })
        : Promise.resolve(0),
      shouldIncludeSupplierSignals
        ? this.prisma.supplier.count({ where: { businessId: input.businessId } })
        : Promise.resolve(0),
      shouldIncludeShiftSignals && input.activeBranchId
        ? this.prisma.shift.count({
            where: {
              businessId: input.businessId,
              branchId: input.activeBranchId,
              status: 'OPEN',
            },
          })
        : Promise.resolve(0),
      shouldIncludePriceListSignals
        ? this.prisma.priceList.count({ where: { businessId: input.businessId } })
        : Promise.resolve(0),
    ]);

    return {
      categories_count: categoriesCount,
      products_count: productsCount,
      variants_count: variantsCount,
      suppliers_count: suppliersCount,
      open_shifts_count: openShiftCount,
      has_catalog_foundation:
        categoriesCount > 0 && productsCount > 0 && variantsCount > 0,
      has_suppliers: suppliersCount > 0,
      has_open_shift_in_active_branch:
        input.activeBranchId !== null ? openShiftCount > 0 : null,
      has_active_branch: input.activeBranchId !== null,
      has_price_lists: priceListsCount > 0,
      branch_scope_size: input.branchScope.length,
    };
  }

  private resolveFilePath(relativeOrAbsolute: string) {
    if (path.isAbsolute(relativeOrAbsolute)) {
      return relativeOrAbsolute;
    }
    const local = path.resolve(process.cwd(), relativeOrAbsolute);
    if (fs.existsSync(local)) {
      return local;
    }
    return path.resolve(process.cwd(), '..', relativeOrAbsolute);
  }
}
