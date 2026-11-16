import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from './services.ts';
import { DEFAULT_SERVERS, localServer, parsePort, parseServer, parseServers, readPortInput, readServerInput, serverChoices, serverLabel, thisPc, withCurrent, withLocalPort, withServers, withoutServer } from './streamroom.ts';

const LOCAL = 'http://localhost:8080';

test('an address is kept as its origin: https anywhere, plain http only on this PC', () => {
  assert.equal(parseServer('https://rooms.example.org'), 'https://rooms.example.org');
  assert.equal(parseServer(' https://Rooms.Example.org/r/abc123#key '), 'https://rooms.example.org', 'a room link gives its server');
  assert.equal(parseServer('streamroom.someone.workers.dev'), 'https://streamroom.someone.workers.dev', 'no scheme means https');
  assert.equal(parseServer('pc.tail1234.ts.net:8443'), 'https://pc.tail1234.ts.net:8443');
  assert.equal(parseServer('localhost:8090'), 'http://localhost:8090', 'no scheme on this PC means http');
  assert.equal(parseServer('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(parseServer('http://[::1]:8080'), 'http://[::1]:8080');
  for (const bad of ['', '   ', 'ftp://rooms.example.org', 'rooms example.org', 42]) assert.equal(parseServer(bad), undefined, String(bad));
  assert.equal(parseServer('http://rooms.example.org'), undefined);
  assert.equal(parseServer('http://192.168.1.20:8080'), undefined);
  assert.equal(parseServer('javascript:alert(1)'), undefined);
  assert.equal(parseServer('https://user:pass@rooms.example.org'), undefined);
  assert.equal(parseServer('localhost.evil.com'), 'https://localhost.evil.com', 'only localhost itself is this PC');
});

test('the Add window reads back what will open, or says why it cannot', () => {
  assert.equal(readServerInput('  '), undefined);
  assert.deepEqual(readServerInput('rooms.example.org'), { origin: 'https://rooms.example.org' });
  assert.match((readServerInput('http://192.168.1.20:8080') as { problem: string }).problem, /only works for a server on this PC/);
  assert.match((readServerInput('ftp://rooms.example.org') as { problem: string }).problem, /https/);
  assert.match((readServerInput('not an address') as { problem: string }).problem, /such as/);
});

test('choosing, adding and forgetting servers', () => {
  const cloud = 'https://rooms.example.org';
  const tail = 'https://pc.tail1234.ts.net';
  assert.equal(thisPc(DEFAULT_SERVERS), LOCAL);
  const one = withCurrent(DEFAULT_SERVERS, cloud);
  assert.deepEqual(one, { current: cloud, saved: [cloud], localPort: 8080 });
  const two = withCurrent(one, tail);
  assert.deepEqual(two, { current: tail, saved: [cloud, tail], localPort: 8080 });
  assert.deepEqual(withCurrent(two, cloud).saved, [cloud, tail], 'choosing a saved one keeps the order');
  assert.deepEqual(withCurrent(two, LOCAL), { current: LOCAL, saved: [cloud, tail], localPort: 8080 }, 'this PC is never saved');
  assert.deepEqual(serverChoices(two), [LOCAL, cloud, tail]);
  assert.deepEqual(withoutServer(two, tail), { current: LOCAL, saved: [cloud], localPort: 8080 }, 'forgetting the current one goes back to this PC');
  assert.deepEqual(withoutServer(two, cloud), { current: tail, saved: [tail], localPort: 8080 });
  assert.equal(serverLabel(LOCAL, two), 'This PC (localhost:8080)');
  assert.equal(serverLabel('https://pc.tail1234.ts.net:8443', two), 'pc.tail1234.ts.net:8443');
});

test("this PC's port: read, saved, and followed by the tab when it is on this PC", () => {
  assert.equal(parsePort('8090'), 8090);
  assert.equal(parsePort(' 443 '), 443);
  assert.equal(parsePort(65535), 65535);
  for (const bad of ['', '0', '65536', '80a', '-1', '8.5', 'eighty', 8080.5, undefined]) assert.equal(parsePort(bad), undefined, String(bad));
  assert.deepEqual(readPortInput('8090'), { origin: 'http://localhost:8090' });
  assert.deepEqual(readPortInput('80'), { origin: 'http://localhost' }, 'port 80 drops out of the origin');
  assert.equal(readPortInput(' '), undefined);
  assert.match((readPortInput('99999') as { problem: string }).problem, /1 to 65535/);
  assert.equal(localServer(8090), 'http://localhost:8090');

  const onPc = withLocalPort(DEFAULT_SERVERS, 8090);
  assert.deepEqual(onPc, { current: 'http://localhost:8090', saved: [], localPort: 8090 }, 'the tab on this PC follows the port');
  assert.equal(serverLabel(thisPc(onPc), onPc), 'This PC (localhost:8090)');
  const cloud = withCurrent(DEFAULT_SERVERS, 'https://rooms.example.org');
  assert.deepEqual(withLocalPort(cloud, 8090), { current: 'https://rooms.example.org', saved: ['https://rooms.example.org'], localPort: 8090 }, 'a tab elsewhere stays there');
  const added = withCurrent(cloud, 'http://localhost:8090');
  assert.deepEqual(withLocalPort(added, 8090), { current: 'http://localhost:8090', saved: ['https://rooms.example.org'], localPort: 8090 }, 'an added address on that port becomes This PC');

  assert.deepEqual(parseServers({ current: 'http://localhost:8090', saved: [], localPort: '8090' }), { current: 'http://localhost:8090', saved: [], localPort: 8090 });
  assert.deepEqual(parseServers({ current: 'http://localhost:8090', localPort: 'x' }), { current: 'http://localhost:8090', saved: ['http://localhost:8090'], localPort: 8080 }, 'a bad port falls back, keeping the address');
});

test('the Streamroom tab opens the current server and owns every saved server, this PC only while chosen', () => {
  const room = findService('streamroom')!;
  const cloud = withServers(room, { current: 'https://rooms.example.org', saved: ['https://rooms.example.org', 'https://pc.tail1234.ts.net'], localPort: 8080 });
  assert.equal(cloud.url, 'https://rooms.example.org/');
  assert.deepEqual(cloud.hosts, ['rooms.example.org', 'pc.tail1234.ts.net']);
  const local = withServers(room, { current: LOCAL, saved: ['https://rooms.example.org'], localPort: 8080 });
  assert.equal(local.url, 'http://localhost:8080/');
  assert.deepEqual(local.hosts, ['localhost', 'rooms.example.org']);
  assert.equal(cloud.id, room.id);
  assert.equal(cloud.calls, true);
});
