import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { ExportsWorker } from './exports.worker';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsWorker],
})
export class ExportsModule {}
