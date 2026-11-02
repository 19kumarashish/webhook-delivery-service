import { Router } from "express";
import { HealthService } from "../health/health.service";
import prisma from "../config/prisma";
import redis from "../config/redis";

export interface HealthRouteService {
  getReadiness(): Promise<{
    status: "ok" | "error";
    timestamp: string;
    dependencies: {
      database: "up" | "down";
      redis: "up" | "down";
    };
  }>;
}

export function createHealthRouter(
  healthService: HealthRouteService = new HealthService({
    database: {
      async checkDatabase() {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    redis: {
      async checkRedis() {
        await redis.ping();
      },
    },
  }),
) {
  const router = Router();

  router.get("/live", (_req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/ready", async (_req, res) => {
    try {
      const readiness = await healthService.getReadiness();
      res.status(readiness.status === "ok" ? 200 : 503).json(readiness);
    } catch {
      res.status(503).json({
        status: "error",
        timestamp: new Date().toISOString(),
        dependencies: {
          database: "down",
          redis: "down",
        },
      });
    }
  });

  router.get("/", async (_req, res) => {
    try {
      const readiness = await healthService.getReadiness();
      res.status(readiness.status === "ok" ? 200 : 503).json(readiness);
    } catch {
      res.status(503).json({
        status: "error",
        timestamp: new Date().toISOString(),
        dependencies: {
          database: "down",
          redis: "down",
        },
      });
    }
  });

  return router;
}

export default createHealthRouter();
