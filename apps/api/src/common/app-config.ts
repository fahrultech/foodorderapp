import { ValidationPipe } from '@nestjs/common';

/**
 * The exact ValidationPipe options the app boots with (src/main.ts).
 * Exported so specs exercise the *real* production configuration instead
 * of re-declaring it and drifting away.
 */
export const GLOBAL_VALIDATION_PIPE_OPTIONS = {
  whitelist: true,
  transform: true,
  forbidUnknownValues: true,
} as const;

export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
}
