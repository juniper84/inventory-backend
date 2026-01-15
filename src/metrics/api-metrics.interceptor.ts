import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ApiMetricsInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const start = Date.now();
    const path = (request?.originalUrl ?? request?.url ?? '').split('?')[0];

    return next.handle().pipe(
      finalize(() => {
        if (!path || path.includes('/health')) {
          return;
        }
        const durationMs = Date.now() - start;
        const statusCode = response?.statusCode ?? 500;
        const businessId = request?.user?.businessId ?? null;
        void this.prisma.apiMetric.create({
          data: {
            businessId,
            path,
            method: request?.method ?? 'UNKNOWN',
            statusCode,
            durationMs,
          },
        });
      }),
    );
  }
}
