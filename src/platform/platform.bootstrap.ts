import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class PlatformBootstrap implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    const email = this.configService.get<string>('platform.adminEmail');
    const password = this.configService.get<string>('platform.adminPassword');

    if (email && password) {
      await this.authService.createPlatformAdmin(email, password);
    }
  }
}
