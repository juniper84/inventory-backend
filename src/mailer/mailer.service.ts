import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

type MailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private sesClient: SESClient | null = null;
  private readonly provider: string;
  private readonly sesFromAddress: string | null = null;
  private readonly postmarkToken: string | null = null;
  private readonly postmarkFromAddress: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.provider = (
      this.configService.get<string>('mail.provider') || 'ses'
    ).toLowerCase();

    const region = this.configService.get<string>('ses.region');
    const accessKeyId = this.configService.get<string>('ses.accessKeyId');
    const secretAccessKey = this.configService.get<string>(
      'ses.secretAccessKey',
    );
    const sesFrom = this.configService.get<string>('ses.from');
    const postmarkToken =
      this.configService.get<string>('postmark.serverToken') || null;
    const postmarkFrom =
      this.configService.get<string>('postmark.from') || null;

    this.logger.log(
      `Mailer config: provider=${this.provider} sesRegion=${region ?? 'unset'} sesFrom=${sesFrom ?? 'unset'} postmarkFrom=${postmarkFrom ?? 'unset'} postmarkToken=${postmarkToken ? 'set' : 'unset'}`,
    );

    if (region && accessKeyId && secretAccessKey && sesFrom) {
      this.sesClient = new SESClient({
        region,
        credentials: { accessKeyId, secretAccessKey },
      });
      this.sesFromAddress = sesFrom;
    }
    this.postmarkToken = postmarkToken;
    this.postmarkFromAddress = postmarkFrom;
  }

  private async sendWithPostmark(payload: MailPayload) {
    if (!this.postmarkToken || !this.postmarkFromAddress) {
      // Fail loudly — silently skipping means auth emails (resets, invites) are lost (Fix G10-H5)
      throw new Error('Postmark is not configured: missing server token or from address.');
    }
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.postmarkToken,
      },
      body: JSON.stringify({
        From: this.postmarkFromAddress,
        To: payload.to,
        Subject: payload.subject,
        TextBody: payload.text,
        HtmlBody: payload.html,
        MessageStream: 'outbound',
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Postmark send failed: ${response.status} ${body}`);
    }
    return response.json();
  }

  private async sendWithSes(payload: MailPayload) {
    if (!this.sesClient || !this.sesFromAddress) {
      // Fail loudly — silently skipping means auth emails (resets, invites) are lost (Fix G10-H5)
      throw new Error('AWS SES is not configured: missing region, credentials, or from address.');
    }

    const command = new SendEmailCommand({
      Source: this.sesFromAddress,
      Destination: { ToAddresses: [payload.to] },
      Message: {
        Subject: { Data: payload.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: payload.text, Charset: 'UTF-8' },
          ...(payload.html
            ? { Html: { Data: payload.html, Charset: 'UTF-8' } }
            : {}),
        },
      },
    });

    return this.sesClient.send(command);
  }

  async sendEmail(payload: MailPayload) {
    this.logger.log(`Sending email: provider=${this.provider} to=${payload.to}`);

    if (this.provider === 'postmark') {
      try {
        return await this.sendWithPostmark(payload);
      } catch (err) {
        this.logger.warn(
          `Postmark send failed, attempting SES fallback: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        return this.sendWithSes(payload);
      }
    }

    return this.sendWithSes(payload);
  }
}
