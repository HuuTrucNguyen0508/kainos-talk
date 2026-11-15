import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeUserAgent } from './user-agent.ts';

test('matches stock Chrome on each platform, with no Electron or app token', () => {
  assert.equal(
    chromeUserAgent('linux', '156.0.8078.96'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  );
  assert.match(chromeUserAgent('win32', '156.0.1.2'), /\(Windows NT 10\.0; Win64; x64\).*Chrome\/156\.0\.0\.0 Safari/);
  assert.match(chromeUserAgent('darwin', '156.0.1.2'), /\(Macintosh; Intel Mac OS X 10_15_7\)/);
  assert.doesNotMatch(chromeUserAgent('linux', '156.0.8078.96'), /Electron|Kainos/i);
});
