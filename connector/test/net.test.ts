import { describe, expect, it } from "vitest";
import { isPrivateIPv4, lanCandidates, normalizeRemote } from "../src/server/net";

describe("isPrivateIPv4", () => {
  it.each([
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.20", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["127.0.0.1", false],
    ["8.8.8.8", false],
    ["100.64.0.1", false],
    ["169.254.1.1", false],
    ["192.168.1.256", false],
    ["::1", false],
    ["", false],
  ])("%s → %s", (ip, ok) => expect(isPrivateIPv4(ip)).toBe(ok));

  it("handles IPv6-mapped addresses", () => {
    expect(isPrivateIPv4(normalizeRemote("::ffff:192.168.0.5"))).toBe(true);
    expect(isPrivateIPv4(normalizeRemote("::ffff:8.8.8.8"))).toBe(false);
  });
});

describe("lanCandidates", () => {
  const info = (address: string, internal = false) => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  });

  it("skips virtual adapters, loopback and public addresses; prefers Wi-Fi", () => {
    const list = lanCandidates({
      "vEthernet (WSL)": [info("172.20.0.1")],
      "Loopback Pseudo-Interface 1": [info("127.0.0.1", true)],
      Tailscale: [info("100.100.1.1")],
      "Ethernet 3": [info("10.0.0.5")],
      "Wi-Fi": [info("192.168.1.42")],
      Public: [info("81.2.3.4")],
    });
    expect(list.map((c) => c.address)).toEqual(["192.168.1.42", "10.0.0.5"]);
  });
});
