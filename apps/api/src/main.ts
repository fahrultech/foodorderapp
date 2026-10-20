import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ErrorFormatFilter } from './common/error-format.filter';
import { createGlobalValidationPipe } from './common/app-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  app.enableCors({ origin: true, credentials: true });
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
