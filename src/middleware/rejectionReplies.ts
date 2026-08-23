import { CircuitOpenError, PermissionDeniedError, RateLimitError } from "../errors.js";

export function rejectionChatReply(err: unknown): string | null {
  if (err instanceof RateLimitError) {
    return `you're going too fast - try again in ${Number(err.fields.retryAfterSec)}s`;
  }
  if (err instanceof PermissionDeniedError) {
    return `you don't have permission to run that command`;
  }
  if (err instanceof CircuitOpenError) {
    return `"${String(err.fields.plugin)}" is temporarily unavailable - try again soon`;
  }
  return null;
}
