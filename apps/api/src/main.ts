import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from './app.module';
import { ErrorFormatFilter } from './common/error-format.filter';
import { createGlobalValidationPipe } from './common/app-config';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './common/logging/request-id.middleware';
import { createRootLogger, PinoLoggerService } from './common/logging/pino-logger';
import { createHttpLoggingMiddleware } from './common/logging/http-logging';

// LOG_LEVEL from apps/api/.env must be readable before the logger is built
// (no-op when the environment already carries it, e.g. in containers).
// `quiet` keeps stdout pure JSON: dotenv 17 prints an advisory banner on load.
loadDotenv({ quiet: true });

async function bootstrap() {
  const rootLogger = createRootLogger();
  const app = await NestFactory.create(AppModule, { logger: new PinoLoggerService(rootLogger) });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  // Correlation first (it seeds req.id for pino-http and the response
  // header), then access logging. Both order-sensitive — keep as-is.
  app.use(requestIdMiddleware);
  app.use(createHttpLoggingMiddleware(rootLogger));
  app.enableCors({ origin: true, credentials: true, exposedHeaders: [REQUEST_ID_HEADER] });
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
  await app.listen(port);
  rootLogger.info(`API listening on http://localhost:${port}/api`);
}

bootstrap().catch((err) => {
  // Startup can fail before the app logger exists — keep even this line structured.
  createRootLogger().fatal({ err }, 'API failed to start');
  process.exitCode = 1;
});
