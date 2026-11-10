import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import {
  authMiddleware,
  createApiKeyAuthMiddleware,
} from "./auth.middleware";

function createMockResponse() {
  const res: Partial<Response> & {
    statusCode: number;
    jsonData: unknown;
    status: (code: number) => Response;
    json: (body: unknown) => Response;
  } = {
    statusCode: 200,
    jsonData: undefined,
    status(code: number) {
      this.statusCode = code;
      return this as unknown as Response;
    },
    json(body: unknown) {
      this.jsonData = body;
      return this as unknown as Response;
    },
  };
  return res;
}

describe("authMiddleware", () => {
  it("rejects request with 401 when x-api-key header is missing", () => {
    const middleware = createApiKeyAuthMiddleware({ apiKey: "test-secret-key" });
    const req = { headers: {} } as Request;
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonData, {
      status: "error",
      message: "Unauthorized: Invalid or missing API Key",
    });
  });

  it("rejects request when key length differs from expected key", () => {
    const middleware = createApiKeyAuthMiddleware({ apiKey: "super-secret-key" });
    const req = {
      headers: { "x-api-key": "short" },
    } as unknown as Request;
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonData, {
      status: "error",
      message: "Unauthorized: Invalid or missing API Key",
    });
  });

  it("rejects request when key length matches but characters differ", () => {
    const middleware = createApiKeyAuthMiddleware({ apiKey: "secret_12345" });
    const req = {
      headers: { "x-api-key": "secret_54321" },
    } as unknown as Request;
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonData, {
      status: "error",
      message: "Unauthorized: Invalid or missing API Key",
    });
  });

  it("calls next() when valid API key is supplied", () => {
    const middleware = createApiKeyAuthMiddleware({ apiKey: "my-valid-api-key" });
    const req = {
      headers: { "x-api-key": "my-valid-api-key" },
    } as unknown as Request;
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData, undefined);
  });

  it("defaults to process.env.API_KEY or dev_secret_key_123", () => {
    const defaultMiddleware = authMiddleware;
    const req = {
      headers: { "x-api-key": process.env.API_KEY || "dev_secret_key_123" },
    } as unknown as Request;
    const res = createMockResponse();
    let nextCalled = false;

    defaultMiddleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  it("supports array-valued x-api-key header using first value", () => {
    const middleware = createApiKeyAuthMiddleware({ apiKey: "test-array-key" });
    const req = {
      headers: { "x-api-key": ["test-array-key", "other-key"] as unknown as string },
    } as unknown as Request;
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});

