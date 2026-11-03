import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsUUID, ValidateIf } from 'class-validator';

/** Body for owner/admin assignment; explicit null removes the assignment. */
export class AssignDriverDto {
  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'DRIVER-role user id, or null to unassign.',
  })
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  driverId: string | null;
}
