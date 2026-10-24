import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthResponse } from '../common/swagger-response-models';
import { DataSource } from 'typeorm';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  @ApiOperation({ summary: 'Liveness + DB probe', description: 'Always answers 200; `status: "ok" | "degraded"` reports whether `SELECT 1` succeeded. Intended for orchestrators and smoke tests.' })
  @ApiOkResponse({ type: HealthResponse })
  async check() {
    let db = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
