import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportsService } from './exports.service';

@Injectable()
export class ExportsWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly exportsService: ExportsService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const enabled = this.configService.get<boolean>('exports.workerEnabled');
    if (!enabled) {
      return;
    }
    const intervalMs = Number(
      this.configService.get('exports.workerIntervalMs') ?? 15000,
    );
    this.timer = setInterval(() => {
      void this.exportsService.runNextPendingJob();
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
