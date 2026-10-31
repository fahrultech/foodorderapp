import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CityResponse } from '../common/swagger-response-models';
import { CitiesService } from './cities.service';

@Controller('cities')
@ApiTags('cities')
export class CitiesController {
  constructor(private readonly service: CitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'List active delivery cities',
    description: 'Public registry used to scope restaurant browsing and owner onboarding.',
  })
  @ApiOkResponse({ type: [CityResponse] })
  list() {
    return this.service.findActive();
  }
}
