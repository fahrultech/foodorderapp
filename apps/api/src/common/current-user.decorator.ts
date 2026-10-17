import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Extracts the authenticated user payload attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
