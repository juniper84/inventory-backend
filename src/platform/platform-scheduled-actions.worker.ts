import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PlatformService } from './platform.service';

const POLL_MS = 60_000; // run every minute

@Injectable()
export class PlatformScheduledActionsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformScheduledActionsWorker.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly platformService: PlatformService) {}

  onModuleInit() {
    this.intervalRef = setInterval(() => {
      this.platformService.runDueScheduledActions().catch((err: unknown) => {
        this.logger.error('Scheduled actions worker error', err);
      });
    }, POLL_MS);
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
    }
  }
}
