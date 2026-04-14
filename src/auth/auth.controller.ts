import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { UsersService } from '../users/users.service';
import { SubscriptionTier } from '@prisma/client';
import { validatePassword } from './password';
import { buildRequestMetadata } from '../audit/audit.utils';
import { requireUserId } from '../common/request-context';
import { SubscriptionBypass } from '../subscription/subscription.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Req()
    req: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      email: string;
      password: string;
      businessId?: string;
      deviceId?: string;
    },
  ) {
    return this.authService.signIn(body, buildRequestMetadata(req));
  }

  @Post('refresh')
  @Public()
  async refresh(
    @Req()
    req: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      refreshToken: string;
      businessId: string;
      deviceId?: string;
    },
  ) {
    return this.authService.refreshToken(
      body.refreshToken,
      body.businessId,
      body.deviceId,
      buildRequestMetadata(req),
    );
  }

  @Post('logout')
  @SubscriptionBypass()
  async logout(
    @Req()
    req: {
      user?: { sub?: string; businessId?: string; email?: string };
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body() body: { refreshToken: string },
  ) {
    if (!req.user?.sub) {
      return;
    }
    return this.authService.logout(
      req.user.sub,
      body.refreshToken,
      req.user.businessId,
      buildRequestMetadata(req),
    );
  }

  @Post('password-reset/request')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async requestReset(@Body() body: { email: string; businessId?: string }) {
    return this.authService.requestPasswordResetByEmail(
      body.email,
      body.businessId,
    );
  }

  @Post('password-reset/confirm')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async confirmReset(
    @Body() body: { token: string; password: string },
  ) {
    return this.authService.resetPassword(
      body.token,
      body.password,
    );
  }

  @Post('signup')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async signup(
    @Body()
    body: {
      businessName: string;
      ownerName: string;
      email: string;
      password: string;
      tier?: SubscriptionTier;
    },
  ) {
    if (
      !body.businessName?.trim() ||
      !body.ownerName?.trim() ||
      !body.email?.trim() ||
      !body.password
    ) {
      throw new BadRequestException('Missing required signup fields.');
    }
    if (!validatePassword(body.password)) {
      throw new BadRequestException('Password does not meet requirements.');
    }

    return await this.authService.signup({
      businessName: body.businessName,
      ownerName: body.ownerName,
      email: body.email,
      password: body.password,
      tier: body.tier,
    });
  }

  @Post('change-password')
  @SubscriptionBypass()
  async changePassword(
    @Req() req: { user?: { sub?: string } },
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    await this.authService.changePassword(
      requireUserId(req),
      body.currentPassword,
      body.newPassword,
    );
    return { ok: true };
  }

  @Post('switch-business')
  @SubscriptionBypass()
  async switchBusiness(
    @Req()
    req: {
      user?: { email?: string; sub?: string };
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      businessId: string;
      password?: string;
      deviceId?: string;
      refreshToken?: string;
    },
  ) {
    if (body.password) {
      return this.authService.switchBusiness({
        email: req.user?.email || '',
        password: body.password,
        businessId: body.businessId,
        deviceId: body.deviceId,
        metadata: buildRequestMetadata(req),
      });
    }

    return this.authService.switchBusinessForUser({
      userId: requireUserId(req),
      businessId: body.businessId,
      deviceId: body.deviceId,
      refreshToken: body.refreshToken,
      metadata: buildRequestMetadata(req),
    });
  }

  @Get('businesses')
  async listBusinesses(@Req() req: { user?: { sub?: string } }) {
    return this.authService.listUserBusinesses(requireUserId(req));
  }

  @Post('invite/info')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async inviteInfo(@Body() body: { token: string }) {
    return this.usersService.getInviteInfo(body.token);
  }

  @Post('invite/accept')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async acceptInvite(
    @Body() body: { token: string; name: string; password: string },
  ) {
    return this.usersService.acceptInvite(body);
  }

  @Post('email-verification/request')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async requestEmailVerification(
    @Body() body: { email: string; businessId?: string },
  ) {
    return this.authService.requestEmailVerificationByEmail(
      body.email,
      body.businessId ?? '',
    );
  }

  @Post('email-verification/confirm')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async confirmEmailVerification(
    @Body() body: { token: string; deviceId?: string; businessId?: string },
  ) {
    return this.authService.confirmEmailVerification(
      body.token,
      body.deviceId,
      body.businessId,
    );
  }
}
