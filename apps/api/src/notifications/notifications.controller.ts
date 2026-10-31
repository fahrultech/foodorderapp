import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import {
  ApiError,
  PushConfigResponse,
  PushSubscriptionResponse,
  PushUnsubscribeResponse,
} from '../common/swagger-response-models';
import {
  RemovePushSubscriptionDto,
  SavePushSubscriptionDto,
} from './push-subscription.dto';
import { PushService } from './push.service';

@ApiTags('notifications')
@Controller('notifications/push')
export class NotificationsController {
  constructor(private readonly push: PushService) {}

  @Get('config')
  @ApiOperation({ summary: 'Read browser-push availability and the public VAPID key' })
  @ApiOkResponse({ type: PushConfigResponse })
  config() {
    return this.push.getConfig();
  }

  @Post('subscriptions')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register or refresh this browser push subscription' })
  @ApiOkResponse({ type: PushSubscriptionResponse })
  @ApiError(400, 'Malformed endpoint or subscription keys.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  subscribe(@Body() dto: SavePushSubscriptionDto, @CurrentUser() user: any) {
    return this.push.subscribe(user.sub, dto);
  }

  @Delete('subscriptions')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove this browser push subscription' })
  @ApiOkResponse({ type: PushUnsubscribeResponse })
  @ApiError(400, 'Malformed endpoint.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  unsubscribe(@Body() dto: RemovePushSubscriptionDto, @CurrentUser() user: any) {
    return this.push.unsubscribe(user.sub, dto.endpoint);
  }
}
