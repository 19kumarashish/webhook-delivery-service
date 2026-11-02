import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HealthService } from "./health.service";

describe("HealthService", () => {
  it("rejects a zero timeout", () => {
    assert.throws(
      () => new HealthService({
        timeoutMs: 0,
        database: { async checkDatabase() {} },
        redis: { async checkRedis() {} },
      }),
      { message: "Health check timeout must be a positive finite number" },
    );
  });

  it("rejects a negative timeout", () => {
    assert.throws(
      () => new HealthService({
        timeoutMs: -1,
        database: { async checkDatabase() {} },
        redis: { async checkRedis() {} },
      }),
      { message: "Health check timeout must be a positive finite number" },
    );
  });

  it("rejects NaN timeout", () => {
    assert.throws(
      () => new HealthService({
        timeoutMs: Number.NaN,
        database: { async checkDatabase() {} },
        redis: { async checkRedis() {} },
      }),
      { message: "Health check timeout must be a positive finite number" },
    );
  });

  it("rejects positive and negative Infinity timeouts", () => {
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(
        () => new HealthService({
          timeoutMs,
          database: { async checkDatabase() {} },
          redis: { async checkRedis() {} },
        }),
        { message: "Health check timeout must be a positive finite number" },
      );
    }
  });

  it("accepts a valid positive timeout", () => {
    assert.doesNotThrow(
      () => new HealthService({
        timeoutMs: 25,
        database: { async checkDatabase() {} },
        redis: { async checkRedis() {} },
      }),
    );
  });

  it("uses the default timeout when timeoutMs is omitted", () => {
    const service = new HealthService({
      database: { async checkDatabase() {} },
      redis: { async checkRedis() {} },
    });

    assert.equal(
      (service as unknown as { timeoutMs: number }).timeoutMs,
      2_000,
    );
  });

  it("reports PostgreSQL and Redis healthy and calls injected dependencies", async () => {
    let databaseCalls = 0;
    let redisCalls = 0;
    const service = new HealthService({
      database: { async checkDatabase() { databaseCalls += 1; } },
      redis: { async checkRedis() { redisCalls += 1; } },
    });

    const result = await service.getReadiness();

    assert.equal(databaseCalls, 1);
    assert.equal(redisCalls, 1);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.dependencies, { database: "up", redis: "up" });
    assert.equal(typeof result.timestamp, "string");
  });

  it("reports PostgreSQL unavailable", async () => {
    const service = new HealthService({
      database: { async checkDatabase() { throw new Error("postgres://user:secret@internal/db"); } },
      redis: { async checkRedis() {} },
    });
    const result = await service.getReadiness();
    assert.equal(result.status, "error");
    assert.deepEqual(result.dependencies, { database: "down", redis: "up" });
  });

  it("reports Redis unavailable", async () => {
    const service = new HealthService({
      database: { async checkDatabase() {} },
      redis: { async checkRedis() { throw new Error("redis://:password@internal:6379"); } },
    });
    const result = await service.getReadiness();
    assert.equal(result.status, "error");
    assert.deepEqual(result.dependencies, { database: "up", redis: "down" });
  });

  it("reports both dependencies unavailable", async () => {
    const service = new HealthService({
      database: { async checkDatabase() { throw new Error("secret database error"); } },
      redis: { async checkRedis() { throw new Error("secret redis token"); } },
    });
    const result = await service.getReadiness();
    assert.equal(result.status, "error");
    assert.deepEqual(result.dependencies, { database: "down", redis: "down" });
  });

  it("returns unavailable status when a dependency times out", async () => {
    const service = new HealthService({
      timeoutMs: 10,
      database: { async checkDatabase() { await new Promise(() => {}); } },
      redis: { async checkRedis() {} },
    });
    const result = await service.getReadiness();
    assert.equal(result.status, "error");
    assert.deepEqual(result.dependencies, { database: "down", redis: "up" });
  });

  it("never includes raw dependency errors, credentials, or connection strings", async () => {
    const service = new HealthService({
      database: {
        async checkDatabase() {
          throw new Error("postgres://admin:super-secret@private/db password=secret");
        },
      },
      redis: {
        async checkRedis() {
          throw new Error("redis://default:super-secret@private:6379 AUTH signature=abc");
        },
      },
    });

    const serialized = JSON.stringify(await service.getReadiness());
    for (const sensitive of ["super-secret", "password", "signature", "postgres://", "redis://"]) {
      assert.equal(serialized.includes(sensitive), false);
    }
  });
});
