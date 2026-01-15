import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditService } from './audit.service';
import { AuditContextStore } from './audit-context';
import { AuditController } from './audit.controller';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuditController],
  providers: [AuditService, AuditContextStore],
  exports: [AuditService, AuditContextStore],
})
export class AuditModule {}
