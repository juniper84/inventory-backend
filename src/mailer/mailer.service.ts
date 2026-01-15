import { Injectable } from '@nestjs/common';
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
  private sesClient: SESClient | null = null;
  private fromAddress: string | null = null;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('ses.region');
    const accessKeyId = this.configService.get<string>('ses.accessKeyId');
    const secretAccessKey = this.configService.get<string>('ses.secretAccessKey');
    const from = this.configService.get<string>('ses.from');

    if (region && accessKeyId && secretAccessKey && from) {
      this.sesClient = new SESClient({
        region,
        credentials: { accessKeyId, secretAccessKey },
      });
      this.fromAddress = from;
    }
  }

  async sendEmail(payload: MailPayload) {
    if (!this.sesClient || !this.fromAddress) {
      return { skipped: true };
    }

    const command = new SendEmailCommand({
      Source: this.fromAddress,
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
}
