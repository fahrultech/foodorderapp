import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeleteAccountDto {
  @ApiProperty({ type: 'string', format: 'password', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;

  @ApiProperty({ enum: ['DELETE'], description: 'Exact destructive-action confirmation.' })
  @IsString()
  @Equals('DELETE')
  confirmation: string;
}
