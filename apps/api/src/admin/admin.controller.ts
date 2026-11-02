import { Controller, Get, UseGuards } from '@nestjs/common';
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
import { AdminOverviewResponse } from './admin.response';
import { AdminService } from './admin.service';

@Controller('admin')
@ApiTags('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}

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
}
