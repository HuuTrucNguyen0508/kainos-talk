import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICES, partitionFor } from './services.ts';

test('registry has the inbox and four websites, with unique ids and https start pages', () => {
  assert.deepEqual(SERVICES.map((s) => s.id), ['inbox', 'proton-mail', 'discord', 'whatsapp', 'messenger']);
  for (const service of SERVICES.filter((s) => !s.localPage)) {
    const start = new URL(service.url);
    assert.equal(start.protocol, 'https:');
    assert.ok(service.hosts.includes(start.hostname), `${service.id} start page must be one of its hosts`);
  }
});

test('the phone texts page is the Texts service, drawn as a line icon among filled brand logos', () => {
  const texts = SERVICES[0]!;
  assert.deepEqual({ id: texts.id, name: texts.name, localPage: texts.localPage, paint: texts.icon.paint }, { id: 'inbox', name: 'Texts', localPage: 'inbox', paint: 'stroke' });
  assert.deepEqual(SERVICES.slice(1).map((s) => s.icon.paint), ['fill', 'fill', 'fill', 'fill']);
});

test('each service gets its own persistent login partition', () => {
  const partitions = SERVICES.map(partitionFor);
  assert.deepEqual(partitions, [
    'persist:service-inbox',
    'persist:service-proton-mail',
    'persist:service-discord',
    'persist:service-whatsapp',
    'persist:service-messenger',
  ]);
});

test('tile colours keep white glyphs at 3:1 contrast or better', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const service of SERVICES) {
    const ratio = 1.05 / (luminance(service.icon.color) + 0.05);
    assert.ok(ratio >= 3, `${service.id} contrast ${ratio.toFixed(2)}`);
  }
});
