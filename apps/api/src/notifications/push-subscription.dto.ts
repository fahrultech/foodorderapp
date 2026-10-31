import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PushSubscriptionKeysDto {
  @ApiProperty({ description: 'Browser PushSubscription p256dh key.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  p256dh: string;

  @ApiProperty({ description: 'Browser PushSubscription auth key.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  auth: string;
}

export class SavePushSubscriptionDto {
  @ApiProperty({ example: 'https://push.example.test/subscription-id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  endpoint: string;

  @ApiProperty({ type: () => PushSubscriptionKeysDto })
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys: PushSubscriptionKeysDto;
}

export class RemovePushSubscriptionDto {
  @ApiProperty({ example: 'https://push.example.test/subscription-id' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  endpoint: string;
}
