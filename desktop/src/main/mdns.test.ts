import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { test } from 'node:test';
import { eligibleInterfaces } from './mdns.ts';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;

test('only real LAN interfaces are announced on, whatever Docker and VPNs add', () => {
  // This PC on 2026-11-14: Wi-Fi, Tailscale, Docker and two Docker bridges.
  const interfaces = {
    lo: [v4('127.0.0.1', true)],
    wlan0: [v4('192.168.1.20')],
    tailscale0: [v4('100.101.102.103')],
    docker0: [v4('172.17.0.1')],
    'br-21b184b03621': [v4('172.18.0.1')],
    'br-4430a9a38578': [v4('172.19.0.1')],
    veth57245e7: [],
  };
  assert.deepEqual(eligibleInterfaces(interfaces), ['wlan0']);
});

test('wired and Wi-Fi both count; a public or IPv6-only interface does not', () => {
  const interfaces = {
    wlan0: [v4('192.168.1.20')],
    enp5s0: [v4('10.0.0.4')],
    ppp0: [v4('81.2.69.160')],
    eth9: [{ address: 'fd00::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo],
  };
  assert.deepEqual(eligibleInterfaces(interfaces), ['enp5s0', 'wlan0']);
});

test('Tailscale is not announced on, whatever the system names its interface', () => {
  // Windows calls it "Tailscale"; the welcome hands its address to the phone instead.
  const interfaces = { 'Wi-Fi': [v4('192.168.1.20')], Tailscale: [v4('100.101.102.103')] };
  assert.deepEqual(eligibleInterfaces(interfaces), ['Wi-Fi']);
});
