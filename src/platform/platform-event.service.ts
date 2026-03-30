import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

export type PlatformSseEventType =
  | 'subscription_request.created'
  | 'incident.created'
  | 'incident.transitioned'
  | 'export.failed'
  | 'business.review_flagged';

export type PlatformSsePayload = {
  type: PlatformSseEventType;
  data: Record<string, unknown>;
};

type StreamEvent = {
  data: unknown;
  type?: string;
};

@Injectable()
export class PlatformEventService {
  private readonly subject = new Subject<PlatformSsePayload>();

  constructor(private readonly jwtService: JwtService) {}

  emit(type: PlatformSseEventType, data: Record<string, unknown>) {
    this.subject.next({ type, data });
  }

  createStream(token: string): Observable<StreamEvent> {
    if (!token) {
      throw new UnauthorizedException('Missing token.');
    }
    let payload: { scope?: string };
    try {
      payload = this.jwtService.verify<{ scope?: string }>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    if (payload?.scope !== 'platform') {
      throw new UnauthorizedException('Platform admin access required.');
    }

    const events = this.subject.asObservable().pipe(
      map((event) => ({
        type: event.type,
        data: event.data,
      })),
    );

    const keepAlive = interval(25000).pipe(
      map(() => ({
        type: 'ping',
        data: { ts: Date.now() },
      })),
    );

    return merge(events, keepAlive);
  }
}
