import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { NotesService } from './notes.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller()
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

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
