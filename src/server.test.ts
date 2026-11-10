import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createGracefulShutdown, server } from "./server";
import redis from "./config/redis";
import prisma from "./config/prisma";

describe("gracefulShutdown", () => {
  after(async () => {
    await redis.quit();
    await prisma.$disconnect();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it("orchestrates server close, prisma disconnect, and clean exit", async () => {
    let serverClosed = false;
    let prismaDisconnected = false;
    let exitCode: number | undefined;
    const logEntries: Array<{ obj: unknown; msg?: string }> = [];

    const mockServer = {
      close(cb: (error?: Error) => void) {
        serverClosed = true;
        cb();
      },
    };

    const mockPrisma = {
      async $disconnect() {
        prismaDisconnected = true;
      },
    };

    const mockLogger = {
      info(obj: unknown, msg?: string) {
        logEntries.push({ obj, msg });
      },
      error(obj: unknown, msg?: string) {
        logEntries.push({ obj, msg });
      },
    };

    const shutdown = createGracefulShutdown();
    await shutdown("SIGTERM", {
      server: mockServer,
      prismaClient: mockPrisma,
      logger: mockLogger,
      exit: (code?: number) => {
        exitCode = code;
      },
    });

    assert.equal(serverClosed, true);
    assert.equal(prismaDisconnected, true);
    assert.equal(exitCode, 0);

    const infoLog = logEntries.find((e) =>
      e.msg?.includes("Initiating graceful shutdown"),
    );
    assert.ok(infoLog);
    assert.deepEqual(infoLog?.obj, { signal: "SIGTERM" });
  });

  it("handles errors during shutdown and still completes exit", async () => {
    let serverClosed = false;
    let prismaAttempted = false;
    let exitCode: number | undefined;
    const errorLogs: Array<{ obj: unknown; msg?: string }> = [];

    const mockServer = {
      close(cb: (error?: Error) => void) {
        serverClosed = true;
        cb(new Error("Server closing failed"));
      },
    };

    const mockPrisma = {
      async $disconnect() {
        prismaAttempted = true;
        throw new Error("Prisma disconnect failed");
      },
    };

    const mockLogger = {
      info() {},
      error(obj: unknown, msg?: string) {
        errorLogs.push({ obj, msg });
      },
    };

    const shutdown = createGracefulShutdown();
    await shutdown("SIGINT", {
      server: mockServer,
      prismaClient: mockPrisma,
      logger: mockLogger,
      exit: (code?: number) => {
        exitCode = code;
      },
    });

    assert.equal(serverClosed, true);
    assert.equal(prismaAttempted, true);
    assert.equal(exitCode, 0);
    assert.equal(errorLogs.length, 2);
  });

  it("is idempotent when called multiple times concurrently", async () => {
    let closeCount = 0;
    const mockServer = {
      close(cb: (error?: Error) => void) {
        closeCount++;
        cb();
      },
    };

    const mockPrisma = {
      async $disconnect() {},
    };

    const shutdown = createGracefulShutdown();
    await Promise.all([
      shutdown("SIGTERM", {
        server: mockServer,
        prismaClient: mockPrisma,
        logger: { info() {}, error() {} },
        exit: () => {},
      }),
      shutdown("SIGTERM", {
        server: mockServer,
        prismaClient: mockPrisma,
        logger: { info() {}, error() {} },
        exit: () => {},
      }),
    ]);

    assert.equal(closeCount, 1);
  });
});
