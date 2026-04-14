import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { NotesService } from './notes.service';
import { AuditService } from '../audit/audit.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller()
export class NotesController {
  constructor(
    private readonly notesService: NotesService,
    private readonly auditService: AuditService,
  ) {}

  @Get('notes')
  @Permissions(PermissionsList.NOTES_READ)
  list(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: string;
      search?: string;
      tag?: string;
      visibility?: string;
      branchId?: string;
      resourceType?: string;
      resourceId?: string;
      includeTotal?: string;
    },
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.listNotes(
      requireBusinessId(req),
      {
        userId: requireUserId(req),
        canManage: permissions.has(PermissionsList.NOTES_MANAGE),
        branchScope: req.user?.branchScope ?? [],
      },
      query,
    );
  }

  @Get('notes/linkables')
  @Permissions(PermissionsList.NOTES_READ)
  linkables(
    @Req()
    req: { user?: { businessId: string; branchScope?: string[] } },
    @Query('type') type?: string,
    @Query('query') query?: string,
  ) {
    return this.notesService.listLinkables(
      requireBusinessId(req),
      type ?? '',
      query ?? '',
      req.user?.branchScope ?? [],
    );
  }

  @Get('notes/meta')
  @Permissions(PermissionsList.NOTES_READ)
  meta(@Req() req: { user?: { businessId: string } }) {
    return this.notesService.getMeta(requireBusinessId(req));
  }

  @Get('notes/reminders/overview')
  @Permissions(PermissionsList.NOTES_READ)
  reminderOverview(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Query() query: { limit?: string; windowDays?: string },
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.listReminderOverview(
      requireBusinessId(req),
      {
        userId: requireUserId(req),
        canManage: permissions.has(PermissionsList.NOTES_MANAGE),
        branchScope: req.user?.branchScope ?? [],
      },
      query,
    );
  }

  // ── Note Templates (must be before /:id) ────────────────────

  @Get('notes/templates')
  @Permissions(PermissionsList.NOTES_READ)
  listTemplates(@Req() req: { user?: { businessId: string } }) {
    return this.notesService.listTemplates(requireBusinessId(req));
  }

  @Post('notes/templates')
  @Permissions(PermissionsList.NOTES_WRITE)
  createTemplate(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name: string;
      title: string;
      body?: string;
      visibility?: string;
      tags?: string[];
    },
  ) {
    return this.notesService.createTemplate(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Delete('notes/templates/:id')
  @Permissions(PermissionsList.NOTES_WRITE)
  deleteTemplate(
    @Req() req: { user?: { businessId: string } },
    @Param('id') id: string,
  ) {
    return this.notesService.deleteTemplate(requireBusinessId(req), id);
  }

  // ── Note Sharing ───────────────────────────────────────────────

  @Get('notes/:id/shares')
  @Permissions(PermissionsList.NOTES_READ)
  listShares(
    @Req() req: { user?: { businessId: string } },
    @Param('id') id: string,
  ) {
    return this.notesService.listNoteShares(requireBusinessId(req), id);
  }

  @Post('notes/:id/shares')
  @Permissions(PermissionsList.NOTES_WRITE)
  async shareNote(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body() body: { userId: string },
  ) {
    const businessId = requireBusinessId(req);
    const userId = requireUserId(req);
    const result = await this.notesService.shareNote(businessId, id, userId, body.userId);
    if (result) {
      await this.auditService.logEvent({
        businessId,
        userId,
        action: 'NOTE_SHARE',
        resourceType: 'Note',
        resourceId: id,
        outcome: 'SUCCESS',
        metadata: { targetUserId: body.userId },
      });
    }
    return result;
  }

  @Delete('notes/:id/shares/:userId')
  @Permissions(PermissionsList.NOTES_WRITE)
  async unshareNote(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    const businessId = requireBusinessId(req);
    const userId = requireUserId(req);
    const result = await this.notesService.unshareNote(businessId, id, targetUserId);
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_UNSHARE',
      resourceType: 'Note',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { targetUserId },
    });
    return result;
  }

  // ── Single Note ────────────────────────────────────────────────

  @Get('notes/:id')
  @Permissions(PermissionsList.NOTES_READ)
  getNote(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Param('id') id: string,
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.getNote(requireBusinessId(req), id, {
      userId: requireUserId(req),
      canManage: permissions.has(PermissionsList.NOTES_MANAGE),
      branchScope: req.user?.branchScope ?? [],
    });
  }

  @Post('notes')
  @Permissions(PermissionsList.NOTES_WRITE)
  createNote(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Body()
    body: {
      title: string;
      body: string;
      visibility?: 'PRIVATE' | 'BRANCH' | 'BUSINESS';
      branchId?: string | null;
      tags?: string[];
      links?: { resourceType: string; resourceId: string }[];
    },
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.createNote(
      requireBusinessId(req),
      requireUserId(req),
      body,
      {
        userId: requireUserId(req),
        canManage: permissions.has(PermissionsList.NOTES_MANAGE),
        branchScope: req.user?.branchScope ?? [],
      },
    );
  }

  @Put('notes/:id')
  @Permissions(PermissionsList.NOTES_WRITE)
  updateNote(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      body?: string;
      visibility?: 'PRIVATE' | 'BRANCH' | 'BUSINESS';
      branchId?: string | null;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
      isPinned?: boolean;
      tags?: string[];
      links?: { resourceType: string; resourceId: string }[];
    },
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.updateNote(
      requireBusinessId(req),
      requireUserId(req),
      id,
      body,
      {
        userId: requireUserId(req),
        canManage: permissions.has(PermissionsList.NOTES_MANAGE),
        branchScope: req.user?.branchScope ?? [],
      },
    );
  }

  @Post('notes/:id/archive')
  @Permissions(PermissionsList.NOTES_WRITE)
  archive(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Param('id') id: string,
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.archiveNote(
      requireBusinessId(req),
      requireUserId(req),
      id,
      {
        userId: requireUserId(req),
        canManage: permissions.has(PermissionsList.NOTES_MANAGE),
        branchScope: req.user?.branchScope ?? [],
      },
    );
  }

  @Get('notes/:id/reminders')
  @Permissions(PermissionsList.NOTES_READ)
  reminders(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        permissions?: string[];
        branchScope?: string[];
      };
    },
    @Param('id') id: string,
  ) {
    const permissions = new Set(req.user?.permissions ?? []);
    return this.notesService.listReminders(requireBusinessId(req), id, {
      userId: requireUserId(req),
      canManage: permissions.has(PermissionsList.NOTES_MANAGE),
      branchScope: req.user?.branchScope ?? [],
    });
  }

  @Post('notes/:id/reminders')
  @Permissions(PermissionsList.NOTES_WRITE)
  createReminders(
    @Req()
    req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      scheduledAt: string;
      channels: Array<'IN_APP' | 'EMAIL' | 'WHATSAPP'>;
      recipientId?: string;
      branchId?: string;
    },
  ) {
    return this.notesService.createReminders(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body,
    );
  }

  @Post('notes/reminders/:id/cancel')
  @Permissions(PermissionsList.NOTES_WRITE)
  cancelReminder(
    @Req()
    req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
  ) {
    return this.notesService.cancelReminder(
      requireBusinessId(req),
      id,
      requireUserId(req),
    );
  }
}
