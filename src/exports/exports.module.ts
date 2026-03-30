import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { ExportsWorker } from './exports.worker';
import { StorageModule } from '../storage/storage.module';
import { PlatformEventsModule } from '../platform/platform-events.module';

@Module({
  imports: [StorageModule, PlatformEventsModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsWorker],
})
export class ExportsModule {}
