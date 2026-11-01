import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { type DestinationStream } from "pino";
import {
  createLogger,
  resolveLogLevel,
  serializeError,
} from "./logger";

function captureLogs(level = "info") {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  }) as DestinationStream;

  const logger = createLogger({
    level,
    environment: "test",
    destination,
  });

  return {
    logger,
    read: () => lines.join("").trim().split(/\r?\n/).filter(Boolean).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    ),
  };
}

describe("Pino logger configuration", () => {
  it("creates a reusable logger with the configured level", () => {
    assert.equal(resolveLogLevel(undefined), "info");
    assert.equal(resolveLogLevel("DEBUG"), "debug");
    assert.equal(resolveLogLevel("invalid"), "info");

    const capture = captureLogs("warn");
    assert.equal(capture.logger.level, "warn");
  });

  it("serializes messages as JSON and supports child loggers", () => {
    const capture = captureLogs("info");
    const child = capture.logger.child({
      deliveryId: "delivery_123",
      eventId: "event_123",
    });

    child.info({ status: "PENDING" }, "delivery lifecycle event");

    const records = capture.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].msg, "delivery lifecycle event");
    assert.equal(records[0].deliveryId, "delivery_123");
    assert.equal(records[0].eventId, "event_123");
    assert.equal(records[0].status, "PENDING");
    assert.equal(records[0].service, "webhook-delivery-service");
    assert.equal(records[0].environment, "test");
    assert.equal(typeof records[0].time, "string");
  });

  it("redacts sensitive top-level, nested, array, and header fields", () => {
    const capture = captureLogs("info");

    capture.logger.info({
      authorization: "sensitive-authorization",
      cookie: "sensitive-cookie",
      "Set-Cookie": "sensitive-set-cookie",
      secret: "sensitive-secret",
      signature: "sensitive-signature",
      apiKey: "sensitive-api-key",
      accessToken: "sensitive-access-token",
      refreshToken: "sensitive-refresh-token",
      password: "sensitive-password",
      payload: { cardNumber: "sensitive-card" },
      requestBody: { password: "sensitive-request-password" },
      body: { accessToken: "sensitive-body-token" },
      responseBody: "sensitive-response",
      headers: {
        "X-Webhook-Signature": "sensitive-header-signature",
        "x-webhook-signature": "sensitive-lowercase-signature",
        Authorization: "sensitive-header-authorization",
        "set-cookie": "sensitive-header-cookie",
      },
      nested: {
        secret: "sensitive-nested-secret",
        payload: { value: "sensitive-nested-payload" },
        items: [
          { apiKey: "sensitive-array-key", value: "safe-array-value" },
          { accessToken: "sensitive-array-token", password: "sensitive-array-password" },
        ],
      },
    }, "sensitive values");

    const record = capture.read()[0];
    assert.equal(record.authorization, "[REDACTED]");
    assert.equal(record.cookie, "[REDACTED]");
    assert.equal(record["Set-Cookie"], "[REDACTED]");
    assert.equal(record.secret, "[REDACTED]");
    assert.equal(record.signature, "[REDACTED]");
    assert.equal(record.apiKey, "[REDACTED]");
    assert.equal(record.accessToken, "[REDACTED]");
    assert.equal(record.refreshToken, "[REDACTED]");
    assert.equal(record.password, "[REDACTED]");
    assert.equal(record.headers, "[REDACTED]");
    assert.equal(record.payload, "[REDACTED]");
    assert.equal(record.requestBody, "[REDACTED]");
    assert.equal(record.body, "[REDACTED]");
    assert.equal(record.responseBody, "[REDACTED]");
    assert.deepEqual(record.nested, {
      secret: "[REDACTED]",
      payload: "[REDACTED]",
      items: [
        { apiKey: "[REDACTED]", value: "safe-array-value" },
        { accessToken: "[REDACTED]", password: "[REDACTED]" },
      ],
    });
  });

  it("serializes only safe error metadata", () => {
    const capture = captureLogs("info");
    const error = new Error(
      "Connection failed for https://user:password@example.com/hook?apiKey=sensitive-key&payload=sensitive-payload",
    );
    (error as Error & { code?: string }).code = "WEBHOOK_FAILED";
    Object.assign(error, {
      secret: "must-not-be-serialized",
      payload: { password: "must-not-be-serialized" },
      authorization: "must-not-be-serialized",
      accessToken: "must-not-be-serialized",
      stack: "sensitive stack trace",
    });

    capture.logger.error({ err: error }, "delivery failed");

    const record = capture.read()[0];
    assert.deepEqual(record.err, {
      type: "Error",
      name: "Error",
      code: "WEBHOOK_FAILED",
    });

    const direct = serializeError(error);
    assert.equal("stack" in direct, false);
    assert.equal("message" in direct, false);
    assert.equal("payload" in direct, false);
    assert.equal("secret" in direct, false);
    assert.equal("authorization" in direct, false);
    assert.equal("accessToken" in direct, false);
    assert.equal(JSON.stringify(direct).includes("example.com"), false);
    assert.equal(JSON.stringify(direct).includes("sensitive-key"), false);

    assert.equal(serializeError("unexpected").type, "string");
    assert.equal(serializeError("unexpected").name, "UnknownError");
  });

  it("does not emit messages below the configured level", () => {
    const capture = captureLogs("error");

    capture.logger.info("filtered info");
    capture.logger.error("emitted error");

    const records = capture.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].msg, "emitted error");
  });
});
