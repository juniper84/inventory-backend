import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { UsersService } from '../users/users.service';
import { BusinessService } from '../business/business.service';
import { SubscriptionTier } from '@prisma/client';
import { validatePassword } from './password';
import { buildRequestMetadata } from '../audit/audit.utils';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly businessService: BusinessService,
  ) {}

  @Post('login')
  @Public()
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
      userId: string;
      refreshToken: string;
      businessId: string;
      deviceId?: string;
    },
  ) {
    return this.authService.refreshToken(
      body.userId,
      body.refreshToken,
      body.businessId,
      body.deviceId,
      buildRequestMetadata(req),
    );
  }

  @Post('logout')
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
  async requestReset(
    @Body() body: { email: string; businessId?: string },
  ) {
    return this.authService.requestPasswordResetByEmail(
      body.email,
      body.businessId,
    );
  }

  @Post('password-reset/confirm')
  @Public()
  async confirmReset(
    @Body() body: { userId?: string; token: string; password: string },
  ) {
    return this.authService.resetPassword(
      body.token,
      body.password,
      body.userId,
    );
  }

  @Post('signup')
  @Public()
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
    const { business, roles } = await this.businessService.createBusiness({
      name: body.businessName,
      tier: body.tier,
    });

    const owner = await this.usersService.create(business.id, {
      name: body.ownerName,
      email: body.email,
      status: 'PENDING',
      tempPassword: body.password,
      mustResetPassword: false,
    });

    const systemOwnerRoleId = roles['System Owner'];
    if (systemOwnerRoleId) {
      await this.usersService.assignRole(owner.id, systemOwnerRoleId);
    }

    const verification = await this.authService.requestEmailVerification(
      owner.id,
      business.id,
    );

    return {
      verificationRequired: true,
      userId: owner.id,
      businessId: business.id,
      verificationToken: verification?.token,
    };
  }

  @Post('switch-business')
  async switchBusiness(
    @Req()
    req: {
      user?: { email?: string; sub?: string };
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body() body: { businessId: string; password?: string; deviceId?: string },
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
      userId: req.user?.sub || '',
      businessId: body.businessId,
      deviceId: body.deviceId,
      metadata: buildRequestMetadata(req),
    });
  }

  @Get('businesses')
  async listBusinesses(@Req() req: { user?: { sub?: string } }) {
    return this.authService.listUserBusinesses(req.user?.sub || '');
  }

  @Post('invite/accept')
  @Public()
  async acceptInvite(
    @Body() body: { token: string; name: string; password: string },
  ) {
    return this.usersService.acceptInvite(body);
  }

  @Post('email-verification/request')
  @Public()
  async requestEmailVerification(
    @Body() body: { email: string; businessId: string },
  ) {
    return this.authService.requestEmailVerificationByEmail(
      body.email,
      body.businessId,
    );
  }

  @Post('email-verification/confirm')
  @Public()
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
