import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Permissions(PermissionsList.SETTINGS_READ)
  getSettings(@Req() req: { user?: { businessId: string } }) {
    return this.settingsService.getSettings(requireBusinessId(req));
  }

  @Get('history')
  @Permissions(PermissionsList.SETTINGS_READ)
  getSettingsHistory(@Req() req: { user?: { businessId: string } }) {
    return this.settingsService.getSettingsHistory(requireBusinessId(req));
  }

  @Put()
  @Permissions(PermissionsList.SETTINGS_WRITE)
  updateSettings(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      approvalDefaults?: Record<string, unknown>;
      notificationDefaults?: Record<string, unknown>;
      stockPolicies?: Record<string, unknown>;
      posPolicies?: Record<string, unknown>;
      localeSettings?: Record<string, unknown>;
      onboarding?: Record<string, unknown>;
    },
  ) {
    return this.settingsService.updateSettings(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }
}
