import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, it } from "node:test";
import { createWebhookRouter } from "./webhook.routes";
import {
  createWebhookEndpoint,
  WebhookUrlValidationError,
  type CreateWebhookInput,
} from "../services/webhook.service";

async function postWebhookEndpoint(
  router: ReturnType<typeof createWebhookRouter>,
  body: unknown,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use(router);

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;

    return await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("webhook endpoint registration routes", () => {
  it("creates endpoint successfully for valid public destination", async () => {
    const mockCreated = {
      id: "ep_123",
      url: "https://example.com/webhook",
      subscribedEvents: ["order.created"],
      isActive: true,
      createdAt: new Date("2026-10-29T10:00:00.000Z"),
      secret: "mock-secret-hex",
    };

    const mockCreator = async (input: CreateWebhookInput) => {
      assert.equal(input.url, "https://example.com/webhook");
      assert.deepEqual(input.subscribedEvents, ["order.created"]);
      return mockCreated;
    };

    const router = createWebhookRouter(mockCreator as any);
    const response = await postWebhookEndpoint(router, {
      url: "https://example.com/webhook",
      subscribedEvents: ["order.created"],
    });

    assert.equal(response.status, 201);
    const json = await response.json();
    assert.equal(json.message, "Webhook endpoint created successfully");
    assert.equal(json.data.id, "ep_123");
    assert.equal(json.data.secret, "mock-secret-hex");
  });

  it("rejects invalid request payloads with 400", async () => {
    const router = createWebhookRouter();

    const response = await postWebhookEndpoint(router, {
      url: "not-a-url",
      subscribedEvents: ["order.created"],
    });

    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.error, "Invalid request");
    assert.ok(Array.isArray(json.details));
  });

  it("rejects prohibited or unresolvable destination URLs with 400", async () => {
    const mockCreator = async () => {
      throw new WebhookUrlValidationError();
    };

    const router = createWebhookRouter(mockCreator as any);
    const response = await postWebhookEndpoint(router, {
      url: "https://internal.service.local/webhook",
      subscribedEvents: ["order.created"],
    });

    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(
      json.error,
      "Invalid webhook URL: destination is not permitted or could not be resolved",
    );
  });

  it("logs unexpected failures and returns 500 without leaking internal details", async () => {
    let loggedMessage = "";
    let loggedError: unknown = null;

    const mockLogger = (message: string, error: unknown) => {
      loggedMessage = message;
      loggedError = error;
    };

    const mockCreator = async () => {
      throw new Error("Database connection lost");
    };

    const router = createWebhookRouter(mockCreator as any, mockLogger);
    const response = await postWebhookEndpoint(router, {
      url: "https://example.com/webhook",
      subscribedEvents: ["order.created"],
    });

    assert.equal(response.status, 500);
    const json = await response.json();
    assert.deepEqual(json, { error: "Internal server error" });
    assert.ok(loggedMessage.includes("Failed to create webhook endpoint"));
    assert.equal((loggedError as Error).message, "Database connection lost");
  });
});

describe("createWebhookEndpoint service validation", () => {
  it("validates URL before persisting and fails closed when invalid", async () => {
    const mockValidator = async () => false;

    await assert.rejects(
      async () => {
        await createWebhookEndpoint(
          {
            url: "http://192.168.1.1/webhook",
            subscribedEvents: ["order.created"],
          },
          mockValidator,
        );
      },
      (err: unknown) => {
        return err instanceof WebhookUrlValidationError;
      },
    );
  });

  it("passes lookupHost down to the validator for deterministic DNS testing", async () => {
    let lookupCalled = false;
    const mockLookup = async () => {
      lookupCalled = true;
      return [{ address: "127.0.0.1", family: 4 }];
    };

    await assert.rejects(
      async () => {
        await createWebhookEndpoint(
          {
            url: "https://my-webhook.example-domain.net/webhook",
            subscribedEvents: ["order.created"],
          },
          undefined,
          mockLookup,
        );
      },
      (err: unknown) => {
        return err instanceof WebhookUrlValidationError;
      },
    );

    assert.equal(lookupCalled, true);
  });
});
