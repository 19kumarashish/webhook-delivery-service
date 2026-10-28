
const http = require("node:http");
const { createHmac, timingSafeEqual } = require("node:crypto");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function verifyWebhookSignature(receivedSignature, body, secret) {
  if (
    typeof receivedSignature !== "string" ||
    !receivedSignature.startsWith("sha256=")
  ) {
    return false;
  }

  const receivedHex = receivedSignature.slice("sha256=".length);
  if (!/^([0-9a-f]{64})$/i.test(receivedHex)) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  const received = Buffer.from(receivedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");

  return timingSafeEqual(received, expected);
}

function createReceiverServer(secret) {
  if (!secret) {
    throw new Error("Webhook secret is required");
  }

  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      return res.end("Not found");
    }

    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const receivedSignature = req.headers["x-webhook-signature"];

      if (!verifyWebhookSignature(receivedSignature, body, secret)) {
        res.writeHead(401);
        return res.end("Invalid signature");
      }

      console.log("Webhook received and signature verified!");
      console.log("Event:", req.headers["x-webhook-event"]);
      console.log("Delivery ID:", req.headers["x-webhook-delivery"]);
      console.log("Body:", body.toString("utf8"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true, signatureValid: true }));
    });
  });
}

if (require.main === module) {
  if (!WEBHOOK_SECRET) {
    throw new Error("Set the WEBHOOK_SECRET environment variable");
  }

  const server = createReceiverServer(WEBHOOK_SECRET);
  server.listen(4000, "127.0.0.1", () => {
    console.log("Signature-verifying receiver running at http://127.0.0.1:4000/webhook");
  });
}

module.exports = { createReceiverServer, verifyWebhookSignature };
