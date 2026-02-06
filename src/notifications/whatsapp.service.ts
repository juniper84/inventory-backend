import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsAppService {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.accountSid = this.configService.get<string>('twilio.accountSid') || '';
    this.authToken = this.configService.get<string>('twilio.authToken') || '';
    this.from = this.normalizeFrom(
      this.configService.get<string>('twilio.whatsappFrom') || '',
    );
    this.enabled = Boolean(this.accountSid && this.authToken && this.from);
  }

  isEnabled() {
    return this.enabled;
  }

  private normalizeTo(to: string) {
    const trimmed = to.trim();
    if (!trimmed) {
      return '';
    }
    return trimmed;
  }

  private normalizeFrom(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    return trimmed.startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`;
  }

  private async sendPayload(payload: URLSearchParams) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.accountSid}:${this.authToken}`,
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: payload.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Twilio WhatsApp send failed: ${response.status} ${text}`,
      );
    }

    return response.json();
  }

  async sendMessage(params: { to: string; body: string }) {
    if (!this.enabled) {
      return { skipped: true };
    }
    const to = this.normalizeTo(params.to);
    if (!to) {
      return { skipped: true };
    }
    const normalizedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const payload = new URLSearchParams({
      From: this.from,
      To: normalizedTo,
      Body: params.body,
    });

    return this.sendPayload(payload);
  }

  async sendTemplate(params: {
    to: string;
    contentSid: string;
    variables?: Record<string, string>;
  }) {
    if (!this.enabled) {
      return { skipped: true };
    }
    const to = this.normalizeTo(params.to);
    if (!to) {
      return { skipped: true };
    }
    const normalizedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const payload = new URLSearchParams({
      From: this.from,
      To: normalizedTo,
      ContentSid: params.contentSid,
    });
    if (params.variables && Object.keys(params.variables).length) {
      payload.set('ContentVariables', JSON.stringify(params.variables));
    }
    return this.sendPayload(payload);
  }
}
