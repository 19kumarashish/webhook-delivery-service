import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type ResolvedAddress = {
  address: string;
  family: number;
};

export type LookupHost = (
  hostname: string,
) => Promise<ResolvedAddress[]>;

export async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Prohibited IPv4 CIDR blocks according to IANA Special-Purpose Address Registry and RFCs:
 * - 0.0.0.0/8       - RFC 1122 Section 3.2.1.3 ("This host on this network")
 * - 10.0.0.0/8      - RFC 1918 (Private-Use)
 * - 100.64.0.0/10   - RFC 6598 (Shared Address Space / CGNAT)
 * - 127.0.0.0/8     - RFC 1122 Section 3.2.1.3 (Loopback)
 * - 169.254.0.0/16  - RFC 3927 (Link Local)
 * - 172.16.0.0/12   - RFC 1918 (Private-Use)
 * - 192.0.0.0/24    - RFC 6890 Section 2.1 (IETF Protocol Assignments)
 * - 192.0.2.0/24    - RFC 5737 (TEST-NET-1, documentation)
 * - 192.31.196.0/24 - RFC 7535 (AS112-v4)
 * - 192.52.193.0/24 - RFC 7450 (AMT / Automatic Multicast Tunneling)
 * - 192.88.99.0/24  - RFC 7526 (6to4 Relay Anycast - Deprecated)
 * - 192.168.0.0/16  - RFC 1918 (Private-Use)
 * - 198.18.0.0/15   - RFC 2544 (Benchmarking)
 * - 198.51.100.0/24 - RFC 5737 (TEST-NET-2, documentation)
 * - 203.0.113.0/24  - RFC 5737 (TEST-NET-3, documentation)
 * - 224.0.0.0/4     - RFC 5771 (Multicast)
 * - 240.0.0.0/4     - RFC 1112 Section 4 (Reserved for future use)
 * - 255.255.255.255/32 - RFC 919 Section 7 (Limited Broadcast)
 */
const BLOCKED_IPV4_CIDRS = [
  ipaddr.parseCIDR("0.0.0.0/8"),
  ipaddr.parseCIDR("10.0.0.0/8"),
  ipaddr.parseCIDR("100.64.0.0/10"),
  ipaddr.parseCIDR("127.0.0.0/8"),
  ipaddr.parseCIDR("169.254.0.0/16"),
  ipaddr.parseCIDR("172.16.0.0/12"),
  ipaddr.parseCIDR("192.0.0.0/24"),
  ipaddr.parseCIDR("192.0.2.0/24"),
  ipaddr.parseCIDR("192.31.196.0/24"),
  ipaddr.parseCIDR("192.52.193.0/24"),
  ipaddr.parseCIDR("192.88.99.0/24"),
  ipaddr.parseCIDR("192.168.0.0/16"),
  ipaddr.parseCIDR("198.18.0.0/15"),
  ipaddr.parseCIDR("198.51.100.0/24"),
  ipaddr.parseCIDR("203.0.113.0/24"),
  ipaddr.parseCIDR("224.0.0.0/4"),
  ipaddr.parseCIDR("240.0.0.0/4"),
  ipaddr.parseCIDR("255.255.255.255/32"),
];

/**
 * Global Unicast space in IPv6 according to RFC 4291 Section 2.4:
 * 2000::/3 covers 2000:: through 3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff.
 * Any IPv6 address outside 2000::/3 is non-global-unicast (e.g. ::1 loopback,
 * fe80::/10 link-local, fc00::/7 ULA, ff00::/8 multicast, etc.).
 */
const IPV6_GLOBAL_UNICAST_CIDR = ipaddr.parseCIDR("2000::/3");

/**
 * Prohibited special-purpose ranges within 2000::/3:
 * - 2001::/32      - RFC 4380 (Teredo tunneling)
 * - 2001:2::/48    - RFC 5180 (Benchmarking)
 * - 2001:3::/32    - RFC 7450 (AMT)
 * - 2001:4:112::/48- RFC 7535 (AS112-v6)
 * - 2001:5::/32    - RFC 7954 / RFC 9269 (LISP)
 * - 2001:10::/28   - RFC 4843 (Deprecated ORCHID)
 * - 2001:20::/28   - RFC 7343 (ORCHIDv2)
 * - 2001:db8::/32  - RFC 3849 (Documentation)
 * - 2002::/16      - RFC 3056 / RFC 7526 (6to4 Anycast Relay - Deprecated)
 */
const BLOCKED_IPV6_SPECIAL_CIDRS = [
  ipaddr.parseCIDR("2001::/32"),
  ipaddr.parseCIDR("2001:2::/48"),
  ipaddr.parseCIDR("2001:3::/32"),
  ipaddr.parseCIDR("2001:4:112::/48"),
  ipaddr.parseCIDR("2001:5::/32"),
  ipaddr.parseCIDR("2001:10::/28"),
  ipaddr.parseCIDR("2001:20::/28"),
  ipaddr.parseCIDR("2001:db8::/32"),
  ipaddr.parseCIDR("2002::/16"),
];

/**
 * Checks whether an IPv4 address is publicly routable and not in any
 * reserved, private, loopback, multicast, or special-purpose ranges.
 */
export function isPublicIpv4(host: string): boolean {
  let parsed: ipaddr.IPv4;
  try {
    const rawParsed = ipaddr.parse(host);
    if (rawParsed.kind() !== "ipv4") {
      return false;
    }
    parsed = rawParsed as ipaddr.IPv4;
  } catch {
    return false;
  }

  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if (parsed.match(cidr)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether an IPv6 address is in global unicast space (2000::/3) and not in
 * any special-purpose, documentation, benchmarking, or deprecated tunneling ranges.
 * IPv4-mapped IPv6 addresses (::ffff:0:0/96) are safely unmapped and validated as IPv4.
 */
export function isPublicIpv6(host: string): boolean {
  let parsed: ipaddr.IPv6;
  try {
    const rawParsed = ipaddr.parse(host);
    if (rawParsed.kind() !== "ipv6") {
      return false;
    }
    parsed = rawParsed as ipaddr.IPv6;
  } catch {
    return false;
  }

  // IPv4-mapped IPv6 addresses must be safely extracted and checked as IPv4.
  if (parsed.isIPv4MappedAddress()) {
    const v4 = parsed.toIPv4Address();
    for (const cidr of BLOCKED_IPV4_CIDRS) {
      if (v4.match(cidr)) {
        return false;
      }
    }
    return true;
  }

  // Only globally allocated unicast space (2000::/3).
  if (!parsed.match(IPV6_GLOBAL_UNICAST_CIDR)) {
    return false;
  }

  // Block special-purpose ranges within 2000::/3.
  for (const cidr of BLOCKED_IPV6_SPECIAL_CIDRS) {
    if (parsed.match(cidr)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether a raw IP address (v4 or v6) is public.
 */
export function isPublicIp(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    return isPublicIpv4(host);
  }
  if (version === 6) {
    return isPublicIpv6(host);
  }

  // Fallback to ipaddr.js parser for representations not recognized by net.isIP (e.g. integer or unbracketed mapped v6)
  try {
    const parsed = ipaddr.parse(host);
    if (parsed.kind() === "ipv4") {
      return isPublicIpv4(parsed.toString());
    }
    if (parsed.kind() === "ipv6") {
      return isPublicIpv6(parsed.toString());
    }
  } catch {
    return false;
  }

  return false;
}

const LOCAL_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".corp",
  ".intranet",
  ".private",
  ".test",
  ".example",
  ".invalid",
];

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (normalized === "localhost") {
    return true;
  }

  for (const suffix of LOCAL_HOSTNAME_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return true;
    }
  }

  // Reject single-label (unqualified) domain names that are not valid IP addresses.
  // Standard public webhooks must have a fully qualified domain name with at least one dot.
  if (!normalized.includes(".") && isIP(normalized) === 0) {
    return true;
  }

  return false;
}

/**
 * Validates that a webhook destination URL is an HTTP or HTTPS URL pointing
 * to a publicly routable destination and not a private, loopback, or special-purpose host.
 */
export async function validateWebhookUrl(
  value: string,
  lookupHost: LookupHost = defaultLookup,
): Promise<boolean> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  if (url.username || url.password) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!hostname || isLocalHostname(hostname)) {
    return false;
  }

  const ipVersion = isIP(hostname);

  if (ipVersion !== 0) {
    return ipVersion === 4
      ? isPublicIpv4(hostname)
      : isPublicIpv6(hostname);
  }

  // Attempt to parse as IP in case URL parser normalized it (e.g. hex/octal or dword IPv4)
  try {
    const ip = ipaddr.parse(hostname);
    return ip.kind() === "ipv4"
      ? isPublicIpv4(ip.toString())
      : isPublicIpv6(ip.toString());
  } catch {
    // Not an IP address literal; continue to DNS lookup.
  }

  try {
    const addresses = await lookupHost(hostname);

    // Fail closed if DNS returns no addresses.
    if (!addresses || addresses.length === 0) {
      return false;
    }

    // Fail closed if any returned address is non-public or unexpected family.
    return addresses.every(({ address, family }) => {
      if (family === 4) {
        return isPublicIpv4(address);
      }
      if (family === 6) {
        return isPublicIpv6(address);
      }
      return false;
    });
  } catch {
    return false;
  }
}
