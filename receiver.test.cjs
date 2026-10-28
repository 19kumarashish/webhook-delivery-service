const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { afterEach, describe, it } = require("node:test");
const { createReceiverServer, verifyWebhookSignature } = require("./receiver.cjs");

const servers = [];

async function startReceiver(secret) {
  const server = createReceiverServer(secret);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}/webhook`;
}

function signature(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    ),
  );
});

describe("webhook receiver signature verification", () => {
  it("accepts a valid HMAC signature for the exact raw body", async () => {
    const secret = "test-secret-a";
    const body = '{"id":"evt_1","data":{"amount":100}}';
    const url = await startReceiver(secret);

    const response = await fetch(url, {
      method: "POST",
      headers: { "x-webhook-signature": signature(secret, body) },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).signatureValid, true);
  });

  it("rejects an incorrect secret with 401", async () => {
    const url = await startReceiver("correct-secret");
    const body = '{"event":"test"}';

    const response = await fetch(url, {
      method: "POST",
      headers: { "x-webhook-signature": signature("wrong-secret", body) },
      body,
    });

    assert.equal(response.status, 401);
  });

  it("rejects a modified request body", async () => {
    const secret = "body-secret";
    const url = await startReceiver(secret);
    const signedBody = '{"amount":100}';

    const response = await fetch(url, {
      method: "POST",
      headers: { "x-webhook-signature": signature(secret, signedBody) },
      body: '{"amount":101}',
    });

    assert.equal(response.status, 401);
  });

  it("rejects missing and malformed signatures", async () => {
    const url = await startReceiver("malformed-secret");
    const body = '{"event":"test"}';

    const missing = await fetch(url, { method: "POST", body });
    const malformed = await fetch(url, {
      method: "POST",
      headers: { "x-webhook-signature": "sha256=not-hex" },
      body,
    });

    assert.equal(missing.status, 401);
    assert.equal(malformed.status, 401);
  });

  it("keeps different endpoint secrets isolated", () => {
    const body = Buffer.from('{"id":"evt_2"}', "utf8");
    const signatureA = signature("endpoint-secret-a", body);
    const signatureB = signature("endpoint-secret-b", body);

    assert.equal(verifyWebhookSignature(signatureA, body, "endpoint-secret-a"), true);
    assert.equal(verifyWebhookSignature(signatureA, body, "endpoint-secret-b"), false);
    assert.equal(verifyWebhookSignature(signatureB, body, "endpoint-secret-b"), true);
  });
});
