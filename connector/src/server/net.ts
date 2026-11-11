/**
 * LAN interface selection and private-address checks.
 */

import os from "node:os";

/** Adapter names that are virtual / VPN / overlay networks, never the home Wi-Fi. */
const VIRTUAL_ADAPTER =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vboxnet|Docker|Loopback|ZeroTier|Tailscale|Hamachi|Radmin|TAP-|OpenVPN|WireGuard|NordLynx|Bluetooth/i;
const PREFERRED_ADAPTER = /Wi-?Fi|WLAN|Wireless|Ethernet/i;

export function parseIPv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Strips the IPv6-mapped prefix (::ffff:192.168.1.5 → 192.168.1.5). */
export function normalizeRemote(addr: string | undefined): string {
  if (!addr) return "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/** RFC 1918 private IPv4 (10/8, 172.16/12, 192.168/16). */
export function isPrivateIPv4(ip: string): boolean {
  const p = parseIPv4(ip);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface LanCandidate {
  name: string;
  address: string;
  netmask: string;
}

export function lanCandidates(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_ADAPTER.test(name)) continue;
    for (const info of list) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!isPrivateIPv4(info.address)) continue;
      out.push({ name, address: info.address, netmask: info.netmask });
    }
  }
  // Prefer real Wi-Fi/Ethernet adapters, then 192.168.x over other ranges.
  const score = (c: LanCandidate) =>
    (PREFERRED_ADAPTER.test(c.name) ? 0 : 2) + (c.address.startsWith("192.168.") ? 0 : 1);
  return out.sort((a, b) => score(a) - score(b));
}
