import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbusBoolean } from './tray-host.ts';

test('reads the boolean from dbus-send --print-reply output', () => {
  assert.equal(dbusBoolean('method return time=1 sender=:1.1 -> destination=:1.9 serial=3 reply_serial=2\n   boolean true\n'), true);
  assert.equal(dbusBoolean('method return time=1 sender=:1.1\n   variant       boolean false\n'), false);
  assert.equal(dbusBoolean('method return time=1 sender=:1.1\n   variant       boolean true\n'), true);
  assert.equal(dbusBoolean(''), undefined);
  assert.equal(dbusBoolean('Error org.freedesktop.DBus.Error.ServiceUnknown: no such name'), undefined);
});
