import { Injectable } from '@nestjs/common';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';

type RateLimitOverride = {
  limit?: number | null;
  ttlSeconds?: number | null;
  expiresAt?: string | null;
};

@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  private readonly overrideCache = new Map<
    string,
    { value: RateLimitOverride | null; fetchedAt: number }
  >();

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    super(options, storageService, reflector);
  }

  private async loadOverride(businessId: string) {
    const cached = this.overrideCache.get(businessId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < 60_000) {
      return cached.value;
    }
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
      select: { rateLimitOverride: true },
    });
    const override = settings?.rateLimitOverride as RateLimitOverride | null;
    this.overrideCache.set(businessId, {
      value: override ?? null,
      fetchedAt: now,
    });
    return override ?? null;
  }

  private isOverrideActive(override: RateLimitOverride | null) {
    if (!override) {
      return false;
    }
    if (override.expiresAt) {
      const expiresAt = Date.parse(override.expiresAt);
      if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
        return false;
      }
    }
    return true;
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { context } = requestProps;
    const { req } = this.getRequestResponse(context);
    const businessId = req?.user?.businessId;
    if (!businessId) {
      return super.handleRequest(requestProps);
    }
    const override = await this.loadOverride(businessId);
    if (!this.isOverrideActive(override)) {
      return super.handleRequest(requestProps);
    }
    const limit =
      override?.limit != null
        ? Math.max(override.limit, 1)
        : requestProps.limit;
    const ttl =
      override?.ttlSeconds != null
        ? Math.max(override.ttlSeconds, 1)
        : requestProps.ttl;
    return super.handleRequest({
      ...requestProps,
      limit,
      ttl,
      blockDuration: ttl,
    });
  }
}
