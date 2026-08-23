import { describe, expect, it } from "vitest";
import { PermissionDeniedError } from "../src/errors.js";
import type { LogFields, LogLevel, LogRecord, Logger } from "../src/logging/types.js";
import { createAuthorizer } from "../src/middleware/authorizer.js";
import type { RoleResolver } from "../src/permissions/types.js";
import type { User } from "../src/types.js";

interface ResolverStub extends RoleResolver {
  supportsCalls: number;
  resolveCalls: string[];
}

function makeResolver(options: { supports: boolean; roles?: readonly string[] }): ResolverStub {
  const stub: ResolverStub = {
    supportsCalls: 0,
    resolveCalls: [],
    supportsRoles(): boolean {
      stub.supportsCalls += 1;
      return options.supports;
    },
    async resolveRoles(userId: string): Promise<readonly string[]> {
      stub.resolveCalls.push(userId);
      return options.roles ?? [];
    },
  };
  return stub;
}

function makeLogger(): { logger: Logger; records: LogRecord[]; warnCount: () => number } {
  const records: LogRecord[] = [];
  const push =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      records.push({ time: 0, level, name: "test", msg, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  };
  return { logger, records, warnCount: () => records.filter((r) => r.level === "warn").length };
}

function makeUser(id: string): User {
  return { id, username: id };
}

describe("createAuthorizer", () => {
  it("resolves platform roles and grants matching permissions", async () => {
    const resolver = makeResolver({ supports: true, roles: ["moderator", "member"] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: [],
      denyByDefaultAdmin: false,
      logger,
    });
    await expect(authorizer.assertAllowed(makeUser("u1"), "moderator")).resolves.toBeUndefined();
    await expect(authorizer.assertAllowed(makeUser("u1"), "member")).resolves.toBeUndefined();
    expect(resolver.resolveCalls).toEqual(["u1", "u1"]);
  });

  it("grants admin via adminUserIds without consulting role resolution", async () => {
    const resolver = makeResolver({ supports: false, roles: ["admin"] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: ["boss-1"],
      denyByDefaultAdmin: true,
      logger,
    });
    await expect(authorizer.assertAllowed(makeUser("boss-1"), "admin")).resolves.toBeUndefined();
    expect(resolver.resolveCalls).toEqual([]);
  });

  it("rejects plain users lacking the required role with PermissionDeniedError", async () => {
    const resolver = makeResolver({ supports: true, roles: ["member"] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: [],
      denyByDefaultAdmin: false,
      logger,
    });
    let caught: unknown;
    try {
      await authorizer.assertAllowed(makeUser("u2"), "moderator");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    const denied = caught as PermissionDeniedError;
    expect(denied.fields.commandPath).toBe("role:moderator");
    expect(denied.fields.userId).toBe("u2");
  });

  it("denies default-admin when roles are unverifiable even if the resolver would allow", async () => {
    const resolver = makeResolver({ supports: false, roles: ["admin"] });
    const { logger, records } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: [],
      denyByDefaultAdmin: true,
      logger,
    });
    let caught: unknown;
    try {
      await authorizer.assertAllowed(makeUser("u3"), "admin");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).fields.commandPath).toBe("<admin command>");
    expect(resolver.resolveCalls).toEqual([]);
    expect(records.filter((r) => r.level === "warn")).toHaveLength(0);
  });

  it("allows unverifiable admin with exactly one warning across three calls", async () => {
    const resolver = makeResolver({ supports: false });
    const { logger, records } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: [],
      denyByDefaultAdmin: false,
      logger,
    });
    await expect(authorizer.assertAllowed(makeUser("u4"), "admin")).resolves.toBeUndefined();
    await expect(authorizer.assertAllowed(makeUser("u5"), "admin")).resolves.toBeUndefined();
    await expect(authorizer.assertAllowed(makeUser("u4"), "admin")).resolves.toBeUndefined();
    const warns = records.filter((r) => r.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toBe("admin role cannot be verified on this platform - allowing");
    expect(warns[0]!.fields.userId).toBe("u4");
  });

  it("never consults the resolver for public commands", async () => {
    const resolver = makeResolver({ supports: true, roles: ["admin"] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: [],
      denyByDefaultAdmin: false,
      logger,
    });
    await expect(authorizer.assertAllowed(makeUser("u6"))).resolves.toBeUndefined();
    expect(resolver.supportsCalls).toBe(0);
    expect(resolver.resolveCalls).toEqual([]);
  });

  it("denies non-admin permissions for admins whose extra roles do not include them", async () => {
    const resolver = makeResolver({ supports: true, roles: [] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: ["boss-2"],
      denyByDefaultAdmin: true,
      logger,
    });
    await expect(
      authorizer.assertAllowed(makeUser("boss-2"), "moderator"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("allows a permission granted by platform roles alongside the synthetic admin grant", async () => {
    const resolver = makeResolver({ supports: true, roles: ["admin", "admin", "auditor"] });
    const { logger } = makeLogger();
    const authorizer = createAuthorizer({
      roleResolver: resolver,
      adminUserIds: ["boss-3"],
      denyByDefaultAdmin: true,
      logger,
    });
    await expect(authorizer.assertAllowed(makeUser("boss-3"), "auditor")).resolves.toBeUndefined();
    await expect(authorizer.assertAllowed(makeUser("boss-3"), "admin")).resolves.toBeUndefined();
  });
});
