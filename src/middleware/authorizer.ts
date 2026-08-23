import { PermissionDeniedError } from "../errors.js";
import type { Logger } from "../logging/types.js";
import type { Authorizer, RoleResolver } from "../permissions/types.js";
import type { User } from "../types.js";

const adminWarnVerified = new WeakSet<object>();

export interface AuthorizerDeps {
  roleResolver: RoleResolver;
  adminUserIds: readonly string[];
  denyByDefaultAdmin: boolean;
  logger: Logger;
}

export function createAuthorizer(deps: AuthorizerDeps): Authorizer {
  const instanceToken = {};
  return {
    async assertAllowed(user: User, permission?: string): Promise<void> {
      if (permission === undefined) return;
      const supportsRoles = deps.roleResolver.supportsRoles();
      const roles = supportsRoles ? await deps.roleResolver.resolveRoles(user.id) : [];
      const effective = new Set(roles);
      if (deps.adminUserIds.includes(user.id)) effective.add("admin");
      if (effective.has(permission)) return;
      if (permission === "admin" && !supportsRoles) {
        if (deps.denyByDefaultAdmin) {
          throw new PermissionDeniedError("<admin command>", user.id);
        }
        if (!adminWarnVerified.has(instanceToken)) {
          adminWarnVerified.add(instanceToken);
          deps.logger.warn("admin role cannot be verified on this platform - allowing", {
            userId: user.id,
          });
        }
        return;
      }
      throw new PermissionDeniedError(`role:${permission}`, user.id);
    },
  };
}
