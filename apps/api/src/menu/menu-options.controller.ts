import {
  Body,
  Controller,
  Delete,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UuidParam } from '../common/uuid';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  MenuOptionChoiceResponse,
  MenuOptionGroupResponse,
} from '../common/swagger-response-models';
import { MenuOptionService } from './menu-option.service';
import {
  CreateOptionChoiceDto,
  CreateOptionGroupDto,
  UpdateOptionChoiceDto,
  UpdateOptionGroupDto,
} from './dto/menu-option.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Dish-scoped OWNER routes for option groups/choices (Phase 5). Every
 * write resolves ownership through the DISH in the path (`loadManagedItem`
 * — foreign/unknown dish ids answer 404, exactly like the dish routes);
 * group/choice ids must then nest under that dish or 404 as well. Choices
 * are only reachable through their group, so a leaked choice id is
 * useless without its parent path.
 */
@Controller('menu/items/:itemId/options')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@ApiTags('menu')
@ApiBearerAuth()
export class MenuOptionsController {
  constructor(private readonly service: MenuOptionService) {}

  private actor(user: any) {
    return { sub: user.sub, role: user.role as UserRole };
  }

  @Post('groups')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: create option group with its choices', description: 'minChoices 0..20 (default 0 = optional), maxChoices 1..20 (default 1 = pick one), 1..20 choices with integer-cents price deltas. Server rejects min>max or min above the provided choice count.' })
  @ApiCreatedResponse({ type: MenuOptionGroupResponse })
  @ApiError(400, 'Body failed validation (e.g. minChoices > maxChoices) or a path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish id.')
  createGroup(
    @UuidParam('itemId') itemId: string,
    @CurrentUser() user: any,
    @Body() dto: CreateOptionGroupDto,
  ) {
    return this.service.createGroup(itemId, this.actor(user), dto);
  }

  @Patch('groups/:groupId')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'groupId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: edit option group (partial)', description: 'Renaming or re-bounding a group never rewrites past order lines — their receipt is the jsonb snapshot on the order item.' })
  @ApiOkResponse({ type: MenuOptionGroupResponse })
  @ApiError(400, 'Body failed validation, min>max, or min above the current choice count.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish id or group not under this dish.')
  updateGroup(
    @UuidParam('itemId') itemId: string,
    @UuidParam('groupId') groupId: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateOptionGroupDto,
  ) {
    return this.service.updateGroup(itemId, groupId, this.actor(user), dto);
  }

  @Delete('groups/:groupId')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'groupId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: delete option group (cascade choices)' })
  @ApiOkResponse({ type: MenuOptionGroupResponse, description: 'Pre-delete snapshot of the group.' })
  @ApiError(400, 'A path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish id or group not under this dish.')
  removeGroup(
    @UuidParam('itemId') itemId: string,
    @UuidParam('groupId') groupId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.removeGroup(itemId, groupId, this.actor(user));
  }

  @Post('groups/:groupId/choices')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'groupId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: add a choice to a group', description: 'Rejected past the 20-choice cap. position defaults to the current count (appends).' })
  @ApiCreatedResponse({ type: MenuOptionChoiceResponse })
  @ApiError(400, 'Body failed validation or a path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish id or group not under this dish.')
  addChoice(
    @UuidParam('itemId') itemId: string,
    @UuidParam('groupId') groupId: string,
    @CurrentUser() user: any,
    @Body() dto: CreateOptionChoiceDto,
  ) {
    return this.service.addChoice(itemId, groupId, this.actor(user), dto);
  }

  @Patch('groups/:groupId/choices/:choiceId')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'groupId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'choiceId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: edit a choice (partial)', description: 'A price-delta change applies to FUTURE orders only — existing order lines keep their frozen snapshot + unit price.' })
  @ApiOkResponse({ type: MenuOptionChoiceResponse })
  @ApiError(400, 'Body failed validation or a path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish/group/choice nesting.')
  updateChoice(
    @UuidParam('itemId') itemId: string,
    @UuidParam('groupId') groupId: string,
    @UuidParam('choiceId') choiceId: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateOptionChoiceDto,
  ) {
    return this.service.updateChoice(
      itemId,
      groupId,
      choiceId,
      this.actor(user),
      dto,
    );
  }

  @Delete('groups/:groupId/choices/:choiceId')
  @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'groupId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'choiceId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: delete a choice', description: '400 when that would starve a mandatory group below its minChoices — lower minChoices (or delete the group) first.' })
  @ApiOkResponse({ type: MenuOptionChoiceResponse, description: 'Pre-delete snapshot of the choice.' })
  @ApiError(400, 'Body/path validation failed or deletion would break the group minimum.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER (admins bypass).')
  @ApiError(404, 'Unknown dish/group/choice nesting.')
  removeChoice(
    @UuidParam('itemId') itemId: string,
    @UuidParam('groupId') groupId: string,
    @UuidParam('choiceId') choiceId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.removeChoice(
      itemId,
      groupId,
      choiceId,
      this.actor(user),
    );
  }
}
