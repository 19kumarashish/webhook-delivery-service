export interface DatabaseHealthDependency {
  checkDatabase(): Promise<unknown>;
}

export interface RedisHealthDependency {
  checkRedis(): Promise<unknown>;
}

export interface HealthDependencies {
  database: DatabaseHealthDependency;
  redis: RedisHealthDependency;
  timeoutMs?: number;
}

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
  dependencies: {
    database: "up" | "down";
    redis: "up" | "down";
  };
}

const DEFAULT_TIMEOUT_MS = 2_000;

async function withTimeout<T>(
  check: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Health check timed out")), timeoutMs);
  });

  try {
    return await Promise.race([check, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class HealthService {
  private readonly database: DatabaseHealthDependency;
  private readonly redis: RedisHealthDependency;
  private readonly timeoutMs: number;

  constructor(dependencies: HealthDependencies) {
    this.database = dependencies.database;
    this.redis = dependencies.redis;
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Health check timeout must be a positive finite number");
    }

    this.timeoutMs = timeoutMs;
  }

  async getReadiness(): Promise<HealthStatus> {
    const checkDatabase = withTimeout(
      Promise.resolve().then(() => this.database.checkDatabase()),
      this.timeoutMs,
    ).then(() => true as const, () => false as const);
    const checkRedis = withTimeout(
      Promise.resolve().then(() => this.redis.checkRedis()),
      this.timeoutMs,
    ).then(() => true as const, () => false as const);

    const [databaseUp, redisUp] = await Promise.all([
      checkDatabase,
      checkRedis,
    ]);

    const healthy = databaseUp && redisUp;
    return {
      status: healthy ? "ok" : "error",
      timestamp: new Date().toISOString(),
      dependencies: {
        database: databaseUp ? "up" : "down",
        redis: redisUp ? "up" : "down",
      },
    };
  }
}
