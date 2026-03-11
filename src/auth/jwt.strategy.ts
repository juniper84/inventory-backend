import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload) {
    // For business-scoped tokens, check whether the business was force-logged
    // out after this token was issued. If so, reject it immediately so that
    // access tokens cannot outlive a platform-admin force-logout by up to
    // the token's remaining TTL.
    if (payload.businessId && payload.iat) {
      const business = await this.prisma.business.findUnique({
        where: { id: payload.businessId },
        select: { forceLogoutAt: true },
      });
      if (
        business?.forceLogoutAt &&
        payload.iat * 1000 < business.forceLogoutAt.getTime()
      ) {
        throw new UnauthorizedException('Session has been revoked. Please log in again.');
      }
    }
    return payload;
  }
}
