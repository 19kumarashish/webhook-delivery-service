import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import { getLogContext } from "../logging/context";
import { createRequestContextMiddleware } from "./request-context.middleware";

interface CompletionLog {
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

function createCaptureLogger(records: CompletionLog[]) {
  return {
    info(fields: CompletionLog) {
      records.push(fields);
    },
  };
}

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("request context middleware", () => {
  it("generates a UUID when the request ID is missing", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/test", (_req, res) => res.status(204).end());

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`);
      const requestId = response.headers.get("x-request-id");

      assert.match(
        requestId ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(logs.length, 1);
      assert.equal(logs[0].requestId, requestId);
    });
  });

  it("preserves a valid incoming request ID and response header", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`, {
        headers: { "X-Request-ID": "client.request-123:A" },
      });

      assert.equal(response.headers.get("x-request-id"), "client.request-123:A");
      assert.equal(logs[0].requestId, "client.request-123:A");
    });
  });

  it("replaces invalid request IDs", async () => {
    const logs: CompletionLog[] = [];
    let generated = 0;
    const app = express();
    app.use(createRequestContextMiddleware({
      logger: createCaptureLogger(logs),
      generateRequestId: () => `generated-${++generated}`,
    }));
    app.get("/test", (_req, res) => res.status(204).end());

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`, {
        headers: { "X-Request-ID": "invalid request id" },
      });

      assert.equal(response.headers.get("x-request-id"), "generated-1");
      assert.equal(logs[0].requestId, "generated-1");
    });
  });

  it("replaces overlong request IDs", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({
      logger: createCaptureLogger(logs),
      generateRequestId: () => "replacement-request-id",
    }));
    app.get("/test", (_req, res) => res.status(204).end());

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/test`, {
        headers: { "X-Request-ID": "a".repeat(129) },
      });

      assert.equal(response.headers.get("x-request-id"), "replacement-request-id");
    });
  });

  it("makes request context accessible in downstream handlers", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/context", (_req, res) => {
      res.json(getLogContext());
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/context`, {
        headers: { "X-Request-ID": "context-request" },
      });
      assert.deepEqual(await response.json(), {
        requestId: "context-request",
        correlationId: "context-request",
      });
    });
  });

  it("isolates request contexts across concurrent HTTP requests", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/context/:id", async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, req.params.id === "a" ? 10 : 1));
      res.json(getLogContext());
    });

    await withServer(app, async (baseUrl) => {
      const [responseA, responseB] = await Promise.all([
        fetch(`${baseUrl}/context/a`, { headers: { "X-Request-ID": "request-a" } }),
        fetch(`${baseUrl}/context/b`, { headers: { "X-Request-ID": "request-b" } }),
      ]);

      assert.deepEqual(await responseA.json(), {
        requestId: "request-a",
        correlationId: "request-a",
      });
      assert.deepEqual(await responseB.json(), {
        requestId: "request-b",
        correlationId: "request-b",
      });
    });
  });

  it("logs safe completion fields without bodies, headers, or query strings", async () => {
    const logs: CompletionLog[] = [];
    let nowCalls = 0;
    const app = express();
    app.use(createRequestContextMiddleware({
      logger: createCaptureLogger(logs),
      now: () => BigInt(++nowCalls === 1 ? 100_000_000 : 125_000_000),
    }));
    app.post("/events", (_req, res) => {
      res.status(202).json({ accepted: true });
    });

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/events?apiKey=secret-key&payload=private-data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
          Cookie: "session=secret-cookie",
          "X-Request-ID": "safe-request",
        },
        body: JSON.stringify({ password: "secret-password", responseBody: "secret" }),
      });

      assert.equal(logs.length, 1);
      assert.deepEqual(logs[0], {
        requestId: "safe-request",
        method: "POST",
        route: "/events",
        statusCode: 202,
        durationMs: 25,
      });

      const serialized = JSON.stringify(logs);
      assert.equal(serialized.includes("secret-key"), false);
      assert.equal(serialized.includes("private-data"), false);
      assert.equal(serialized.includes("secret-token"), false);
      assert.equal(serialized.includes("secret-cookie"), false);
      assert.equal(serialized.includes("secret-password"), false);
      assert.equal(serialized.includes("responseBody"), false);
    });
  });

  it("emits exactly one completion log for normal responses", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/once", (_req, res) => res.status(200).end("ok"));

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/once`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(logs.length, 1);
    });
  });

  it("does not emit duplicate logs after an aborted connection", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/abort", (_req, res) => {
      res.destroy();
    });

    await withServer(app, async (baseUrl) => {
      await assert.rejects(
        fetch(`${baseUrl}/abort`),
        (error: unknown) => error instanceof Error,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(logs.length, 1);
      assert.equal(logs[0].route, "/abort");
    });
  });

  it("handles response error events without duplicate completion logs", async () => {
    const logs: CompletionLog[] = [];
    const app = express();
    app.use(createRequestContextMiddleware({ logger: createCaptureLogger(logs) }));
    app.get("/error", (_req, res) => {
      res.emit("error", new Error("response stream failure"));
      res.end();
    });

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/error`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(logs.length, 1);
    });
  });
});
