import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class PlatformBootstrap implements OnModuleInit {
  private readonly logger = new Logger(PlatformBootstrap.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    const email = this.configService.get<string>('platform.adminEmail');
    const password = this.configService.get<string>('platform.adminPassword');

    if (email && password) {
      await this.authService.createPlatformAdmin(email, password);
    } else {
      // P4-SW1-L2: PLATFORM_ADMIN_EMAIL and/or PLATFORM_ADMIN_PASSWORD are not set.
      // Platform admin bootstrapping is skipped. Set these env vars to auto-provision
      // the first admin on startup. Without them, the platform admin must be created manually.
      this.logger.warn(
        'PLATFORM_ADMIN_EMAIL or PLATFORM_ADMIN_PASSWORD not set — ' +
          'platform admin auto-provisioning skipped.',
      );
    }
  }
}
