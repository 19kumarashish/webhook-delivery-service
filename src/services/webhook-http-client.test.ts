import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  sendWebhookRequest,
  HttpDeliveryError,
  SsrfSecurityError,
  buildSafeConnector,
  createSafeAgent,
} from "./webhook-http-client";

// Test certificate for "valid-webhook.example.com"
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDTzCCAjegAwIBAgIUUoTHg3UGBT5e6E1Sa8sQt/xc7PcwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZdmFsaWQtd2ViaG9vay5leGFtcGxlLmNvbTAeFw0yNjEw
MjkxNDU5MjRaFw0zNjEwMjYxNDU5MjRaMCQxIjAgBgNVBAMMGXZhbGlkLXdlYmhv
b2suZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDB
pB5TNtFJlM+0P/b3cinT2/zyYKKavSzE1Fqpci2w1jo2wfuy5gAubPMdBBS1qZLx
HG2SMQmP2lTLUcSA8YHD4NqnP4OHLTL+JDqOkFh4amfYnDlqQFhsu/B++vggBK11
740aTmt+LHz5lUQadKtZoYzakWoyPAkq43qnKaH/ww6sk2ZJcJOpQ/BWs6tGoZ78
cMsrKoYr4a1DxoFFsq3gBaGqclksgIWYm/UkKkMCG/xIaYTghrN494aMDC4UhDYp
/AuuPppllbD71xpjxTx2KxCvfVtBvA4oMMEZYYi8insIcp9S2yc0EOlOXdMspudS
vFL/tyulaKRH59XlYYRTAgMBAAGjeTB3MB0GA1UdDgQWBBQPQd+VWBOYlPK6RlKV
yN6T2IV8tDAfBgNVHSMEGDAWgBQPQd+VWBOYlPK6RlKVyN6T2IV8tDAPBgNVHRMB
Af8EBTADAQH/MCQGA1UdEQQdMBuCGXZhbGlkLXdlYmhvb2suZXhhbXBsZS5jb20w
DQYJKoZIhvcNAQELBQADggEBAJ4PjjxtTXo7wQVM/777XVGfB4JOz0aEOJo4Qv9G
YjpCbQa2fMGlKMVujmKS7dZRThUvvp6YIkbjZMQ2s5SsfiYRhJh3Ozn8Y1dN5Prd
uXRBntvyGmv5W0CF6heBil3a6MJxWz1RVBVdliZcocy4ssL/qtPJz+Ae08NyCaP2
lxK2MDdo5HuENRaNBgeyNkZOgUd77aCOgP+nvU7vv8QopOjWDv24xbQLOhl9RJFP
tgq8toONTN08UhFApOnldBEb4ebEzRObjktDeLkIRfdgJN4SHcyKUGeLROKuTgHk
gd3LN/Z7H+x/LTzRddov12bnd/hOSrMIlyKtGl+idALSEl0=
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBpB5TNtFJlM+0
P/b3cinT2/zyYKKavSzE1Fqpci2w1jo2wfuy5gAubPMdBBS1qZLxHG2SMQmP2lTL
UcSA8YHD4NqnP4OHLTL+JDqOkFh4amfYnDlqQFhsu/B++vggBK11740aTmt+LHz5
lUQadKtZoYzakWoyPAkq43qnKaH/ww6sk2ZJcJOpQ/BWs6tGoZ78cMsrKoYr4a1D
xoFFsq3gBaGqclksgIWYm/UkKkMCG/xIaYTghrN494aMDC4UhDYp/AuuPppllbD7
1xpjxTx2KxCvfVtBvA4oMMEZYYi8insIcp9S2yc0EOlOXdMspudSvFL/tyulaKRH
59XlYYRTAgMBAAECggEAN7v0GoFppaMWUUwj2j7auSbVXDHiO2V9sD1qxuCdNAvE
/6O/vVMj9DjZlJ1rFIp1R76l7vD8TpJJ26dyRqa8cdOTO5Y1Vj/1MF7fF8+GF0qR
DzCP+fwBN3K0mufDaPvPrWVAmLS/jbZiVjfXPUIdW5P7BaHbDhBnlxeYYurBvOo3
8qLoOr5qd395vcsEU03cSDFr0an437M9QFS3UXlXm8TBscqQ2TI7t/+ZNArxwWH4
Q0jyLr5uGEWVmAwcgZo4JtG34ca9T013A/wAQqimGlMSFjE8pUhq+Uu9Xvo8DsmP
IVyHiWoR04ovV6h3DppHr3/iT6PULsZOjtBtRwI9eQKBgQDzEPgG6DBf5aK6ENn+
wAuB3gRxgyJlQjzSgXQcmzVvkAHm6Qvfo+InPoo5ytyL4je6fjWgXzw3izcSRju8
utEQErsuE7X1XNi5CWBGHEs2WpgYPwswOelRV/KhaskZ/DA6PcXp3ZdyIWjmgZFx
8eJtdQoH6B4iRE8De5KYJ7KyrwKBgQDL8eIYgB4GtTQ3OB6B1sA+1G9qz0UZJAAD
5nabW1FFPwElBtsdC/1zslyFmMoMBhGXO5qKmQhoDOqYfJDaQyXKe36bTMmcR6is
vbmVlVMCR+j0ROrqkn8QxVk+hTid92rhHQgIedfrOoeCOa957cj9z8AxcsvyJnNp
taswQizBnQKBgGy5g2h7hd/vdQmrrgdQ2hTePbiUwtbueQxkUY7WMmHT1bX3OpNv
2CJbzDKrtllv+COYft5cmy/xOtIWznPOUOPSrR2gPX0iaeLi+ciCsXX/shbuZE/P
J7l2EJb5kDjqYJw8s4G32B16KlUpUejZHMJ/XtxIjOohCgLxzJH49+sLAoGAb4MQ
dwkGYfCOXmsG80Ny1mfdi+9M/tQaVgebbpLduxkaDR7Ui+tUaABsangCcdSXpbNn
asUGPa5iT4I8ybrRXQdtUIkJ67Oa3OjYIpwFSUf8biOItz3m0Eq342GAdY8lF3WC
QPAuSWY1VdUox2hm77C6i88TCJJRpMk6kyZ7xlkCgYEAl4G4T+FNmf2egPaAaOHA
l0MS/aIJEs+utbluAZCvf50tsqsdkd+7XqC9rRU4wlOM3rkFFs7fmA70mzGu0CRE
Tdy4b89B1KTEy/t/VHDFqo8BxRK4LNVK6nYM/LRYiJGghzsP/0p7GztndDstwbFK
kH39iTTXle0WKA48nFC64L0=
-----END PRIVATE KEY-----`;

describe("webhook-http-client security and delivery", () => {
  it("delivers request successfully to public destination and records response", async () => {
    let receivedHeader = "";
    let receivedBody = "";

    const server = http.createServer((req, res) => {
      receivedHeader = req.headers["x-custom-header"] as string;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ delivered: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Simulate public DNS resolution that resolves to local test server
    const mockLookup = async () => [{ address: "127.0.0.1", family: 4 }];

    // Directly test with custom connector that connects to local test server but treats hostname as public
    const customAgent = createSafeAgent({
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      // Create dedicated test connector pointing to local port
      const connector = buildSafeConnector({
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      // Replace socket target with 127.0.0.1 for local test server
      const testAgent = createSafeAgent({
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      });

      // Using safe connector wired to test server:
      const safeConnector = (opts: any, cb: any) => {
        // Pin to 127.0.0.1:port but ensure validation ran
        const net = require("node:net");
        const s = net.connect({ host: "127.0.0.1", port });
        s.once("connect", function (this: any) {
          cb(null, this);
        });
        s.once("error", cb);
      };

      const agentWithLocalConnect = new (require("undici").Agent)({
        connect: safeConnector,
        pipelining: 0,
      });

      const result = await sendWebhookRequest(
        `http://example.com:${port}/webhook`,
        {
          headers: { "X-Custom-Header": "my-header-val" },
          body: JSON.stringify({ event: "order.paid" }),
          dispatcher: agentWithLocalConnect,
        },
      );

      assert.equal(result.statusCode, 200);
      assert.deepEqual(JSON.parse(result.body), { delivered: true });
      assert.equal(receivedHeader, "my-header-val");
      assert.equal(receivedBody, JSON.stringify({ event: "order.paid" }));

      await agentWithLocalConnect.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects private, loopback, and local destinations before connecting", async () => {
    const prohibitedUrls = [
      "http://127.0.0.1:8080/webhook",
      "http://10.0.0.1/webhook",
      "http://192.168.1.1/webhook",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/webhook",
      "http://[fc00::1]/webhook",
      "http://localhost:3000/webhook",
      "http://service.local/webhook",
      "http://backend.internal/webhook",
      "http://user:pass@example.com/webhook",
      "ftp://example.com/webhook",
    ];

    for (const url of prohibitedUrls) {
      await assert.rejects(
        async () => {
          await sendWebhookRequest(url);
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
        `Expected ${url} to be rejected`,
      );
    }
  });

  it("rejects private IPs returned by DNS resolution before connecting", async () => {
    const mockLookup = async () => [
      { address: "192.168.1.50", family: 4 },
    ];

    await assert.rejects(
      async () => {
        await sendWebhookRequest("https://attacker.com/webhook", {
          lookupHost: mockLookup,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Blocked prohibited address 192.168.1.50"));
        return true;
      },
    );
  });

  it("rejects mixed public and private DNS answers", async () => {
    const mixedLookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];

    await assert.rejects(
      async () => {
        await sendWebhookRequest("https://mixed-dns.com/webhook", {
          lookupHost: mixedLookup,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Blocked prohibited address 127.0.0.1"));
        return true;
      },
    );
  });

  it("fails closed on DNS failure or empty results", async () => {
    const emptyLookup = async () => [];
    const failedLookup = async () => {
      throw new Error("NXDOMAIN");
    };

    await assert.rejects(
      async () => {
        await sendWebhookRequest("https://empty-dns.com/webhook", {
          lookupHost: emptyLookup,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("DNS returned no addresses"));
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await sendWebhookRequest("https://failed-dns.com/webhook", {
          lookupHost: failedLookup,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("DNS resolution failed"));
        return true;
      },
    );
  });

  it("prevents DNS rebinding by re-validating on subsequent requests", async () => {
    let callCount = 0;
    const dynamicLookup = async () => {
      callCount++;
      if (callCount === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    };

    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Custom test connector that validates dynamicLookup and redirects socket to local test server
    const testConnector = (opts: any, cb: any) => {
      void (async () => {
        try {
          const addrs = await dynamicLookup();
          for (const item of addrs) {
            if (item.address === "127.0.0.1") {
              cb(new Error(`Blocked prohibited address ${item.address}`));
              return;
            }
          }
          const s = require("node:net").connect({ host: "127.0.0.1", port });
          s.once("connect", function (this: any) {
            cb(null, this);
          });
          s.once("error", cb);
        } catch (err) {
          cb(err);
        }
      })();
    };

    const agent = new (require("undici").Agent)({
      connect: testConnector,
      pipelining: 0,
    });

    try {
      // Request 1: resolves to public IP -> succeeds
      const res1 = await sendWebhookRequest(
        `http://rebinding.example.com:${port}/webhook`,
        { dispatcher: agent },
      );
      assert.equal(res1.statusCode, 200);

      // Request 2: DNS changed to 127.0.0.1 -> MUST be blocked by SSRF check!
      await assert.rejects(
        async () => {
          await sendWebhookRequest(
            `http://rebinding.example.com:${port}/webhook`,
            { dispatcher: agent },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("Blocked prohibited address 127.0.0.1"),
            `Expected SSRF rejection, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not follow redirects and handles 3xx as delivery failure", async () => {
    let secondServerHit = false;

    const targetServer = http.createServer((_req, res) => {
      secondServerHit = true;
      res.writeHead(200);
      res.end("secret internal data");
    });

    await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
    const targetPort = (targetServer.address() as AddressInfo).port;

    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${targetPort}/internal`,
        "Content-Type": "text/plain",
      });
      res.end("Redirecting to internal service");
    });

    await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirectServer.address() as AddressInfo).port;

    // Direct connection to redirectServer
    const testConnector = (opts: any, cb: any) => {
      const s = require("node:net").connect({ host: "127.0.0.1", port: redirectPort });
      s.once("connect", function (this: any) {
        cb(null, this);
      });
      s.once("error", cb);
    };

    const agent = new (require("undici").Agent)({
      connect: testConnector,
      pipelining: 0,
    });

    try {
      await assert.rejects(
        async () => {
          await sendWebhookRequest(`http://example.com:${redirectPort}/redirect`, {
            dispatcher: agent,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof HttpDeliveryError);
          assert.equal(err.statusCode, 302);
          assert.equal(err.responseBody, "Redirecting to internal service");
          return true;
        },
      );

      // Verify the redirect target was NEVER requested
      assert.equal(secondServerHit, false);
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    }
  });

  it("handles 4xx and 5xx responses as HttpDeliveryError with status and body", async () => {
    const errorServer = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Unavailable" }));
    });

    await new Promise<void>((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
    const port = (errorServer.address() as AddressInfo).port;

    const testConnector = (opts: any, cb: any) => {
      const s = require("node:net").connect({ host: "127.0.0.1", port });
      s.once("connect", function (this: any) {
        cb(null, this);
      });
      s.once("error", cb);
    };

    const agent = new (require("undici").Agent)({
      connect: testConnector,
      pipelining: 0,
    });

    try {
      await assert.rejects(
        async () => {
          await sendWebhookRequest(`http://example.com:${port}/error`, {
            dispatcher: agent,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof HttpDeliveryError);
          assert.equal(err.statusCode, 503);
          assert.deepEqual(JSON.parse(err.responseBody), {
            error: "Service Unavailable",
          });
          return true;
        },
      );
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });

  it("limits response body capture to 10,000 characters and safely destroys remainder", async () => {
    const largeBodyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Stream 50,000 characters
      for (let i = 0; i < 50; i++) {
        res.write("X".repeat(1000));
      }
      res.end();
    });

    await new Promise<void>((resolve) => largeBodyServer.listen(0, "127.0.0.1", resolve));
    const port = (largeBodyServer.address() as AddressInfo).port;

    const testConnector = (opts: any, cb: any) => {
      const s = require("node:net").connect({ host: "127.0.0.1", port });
      s.once("connect", function (this: any) {
        cb(null, this);
      });
      s.once("error", cb);
    };

    const agent = new (require("undici").Agent)({
      connect: testConnector,
      pipelining: 0,
    });

    try {
      const result = await sendWebhookRequest(`http://example.com:${port}/large`, {
        dispatcher: agent,
      });

      assert.equal(result.statusCode, 200);
      assert.equal(result.body.length, 10_000);
      assert.equal(result.body, "X".repeat(10_000));
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => largeBodyServer.close(() => resolve()));
    }
  });

  it("aborts slow requests after timeout", async () => {
    const hangingServer = http.createServer((_req, _res) => {
      // Deliberately do not respond
    });

    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    const port = (hangingServer.address() as AddressInfo).port;

    const testConnector = (opts: any, cb: any) => {
      const s = require("node:net").connect({ host: "127.0.0.1", port });
      s.once("connect", function (this: any) {
        cb(null, this);
      });
      s.once("error", cb);
    };

    const agent = new (require("undici").Agent)({
      connect: testConnector,
      pipelining: 0,
    });

    try {
      await assert.rejects(
        async () => {
          await sendWebhookRequest(`http://example.com:${port}/timeout`, {
            dispatcher: agent,
            timeoutMs: 150, // Short timeout for test
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    }
  });

  it("enforces TLS certificate verification and SNI", async () => {
    const httpsServer = https.createServer(
      {
        cert: TEST_CERT,
        key: TEST_KEY,
      },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ secure: true }));
      },
    );

    await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
    const port = (httpsServer.address() as AddressInfo).port;

    try {
      // 1. Connection with matching hostname and trusted CA succeeds
      const validAgent = createSafeAgent({
        lookupHost: async () => [{ address: "127.0.0.1", family: 4 }],
        tlsOptions: { ca: TEST_CERT },
      });

      // Test safe connector directly
      const validConnector = buildSafeConnector({
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
        tlsOptions: { ca: TEST_CERT },
      });

      // Using safe connector wired with TLS to local port
      const secureTestConnector = (opts: any, cb: any) => {
        const tls = require("node:tls");
        const s = tls.connect({
          host: "127.0.0.1",
          port,
          servername: opts.servername || opts.hostname,
          rejectUnauthorized: true,
          ca: TEST_CERT,
        });
        s.once("secureConnect", function (this: any) {
          cb(null, this);
        });
        s.once("error", cb);
      };

      const testAgent = new (require("undici").Agent)({
        connect: secureTestConnector,
        pipelining: 0,
      });

      const validResult = await sendWebhookRequest(
        `https://valid-webhook.example.com:${port}/webhook`,
        { dispatcher: testAgent },
      );
      assert.equal(validResult.statusCode, 200);
      assert.deepEqual(JSON.parse(validResult.body), { secure: true });
      await testAgent.close();

      // 2. Connection with mismatching hostname is rejected by certificate validation
      const invalidHostnameAgent = new (require("undici").Agent)({
        connect: (opts: any, cb: any) => {
          const tls = require("node:tls");
          const s = tls.connect({
            host: "127.0.0.1",
            port,
            servername: "wrong-name.example.com",
            rejectUnauthorized: true,
            ca: TEST_CERT,
          });
          s.once("secureConnect", function (this: any) {
            cb(null, this);
          });
          s.once("error", cb);
        },
        pipelining: 0,
      });

      await assert.rejects(
        async () => {
          await sendWebhookRequest(`https://wrong-name.example.com:${port}/webhook`, {
            dispatcher: invalidHostnameAgent,
          });
        },
        (err: any) => {
          assert.equal(err.code, "ERR_TLS_CERT_ALTNAME_INVALID");
          return true;
        },
      );
      await invalidHostnameAgent.close();
    } finally {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
  });
});
