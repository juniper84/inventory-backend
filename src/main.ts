import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  const config = new DocumentBuilder()
    .setTitle('New Vision Inventory API')
    .setDescription('API documentation for New Vision Inventory.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
