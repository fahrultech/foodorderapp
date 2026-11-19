import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from './app.module';
import { ErrorFormatFilter } from './common/error-format.filter';
import { createGlobalValidationPipe } from './common/app-config';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './common/logging/request-id.middleware';
import { createRootLogger, PinoLoggerService } from './common/logging/pino-logger';
import { createHttpLoggingMiddleware } from './common/logging/http-logging';
import { RequestMetricsService } from './common/metrics/request-metrics.service';
import { HttpCacheService } from './common/http-cache/http-cache.service';
import { BrowseCompressionService } from './common/http-cache/browse-compression.service';
import { SwaggerModule } from '@nestjs/swagger';
import {
  SWAGGER_UI_PATH,
  buildSwaggerDocumentConfig,
} from './common/swagger';

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
  // header), then metrics capture, then access logging, then the public
  // read cache. All order-sensitive: the metrics middleware must attach
  // its 'finish' listener BEFORE pino-http's so it can decorate
  // res.metrics for the same log line (Node fires same-event listeners in
  // registration order), and the cache middleware must register LAST of
  // the three so a served 304/200-from-store — which skips routing
  // entirely — was still seen by BOTH finish listeners: every revalidated
  // browse keeps its metrics sample and its access line (session 103).
  // The gzip layer (session 108) sits between logging and the cache: it
  // patches res.end BEFORE the cache middleware runs, so the bytes the
  // cache serves straight from its store flow through the SAME wrapper as
  // captured handler responses. Registering it after the cache would
  // silently leave served hits uncompressed (the order IS the contract —
  // pinned in http-cache.integration.spec.ts).
  app.use(requestIdMiddleware);
  app.use(app.get(RequestMetricsService).middleware());
  app.use(createHttpLoggingMiddleware(rootLogger));
  app.use(app.get(BrowseCompressionService).middleware());
  app.use(app.get(HttpCacheService).middleware());
  app.enableCors({ origin: true, credentials: true, exposedHeaders: [REQUEST_ID_HEADER] });
  // OpenAPI docs. Document is generated from controller/DTO metadata at boot.
  // SWAGGER_UI_PATH already carries the "api/" segment because @nestjs/swagger
  // 11 does not prepend the global prefix to the mount path (see common/swagger.ts).
  // UI: /api/docs · raw JSON: /api/docs-json. Deliberately public for now —
  // it exposes request shapes only; every endpoint keeps its own guards.
  SwaggerModule.setup(
    SWAGGER_UI_PATH,
    app,
    SwaggerModule.createDocument(app, buildSwaggerDocumentConfig()),
  );
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
  await app.listen(port);
  rootLogger.info(`API listening on http://localhost:${port}/api`);
}

bootstrap().catch((err) => {
  // Startup can fail before the app logger exists — keep even this line structured.
  createRootLogger().fatal({ err }, 'API failed to start');
  process.exitCode = 1;
});
