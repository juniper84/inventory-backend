import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

type MailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

@Injectable()
export class MailerService {
  private transporter: Transporter | null = null;
  private fromAddress: string | null = null;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('smtp.host');
    const port = this.configService.get<number>('smtp.port');
    const user = this.configService.get<string>('smtp.user');
    const pass = this.configService.get<string>('smtp.pass');
    const secure = this.configService.get<boolean>('smtp.secure');
    const from = this.configService.get<string>('smtp.from');

    if (host && port && user && pass && from) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: Boolean(secure),
        auth: { user, pass },
      });
      this.fromAddress = from;
    }
  }

  async sendEmail(payload: MailPayload) {
    if (!this.transporter || !this.fromAddress) {
      return { skipped: true };
    }

    return this.transporter.sendMail({
      from: this.fromAddress,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  }
}
