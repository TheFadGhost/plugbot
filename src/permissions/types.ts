/**
 * Permission contracts shared by the router (consumer) and the authorization
 * middleware (implementer). Roles come from the platform via the adapter;
 * "admin" is the only role with framework meaning.
 */

import type { User } from "../types.js";

/** Adapter-backed role source. */
export interface RoleResolver {
  resolveRoles(userId: string, channelId?: string): Promise<readonly string[]>;
  /** False when the platform cannot prove roles at all. */
  supportsRoles(): boolean;
}

export interface Authorizer {
  /**
   * Resolves when allowed. Rejects PermissionDeniedError when not.
   * Undefined permission means the command is public.
   */
  assertAllowed(user: User, permission?: string): Promise<void>;
}
