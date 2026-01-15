import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SmsService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.normalizeBaseUrl(
      this.configService.get<string>('infobip.baseUrl') || '',
    );
    this.apiKey = this.configService.get<string>('infobip.apiKey') || '';
    this.from = this.configService.get<string>('infobip.smsFrom') || '';
    this.enabled = Boolean(this.baseUrl && this.apiKey && this.from);
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

  private normalizeBaseUrl(url: string) {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      return '';
    }
    return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  }

  async sendMessage(params: { to: string; body: string }) {
    if (!this.enabled) {
      return { skipped: true };
    }
    const to = this.normalizeTo(params.to);
    if (!to) {
      return { skipped: true };
    }
    const url = `${this.baseUrl}/sms/2/text/advanced`;
    const payload = {
      messages: [
        {
          destinations: [{ to }],
          from: this.from,
          text: params.body,
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `App ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Infobip SMS send failed: ${response.status} ${text}`);
    }

    return response.json();
  }
}
