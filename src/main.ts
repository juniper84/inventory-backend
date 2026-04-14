import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

// P2-G6-M1: Validate required environment variables at startup.
// Fail fast so misconfigured deployments are caught immediately rather than at runtime.
const REQUIRED_ENV_VARS = ['DATABASE_URL', 'JWT_SECRET'];
for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.error(`[Startup] Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Optional but important env vars — warn rather than exit.
const RECOMMENDED_ENV_VARS = ['S3_BUCKET', 'SMTP_FROM', 'FRONTEND_URL'];
for (const envVar of RECOMMENDED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.warn(`[Startup] Warning: ${envVar} is not set — some features may not work correctly.`);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
  );
  app.setGlobalPrefix('api/v1');
  // P2-G1-L1: Restrict CORS to known frontend origins.
  // In development, also allow localhost so the dev server can reach the API.
  const allowedOrigins = new Set<string>();
  if (process.env.FRONTEND_URL) allowedOrigins.add(process.env.FRONTEND_URL);
  if (process.env.APP_BASE_URL) allowedOrigins.add(process.env.APP_BASE_URL);
  // Marketing site origins — comma-separated list (supports apex + www, etc.)
  if (process.env.MARKETING_URLS) {
    for (const url of process.env.MARKETING_URLS.split(',')) {
      const trimmed = url.trim();
      if (trimmed) allowedOrigins.add(trimmed);
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://localhost:3001');
    allowedOrigins.add('http://localhost:3002');
  }
  app.enableCors({
    origin: allowedOrigins.size > 0 ? [...allowedOrigins] : 'http://localhost:3001',
    credentials: true,
  });
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('New Vision Inventory API')
      .setDescription('API documentation for New Vision Inventory.')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
