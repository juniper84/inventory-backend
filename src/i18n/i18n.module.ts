import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from './i18n.service';

@Module({
  providers: [I18nService, PrismaService],
  exports: [I18nService],
})
export class I18nModule {}
