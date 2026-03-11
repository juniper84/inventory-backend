import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { SupportChatService } from './support-chat.service';
import { SupportChatContextService } from './support-chat-context.service';
import { SupportChatPlaybookService } from './support-chat-playbook.service';

@Controller('support/chat')
@UseGuards(JwtAuthGuard)
export class SupportChatController {
  constructor(
    private readonly supportChatService: SupportChatService,
    private readonly supportChatContextService: SupportChatContextService,
    private readonly supportChatPlaybookService: SupportChatPlaybookService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Permissions(PermissionsList.SUPPORT_CHAT_USE)
  async chat(
    @Req()
    req: {
      user?: {
        sub: string;
        email: string;
        businessId: string;
        roleIds: string[];
        permissions: string[];
        branchScope: string[];
        scope?: 'platform' | 'business' | 'support';
      };
    },
    @Body()
    body: {
      question: string;
      locale?: 'en' | 'sw';
      intent?: 'explain_page' | 'troubleshoot_error' | 'how_to' | 'what_next';
      response_depth?: 'simple' | 'standard' | 'detailed';
      route?: string;
      module?: string;
      branchId?: string;
      topK?: number;
      selected_error_id?: string | null;
      recent_errors?: Array<{
        id?: string | null;
        error_code?: string | null;
        error_message?: string | null;
        error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
        error_time?: string | null;
        error_route?: string | null;
        business_id?: string | null;
        branch_id?: string | null;
      }>;
      latest_error?: {
        id?: string | null;
        error_code?: string | null;
        error_message?: string | null;
        error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
        error_time?: string | null;
        error_route?: string | null;
        business_id?: string | null;
        branch_id?: string | null;
      };
    },
  ) {
    return await this.supportChatService.chat({
      user: req.user as any,
      question: body.question,
      locale: body.locale,
      intent: body.intent,
      response_depth: body.response_depth,
      route: body.route,
      module: body.module,
      branchId: body.branchId,
      topK: body.topK,
      selected_error_id: body.selected_error_id,
      recent_errors: body.recent_errors,
      latest_error: body.latest_error,
    });
  }

  @Get('retrieve')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Permissions(PermissionsList.SUPPORT_CHAT_USE)
  retrieve(
    @Query('q') question = '',
    @Query('locale') locale = 'en',
    @Query('intent')
    intent?: 'explain_page' | 'troubleshoot_error' | 'how_to' | 'what_next',
    @Query('route') route?: string,
    @Query('module') module?: string,
    @Query('errorCode') errorCode?: string,
    @Query('errorMessage') errorMessage?: string,
    @Query('topK') topK?: string,
  ) {
    const parsedTopK = Number(topK ?? 6);
    const safeTopK = Number.isFinite(parsedTopK)
      ? Math.min(Math.max(parsedTopK, 1), 20)
      : 6;

    return this.supportChatService.retrieve({
      question,
      locale: locale === 'sw' ? 'sw' : 'en',
      intent,
      route,
      module,
      error_code: errorCode,
      error_message: errorMessage,
      topK: safeTopK,
    });
  }

  @Post('context')
  @Permissions(PermissionsList.SUPPORT_CHAT_USE)
  async context(
    @Req()
    req: {
      user?: {
        sub: string;
        email: string;
        businessId: string;
        roleIds: string[];
        permissions: string[];
        branchScope: string[];
        scope?: 'platform' | 'business' | 'support';
      };
    },
    @Body()
    body: {
      route?: string;
      locale?: string;
      branchId?: string;
      latest_error?: {
        error_code?: string | null;
        error_message?: string | null;
        error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
        error_time?: string | null;
        error_route?: string | null;
      };
    },
  ) {
    return this.supportChatContextService.buildContext(req.user as any, body);
  }

  @Post('playbook')
  @Permissions(PermissionsList.SUPPORT_CHAT_USE)
  playbook(
    @Body()
    body: {
      locale?: 'en' | 'sw';
      route?: string;
      module?: string;
      error_code?: string | null;
      error_message?: string | null;
    },
  ) {
    const locale = body.locale === 'sw' ? 'sw' : 'en';
    const result = this.supportChatPlaybookService.resolve({
      locale,
      route: body.route,
      module: body.module,
      error_code: body.error_code ?? null,
      error_message: body.error_message ?? null,
    });
    return {
      ok: true,
      locale,
      result,
    };
  }
}
