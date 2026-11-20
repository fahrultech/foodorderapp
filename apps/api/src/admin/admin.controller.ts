import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError } from '../common/swagger-response-models';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { UserRole } from '../users/user.entity';
import { AdminMetricsSnapshotResponse } from './admin-metrics.response';
import { AdminAlertsReportResponse, AdminAlertsHistoryResponse } from './admin-alerts.response';
import { AlertsHistoryQueryDto } from './dto/alerts-history-query.dto';
import { AdminOverviewResponse } from './admin.response';
import { AdminService } from './admin.service';
import { RequestMetricsService } from '../common/metrics/request-metrics.service';
import { MetricsPersistenceService } from '../common/metrics/metrics-persistence.service';
import { AlertVerdictsService } from '../common/metrics/alert-verdicts.service';

@Controller('admin')
@ApiTags('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly metrics: RequestMetricsService,
    private readonly persistence: MetricsPersistenceService,
    private readonly verdicts: AlertVerdictsService,
  ) {}

  @Get('overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin platform overview',
    description:
      'Read-only operational view: platform totals plus the newest users, restaurants and orders. Password hashes are never selected into the response. ADMIN only.',
  })
  @ApiOkResponse({ type: AdminOverviewResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  overview() {
    return this.service.overview();
  }

  @Get('metrics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Request-metrics snapshot + durability window',
    description:
      'In-process per-route request counters, status-class tallies and duration histograms ' +
      '(cumulative since boot). The same numbers are folded into the pino log stream as ' +
      'periodic `event: "request_metrics"` lines. Route keys use matched templates, never ' +
      'concrete ids; `/api/health` is excluded. Since session 89 the response ALSO carries ' +
      'additive `durability` (snapshot scheduler state + stored history from the ' +
      '`metrics_snapshots` table — survives restarts) and `window` (exact traffic since the ' +
      'newest same-boot snapshot; null until such a row exists, so a restart never inherits ' +
      'a false baseline). ADMIN only.',
  })
  @ApiOkResponse({ type: AdminMetricsSnapshotResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  async metricsSnapshot() {
    return this.persistence.decorate(this.metrics.snapshot());
  }

  @Get('alerts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current alert state',
    description:
      'The ops/alerts rule engine evaluated against the LIVE metrics snapshot: error_budget ' +
      '(5xx rate vs the 99.5% availability SLO), p95_latency (histogram estimate vs ceiling), ' +
      'route_key_overflow (cardinality-cap folding) and snapshot_stale (the session-89 ' +
      'durability writer going silently dead — evaluated from a metrics_snapshots read, ' +
      'writer-disabled is exempt). Cumulative-since-boot ' +
      'totals inherited from GET /admin/metrics; the periodic `request_metrics` fold line ' +
      'carries the same verdict compactly (without the DB-backed staleness observation). ' +
      'ADMIN only.',
  })
  @ApiOkResponse({ type: AdminAlertsReportResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  async alerts() {
    return this.metrics.alerts(await this.persistence.freshnessInput());
  }

  @Get('alerts/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Alert verdict history (time series)',
    description:
      'The persisted alert_verdicts series written by the metrics-snapshot tick (same ' +
      'METRICS_SNAPSHOT_INTERVAL_SEC / _RETENTION_SEC knobs — Phase 11 Ops): windowed rows ' +
      '(oldest-first, full stored report incl. per-rule observed/threshold/detail) plus the ' +
      'consecutive-alerting STREAK that also counts this read\'s LIVE verdict, which the ' +
      'alert-scan escalation gate consumes. Reads NEVER write (observer-exemption): polling ' +
      'cannot change the history. With durability disabled the series is honestly empty and ' +
      'the streak covers the live verdict alone. ADMIN only.',
  })
  @ApiOkResponse({ type: AdminAlertsHistoryResponse })
  @ApiError(400, 'windowSec/limit not integer or out of range.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  async alertsHistory(@Query() query: AlertsHistoryQueryDto) {
    return this.verdicts.history(query);
  }
}
