import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callTab } from './call-tab.ts';

test('nothing to open without a call', () => {
  assert.equal(callTab([{ id: 'messenger', phase: undefined }, { id: 'inbox', phase: undefined }]), undefined);
  assert.equal(callTab([]), undefined);
});

test('the tab with the call opens, ringing or connected', () => {
  assert.equal(callTab([{ id: 'discord', phase: undefined }, { id: 'messenger', phase: 'ringing' }, { id: 'inbox', phase: undefined }]), 'messenger');
  assert.equal(callTab([{ id: 'discord', phase: 'call' }, { id: 'inbox', phase: undefined }]), 'discord');
  assert.equal(callTab([{ id: 'discord', phase: undefined }, { id: 'inbox', phase: 'call' }]), 'inbox');
});

test('a call ringing comes before one already connected', () => {
  assert.equal(callTab([{ id: 'discord', phase: 'call' }, { id: 'inbox', phase: 'ringing' }]), 'inbox');
});

test('among calls alike, the first listed wins', () => {
  // An older phone app rings for a Messenger call too, as an unknown number: listed after the websites.
  assert.equal(callTab([{ id: 'messenger', phase: 'ringing' }, { id: 'inbox', phase: 'ringing' }]), 'messenger');
});
