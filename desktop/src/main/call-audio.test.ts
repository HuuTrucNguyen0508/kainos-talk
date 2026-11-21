import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDSFREE_GATEWAY, failureOf, pickPhone, type BluetoothDevice } from './call-audio.ts';

const device = (name: string, more: Partial<BluetoothDevice> = {}): BluetoothDevice => ({
  path: `/org/bluez/hci0/dev_${name.replace(/\W/g, '_')}`,
  name,
  paired: true,
  connected: false,
  uuids: [HANDSFREE_GATEWAY],
  ...more,
});

test('the phone Kainos is paired with wins, though its Bluetooth name is shorter', () => {
  const pixel = device('Pixel 8');
  const other = device('Galaxy S24', { connected: true });
  assert.equal(pickPhone([other, pixel], 'Google Pixel 8'), pixel);
});

test('a phone that gives only its model code still finds its Bluetooth self', () => {
  // Kainos knows the phone by its maker and model code, Bluetooth by the name the owner sees.
  const galaxy = device('Galaxy S24');
  const earbuds = device('Buds', { uuids: ['0000110b-0000-1000-8000-00805f9b34fb'], connected: true });
  assert.equal(pickPhone([earbuds, galaxy], 'samsung SM-S921B'), galaxy);
});

test('headphones and unpaired phones are never connected for calls', () => {
  const earbuds = device('Buds', { uuids: ['0000111e-0000-1000-8000-00805f9b34fb'] });
  const stranger = device('Galaxy S24', { paired: false });
  assert.equal(pickPhone([earbuds, stranger], 'samsung Galaxy S24'), undefined);
});

test('with no name match, a connected phone comes before the others', () => {
  const idle = device('Old phone');
  const live = device('Work phone', { connected: true });
  assert.equal(pickPhone([idle, live], 'Samsung Galaxy'), live);
  assert.equal(pickPhone([idle], undefined), idle);
});

test('BlueZ errors read as what happened to the sound', () => {
  assert.equal(failureOf('org.bluez.Error.AlreadyConnected'), 'connected');
  assert.equal(failureOf('org.bluez.Error.InProgress'), 'connecting');
  assert.equal(failureOf('org.bluez.Error.NotReady'), 'pc-off');
  // Phone's Bluetooth off or out of range: "Host is down", "Page Timeout".
  assert.equal(failureOf('org.bluez.Error.Failed'), 'unreachable');
  assert.equal(failureOf(undefined), 'unreachable');
});
