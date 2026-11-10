import type { Server } from "node:http";
import "dotenv/config";
import app from "./app";
import { logger } from "./config/logger";
import prisma from "./config/prisma";

const port = Number(process.env.PORT) || 3000;

export const server: Server = app.listen(port, () => {
  logger.info({ port }, `Server running on http://localhost:${port}`);
});

export interface GracefulShutdownDependencies {
  server?: { close: (callback: (error?: Error) => void) => void };
  prismaClient?: { $disconnect: () => Promise<void> };
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  exit?: (code?: number) => void;
}

export function createGracefulShutdown(
  defaultDeps: GracefulShutdownDependencies = {},
) {
  let isShuttingDown = false;

  return async function gracefulShutdown(
    signal: string,
    dependencies: GracefulShutdownDependencies = {},
  ): Promise<void> {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    const activeLogger = dependencies.logger ?? defaultDeps.logger ?? logger;
    const activeServer = dependencies.server ?? defaultDeps.server ?? server;
    const activePrisma =
      dependencies.prismaClient ?? defaultDeps.prismaClient ?? prisma;
    const activeExit = dependencies.exit ?? defaultDeps.exit ?? process.exit;

    activeLogger.info(
      { signal },
      `Received ${signal}. Initiating graceful shutdown...`,
    );

    await new Promise<void>((resolve) => {
      activeServer.close((error) => {
        if (error) {
          activeLogger.error(
            { error },
            "Error encountered while closing HTTP server",
          );
        }
        resolve();
      });
    });

    try {
      await activePrisma.$disconnect();
    } catch (error) {
      activeLogger.error(
        { error },
        "Error encountered while disconnecting Prisma",
      );
    }

    activeExit(0);
  };
}

export const gracefulShutdown = createGracefulShutdown();

process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => void gracefulShutdown("SIGINT"));

export default server;
