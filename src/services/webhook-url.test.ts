import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateWebhookUrl,
  isPublicIpv4,
  isPublicIpv6,
  isPublicIp,
  isLocalHostname,
} from "./webhook-url";

const publicDns = async () => [
  { address: "93.184.216.34", family: 4 },
];

const privateDns = async () => [
  { address: "192.168.1.10", family: 4 },
];

describe("validateWebhookUrl", () => {
  it("accepts public HTTP and HTTPS hostnames", async () => {
    assert.equal(
      await validateWebhookUrl("https://example.com/webhook", publicDns),
      true,
    );
    assert.equal(
      await validateWebhookUrl("http://example.com/webhook", publicDns),
      true,
    );
  });

  it("rejects invalid URLs and unsupported protocols", async () => {
    assert.equal(await validateWebhookUrl("not-a-url", publicDns), false);
    assert.equal(
      await validateWebhookUrl("ftp://example.com/file", publicDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("file:///etc/passwd", publicDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("gopher://example.com/resource", publicDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("ws://example.com/socket", publicDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("wss://example.com/socket", publicDns),
      false,
    );
  });

  it("rejects localhost and local-only hostnames", async () => {
    const localHostnames = [
      "http://localhost/webhook",
      "http://LOCALHOST/webhook",
      "http://api.localhost/webhook",
      "http://service.local/webhook",
      "http://backend.internal/webhook",
      "http://service.lan/webhook",
      "http://router.home.arpa/webhook",
      "http://intranet.corp/webhook",
      "http://router/webhook", // single-label
      "http://metadata/webhook", // single-label
    ];

    for (const url of localHostnames) {
      assert.equal(
        await validateWebhookUrl(url, publicDns),
        false,
        `Expected ${url} to be rejected`,
      );
    }
  });

  it("rejects embedded credentials", async () => {
    assert.equal(
      await validateWebhookUrl(
        "https://user:pass@example.com/webhook",
        publicDns,
      ),
      false,
    );
    assert.equal(
      await validateWebhookUrl(
        "https://admin@example.com/webhook",
        publicDns,
      ),
      false,
    );
  });

  it("rejects private and special IPv4 addresses", async () => {
    const blocked = [
      "0.0.0.0", // current network
      "0.255.255.255",
      "10.0.0.1", // RFC 1918
      "10.255.255.254",
      "100.64.0.1", // CGNAT RFC 6598
      "100.127.255.255",
      "127.0.0.1", // loopback
      "127.123.45.6",
      "169.254.169.254", // link-local
      "172.16.0.1", // RFC 1918
      "172.31.255.254",
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1 documentation
      "192.31.196.1", // AS112-v4
      "192.52.193.1", // AMT
      "192.88.99.1", // 6to4 relay anycast
      "192.168.1.1", // RFC 1918
      "198.18.0.1", // Benchmarking RFC 2544
      "198.19.255.254", // Benchmarking RFC 2544
      "198.51.100.1", // TEST-NET-2 documentation
      "203.0.113.1", // TEST-NET-3 documentation
      "224.0.0.1", // Multicast
      "239.255.255.250", // Multicast
      "240.0.0.1", // Reserved for future use
      "255.255.255.255", // Limited broadcast
    ];

    for (const ip of blocked) {
      assert.equal(
        await validateWebhookUrl(`http://${ip}/webhook`, publicDns),
        false,
        `Expected ${ip} to be rejected`,
      );
    }
  });

  it("rejects unusual IPv4 representations (octal, hex, dword)", async () => {
    const unusualLoopback = [
      "http://0177.0.0.1/webhook", // octal
      "http://0177.1/webhook",
      "http://0x7f000001/webhook", // hex dword
      "http://0x7f.0.0.1/webhook", // hex octet
      "http://2130706433/webhook", // decimal dword
      "http://127.1/webhook", // 2-part dotted
      "http://127.0.1/webhook", // 3-part dotted
    ];

    for (const url of unusualLoopback) {
      assert.equal(
        await validateWebhookUrl(url, publicDns),
        false,
        `Expected ${url} to be rejected`,
      );
    }
  });

  it("rejects private IPv4 addresses returned by DNS", async () => {
    assert.equal(
      await validateWebhookUrl(
        "https://attacker.example/webhook",
        privateDns,
      ),
      false,
    );
  });

  it("rejects DNS results containing both public and private addresses", async () => {
    const mixedDns = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];

    assert.equal(
      await validateWebhookUrl("https://mixed.example/webhook", mixedDns),
      false,
    );
  });

  it("rejects DNS failures, empty results, and unexpected families", async () => {
    const failedDns = async (): Promise<
      { address: string; family: number }[]
    > => {
      throw new Error("DNS lookup failed");
    };

    const emptyDns = async () => [];

    const unexpectedFamilyDns = async () => [
      { address: "127.0.0.1", family: 1 },
    ];

    assert.equal(
      await validateWebhookUrl("https://missing.example/webhook", failedDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("https://empty.example/webhook", emptyDns),
      false,
    );
    assert.equal(
      await validateWebhookUrl("https://weird.example/webhook", unexpectedFamilyDns),
      false,
    );
  });

  it("rejects IPv6 loopback, unique-local, link-local, and special-purpose addresses", async () => {
    const blockedIpv6 = [
      "::1", // Loopback
      "::", // Unspecified
      "fe80::1", // Link-local
      "fc00::1", // Unique-local
      "fd00::1", // Unique-local
      "ff02::1", // Multicast
      "100::1", // Discard-only
      "2001:db8::1", // Documentation
      "2001:2::1", // Benchmarking
      "2001:10::1", // Deprecated ORCHID
      "2001:20::1", // ORCHIDv2
      "2001::1", // Teredo
      "2002:7f00:1::1", // 6to4
      "2001:4:112::1", // AS112-v6
    ];

    for (const ip of blockedIpv6) {
      assert.equal(
        await validateWebhookUrl(`http://[${ip}]/webhook`, publicDns),
        false,
        `Expected IPv6 ${ip} to be rejected`,
      );
    }
  });

  it("rejects private IPv4-mapped IPv6 addresses", async () => {
    const mappedLoopback = [
      "http://[::ffff:127.0.0.1]/webhook",
      "http://[::ffff:10.0.0.1]/webhook",
      "http://[::ffff:192.168.1.1]/webhook",
      "http://[::ffff:169.254.169.254]/webhook",
      "http://[::ffff:7f00:1]/webhook",
    ];

    for (const url of mappedLoopback) {
      assert.equal(
        await validateWebhookUrl(url, publicDns),
        false,
        `Expected ${url} to be rejected`,
      );
    }
  });

  it("accepts legitimate public IP addresses (IPv4, IPv6, and IPv4-mapped IPv6)", async () => {
    assert.equal(
      await validateWebhookUrl("https://8.8.8.8/webhook", publicDns),
      true,
    );
    assert.equal(
      await validateWebhookUrl("https://1.1.1.1/webhook", publicDns),
      true,
    );
    assert.equal(
      await validateWebhookUrl(
        "https://[2606:4700:4700::1111]/webhook",
        publicDns,
      ),
      true,
    );
    assert.equal(
      await validateWebhookUrl(
        "https://[2001:4860:4860::8888]/webhook",
        publicDns,
      ),
      true,
    );
    assert.equal(
      await validateWebhookUrl(
        "https://[::ffff:8.8.8.8]/webhook",
        publicDns,
      ),
      true,
    );
  });
});

describe("IP address classification helpers", () => {
  it("classifies IPv4 ranges accurately", () => {
    assert.equal(isPublicIpv4("8.8.8.8"), true);
    assert.equal(isPublicIpv4("93.184.216.34"), true);
    assert.equal(isPublicIpv4("192.0.2.1"), false); // TEST-NET-1
    assert.equal(isPublicIpv4("198.18.0.1"), false); // Benchmarking
    assert.equal(isPublicIpv4("198.51.100.1"), false); // TEST-NET-2
    assert.equal(isPublicIpv4("203.0.113.1"), false); // TEST-NET-3
    assert.equal(isPublicIpv4("169.254.169.254"), false); // Link local
    assert.equal(isPublicIpv4("240.0.0.1"), false); // Reserved
    assert.equal(isPublicIpv4("255.255.255.255"), false); // Broadcast
    assert.equal(isPublicIpv4("not-an-ip"), false);
  });

  it("classifies IPv6 ranges accurately", () => {
    assert.equal(isPublicIpv6("2606:4700:4700::1111"), true);
    assert.equal(isPublicIpv6("2001:4860:4860::8888"), true);
    assert.equal(isPublicIpv6("::1"), false);
    assert.equal(isPublicIpv6("fe80::1"), false);
    assert.equal(isPublicIpv6("fc00::1"), false);
    assert.equal(isPublicIpv6("2001:db8::1"), false);
    assert.equal(isPublicIpv6("2001:2::1"), false);
    assert.equal(isPublicIpv6("2002::1"), false);
    assert.equal(isPublicIpv6("::ffff:8.8.8.8"), true);
    assert.equal(isPublicIpv6("::ffff:127.0.0.1"), false);
    assert.equal(isPublicIpv6("not-an-ip"), false);
  });

  it("classifies raw IP strings and hostnames", () => {
    assert.equal(isPublicIp("8.8.8.8"), true);
    assert.equal(isPublicIp("127.0.0.1"), false);
    assert.equal(isPublicIp("2606:4700:4700::1111"), true);
    assert.equal(isPublicIp("::1"), false);
    assert.equal(isPublicIp("invalid"), false);

    assert.equal(isLocalHostname("localhost"), true);
    assert.equal(isLocalHostname("app.local"), true);
    assert.equal(isLocalHostname("api.internal"), true);
    assert.equal(isLocalHostname("host.lan"), true);
    assert.equal(isLocalHostname("example.test"), true);
    assert.equal(isLocalHostname("myservice"), true); // single label
    assert.equal(isLocalHostname("api.example.com"), false);
  });
});


describe("IP address classification helpers", () => {
  it("classifies IPv4 ranges accurately", () => {
    assert.equal(isPublicIpv4("8.8.8.8"), true);
    assert.equal(isPublicIpv4("93.184.216.34"), true);
    assert.equal(isPublicIpv4("192.0.2.1"), false); // TEST-NET-1
    assert.equal(isPublicIpv4("198.18.0.1"), false); // Benchmarking
    assert.equal(isPublicIpv4("198.51.100.1"), false); // TEST-NET-2
    assert.equal(isPublicIpv4("203.0.113.1"), false); // TEST-NET-3
    assert.equal(isPublicIpv4("169.254.169.254"), false); // Link local
    assert.equal(isPublicIpv4("240.0.0.1"), false); // Reserved
    assert.equal(isPublicIpv4("255.255.255.255"), false); // Broadcast
    assert.equal(isPublicIpv4("not-an-ip"), false);
  });

  it("classifies IPv6 ranges accurately", () => {
    assert.equal(isPublicIpv6("2606:4700:4700::1111"), true);
    assert.equal(isPublicIpv6("2001:4860:4860::8888"), true);
    assert.equal(isPublicIpv6("::1"), false);
    assert.equal(isPublicIpv6("fe80::1"), false);
    assert.equal(isPublicIpv6("fc00::1"), false);
    assert.equal(isPublicIpv6("2001:db8::1"), false);
    assert.equal(isPublicIpv6("2001:2::1"), false);
    assert.equal(isPublicIpv6("2002::1"), false);
    assert.equal(isPublicIpv6("::ffff:8.8.8.8"), true);
    assert.equal(isPublicIpv6("::ffff:127.0.0.1"), false);
    assert.equal(isPublicIpv6("not-an-ip"), false);
  });

  it("classifies raw IP strings and hostnames", () => {
    assert.equal(isPublicIp("8.8.8.8"), true);
    assert.equal(isPublicIp("127.0.0.1"), false);
    assert.equal(isPublicIp("2606:4700:4700::1111"), true);
    assert.equal(isPublicIp("::1"), false);
    assert.equal(isPublicIp("invalid"), false);

    assert.equal(isLocalHostname("localhost"), true);
    assert.equal(isLocalHostname("app.local"), true);
    assert.equal(isLocalHostname("api.internal"), true);
    assert.equal(isLocalHostname("host.lan"), true);
    assert.equal(isLocalHostname("example.test"), true);
    assert.equal(isLocalHostname("myservice"), true); // single label
    assert.equal(isLocalHostname("api.example.com"), false);
  });
});