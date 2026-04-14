import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateMarketingLeadDto } from './marketing.dto';

@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  async createLead(
    dto: CreateMarketingLeadDto,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    // Honeypot: pretend success if the bot field is populated.
    if (dto.website && dto.website.trim().length > 0) {
      this.logger.warn(
        `Honeypot triggered on marketing lead from ${meta.ipAddress ?? 'unknown'}`,
      );
      return { ok: true };
    }

    const lead = await this.prisma.marketingLead.create({
      data: {
        name: dto.name.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone?.trim() || null,
        businessName: dto.businessName?.trim() || null,
        message: dto.message.trim(),
        locale: dto.locale ?? 'en',
        source: 'website-contact',
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
    });

    const notifyTo = this.config.get<string>('MARKETING_LEAD_NOTIFY_EMAIL');
    if (notifyTo) {
      try {
        await this.mailer.sendEmail({
          to: notifyTo,
          subject: `New lead: ${lead.name} (${lead.email})`,
          text: this.renderLeadText(lead),
          html: this.renderLeadHtml(lead),
        });
      } catch (err) {
        this.logger.warn(
          `Failed to send lead notification email: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
    } else {
      this.logger.warn(
        'MARKETING_LEAD_NOTIFY_EMAIL not configured — lead saved but no email sent.',
      );
    }

    return { ok: true };
  }

  private renderLeadText(lead: {
    name: string;
    email: string;
    phone: string | null;
    businessName: string | null;
    message: string;
    locale: string;
  }) {
    return [
      'New marketing lead',
      '',
      `Name: ${lead.name}`,
      `Email: ${lead.email}`,
      `Phone: ${lead.phone ?? '—'}`,
      `Business: ${lead.businessName ?? '—'}`,
      `Locale: ${lead.locale}`,
      '',
      'Message:',
      lead.message,
    ].join('\n');
  }

  private renderLeadHtml(lead: {
    name: string;
    email: string;
    phone: string | null;
    businessName: string | null;
    message: string;
    locale: string;
  }) {
    const escape = (s: string | null) =>
      (s ?? '—')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `
      <div style="font-family:system-ui,sans-serif;max-width:600px;padding:20px;">
        <h2 style="color:#d7b05b;margin:0 0 16px;">New marketing lead</h2>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:4px 8px;color:#666;">Name</td><td>${escape(lead.name)}</td></tr>
          <tr><td style="padding:4px 8px;color:#666;">Email</td><td><a href="mailto:${escape(lead.email)}">${escape(lead.email)}</a></td></tr>
          <tr><td style="padding:4px 8px;color:#666;">Phone</td><td>${escape(lead.phone)}</td></tr>
          <tr><td style="padding:4px 8px;color:#666;">Business</td><td>${escape(lead.businessName)}</td></tr>
          <tr><td style="padding:4px 8px;color:#666;">Locale</td><td>${escape(lead.locale)}</td></tr>
        </table>
        <hr style="margin:20px 0;border:none;border-top:1px solid #eee;" />
        <h3 style="margin:0 0 8px;">Message</h3>
        <p style="white-space:pre-wrap;margin:0;">${escape(lead.message)}</p>
      </div>
    `.trim();
  }
}
