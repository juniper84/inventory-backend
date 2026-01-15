import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import en from './messages/en.json';
import sw from './messages/sw.json';

type Locale = 'en' | 'sw';
type Messages = typeof en;

const MESSAGES: Record<Locale, Messages> = { en, sw };
const DEFAULT_LOCALE: Locale = 'en';

@Injectable()
export class I18nService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveLocale(businessId?: string | null): Promise<Locale> {
    if (!businessId) {
      return DEFAULT_LOCALE;
    }
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { defaultLanguage: true },
    });
    const locale = (business?.defaultLanguage ?? DEFAULT_LOCALE) as Locale;
    return locale in MESSAGES ? locale : DEFAULT_LOCALE;
  }

  t(locale: Locale, key: string, params?: Record<string, string | number>) {
    const selected = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
    const message =
      key.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object' && part in acc) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, selected) ??
      key.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object' && part in acc) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, MESSAGES[DEFAULT_LOCALE]);

    if (typeof message !== 'string') {
      return key;
    }
    if (!params) {
      return message;
    }
    return message.replace(/\{(\w+)\}/g, (match, param) => {
      const value = params[param];
      return value === undefined || value === null ? match : String(value);
    });
  }
}
