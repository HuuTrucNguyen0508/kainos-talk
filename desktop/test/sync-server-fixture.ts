// The PC's real SMS sync server, driven over stdin/stdout by the phone's interop test
// (android/app/src/test/java/app/kainos/talk/sync/SyncInteropTest.kt).
//   argv: <port> <dir>        stdin: "accept" | "reply <key> <text>" | "read <key>" | "send <number> <text>"
//                                    | "drop" (ends every connection) | "traffic" | "state" | "quit"
//   stdout: "ready", then "state <json>" on every change (and on "state").
//   "traffic" prints `traffic {"in":{"conversation":2,…},"inBytes":n,"out":{…},"outBytes":n}`, the frames
//   and bytes (before TLS) each way since the last "traffic", then starts counting again.
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import tls from 'node:tls';
import { startSmsSync } from '../src/main/sms-sync.ts';

let traffic = { in: {} as Record<string, number>, inBytes: 0, out: {} as Record<string, number>, outBytes: 0 };
const sockets = new Set<tls.TLSSocket>();
const count = (frames: Record<string, number>, line: string) => {
  const type = (JSON.parse(line) as { t: string }).t;
  frames[type] = (frames[type] ?? 0) + 1;
  return Buffer.byteLength(line) + 1;
};
// Every connection the server accepts is watched here first; sms-sync.ts reads the same socket.
const createServer = tls.createServer;
tls.createServer = ((options: tls.TlsOptions, listener: (socket: tls.TLSSocket) => void) =>
  createServer(options, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        traffic.inBytes += count(traffic.in, buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    const write = socket.write.bind(socket) as (chunk: string) => boolean;
    socket.write = ((chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) traffic.outBytes += count(traffic.out, line);
      return write(chunk);
    }) as never;
    listener(socket);
  })) as typeof tls.createServer;
syncBuiltinESMExports();

const [port, dir] = process.argv.slice(2);
const sync = await startSmsSync({
  dir: dir!,
  port: Number(port),
  advertise: false,
  onChange: () => console.log(`state ${JSON.stringify(sync.state())}`),
  onIncoming: () => undefined,
});
console.log('ready');
for await (const line of createInterface({ input: process.stdin })) {
  const [command, key, ...rest] = line.split(' ');
  if (command === 'accept') sync.answerPairing(true);
  else if (command === 'reply') console.log(`replied ${sync.reply(key!, rest.join(' '))}`);
  else if (command === 'read') sync.markRead(key!);
  else if (command === 'send') console.log(`sent ${sync.send(key!, rest.join(' '))}`);
  else if (command === 'image') {
    const picture = await sync.image(key!);
    console.log(`image ${picture ? `data:image/jpeg;base64,${picture.toString('base64')}` : 'null'}`);
  } else if (command === 'state') console.log(`state ${JSON.stringify(sync.state())}`);
  else if (command === 'drop') for (const socket of sockets) socket.end();
  else if (command === 'traffic') {
    console.log(`traffic ${JSON.stringify(traffic)}`);
    traffic = { in: {}, inBytes: 0, out: {}, outBytes: 0 };
  } else if (command === 'quit') break;
}
await sync.stop();
process.exit(0);
