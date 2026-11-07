import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiError, SearchResultsResponse } from '../common/swagger-response-models';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchService } from './search.service';

@Controller('search')
@ApiTags('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Public fuzzy search over restaurants and dishes (pg_trgm)',
    description:
      'Trigram similarity + word similarity + escaped substring match over restaurant ' +
      'name/description/cuisine and AVAILABLE dish name/description, ranked by ' +
      'server-side relevance. Restaurant results carry the shared `hours`/`isOpenNow` ' +
      'derivation. Backed by GIN pg_trgm indexes.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Query text (1..100 chars after trim; blank is a 400).',
    example: 'warung',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
    description: 'Per-side cap — applies to BOTH the restaurants and the dishes list.',
  })
  @ApiOkResponse({ type: SearchResultsResponse })
  @ApiError(400, 'Missing/blank/too-long `q`, or `limit` outside 1..25.')
  search(@Query() dto: SearchQueryDto) {
    return this.service.search(dto.q, dto.limit);
  }
}
