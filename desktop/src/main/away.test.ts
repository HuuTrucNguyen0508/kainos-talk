import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { AwayMode } from '../shared/services.ts';
import { keepAway, type AwayPage } from './away.ts';

const SLEEP = 1_000;
const HIBERNATE = 60_000;

interface FakePage extends AwayPage {
  readonly id: string;
  mode: AwayMode;
  open: boolean;
  hidden: boolean;
  isBusy: boolean;
  loaded: boolean;
  hibernated: boolean;
  sleeping: boolean;
}

function page(id: string, mode: AwayMode): FakePage {
  return {
    id,
    mode,
    open: false,
    hidden: false,
    isBusy: false,
    loaded: true,
    hibernated: false,
    sleeping: false,
    status() {
      return this.hibernated ? { kind: 'hibernated' } : this.loaded ? { kind: 'ready' } : { kind: 'loading' };
    },
    asleep() {
      return this.sleeping;
    },
    setAsleep(asleep) {
      if (!this.hibernated) this.sleeping = asleep;
    },
    busy() {
      return this.isBusy;
    },
  };
}

/** A window of pages run by keepAway on mocked timers; `windowShown` stands for the window being on screen. */
function setup(...pages: FakePage[]) {
  const world = { windowShown: true };
  const away = keepAway({
    pages: () => pages,
    mode: (p) => p.mode,
    inSight: (p) => p.open && world.windowShown,
    mayHibernate: (p) => !p.open && !p.hidden,
    hibernate: (p) => {
      p.hibernated = true;
      p.sleeping = false;
    },
    sleepAfterMs: SLEEP,
    hibernateAfterMs: HIBERNATE,
  });
  away.update();
  return { world, away };
}

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
test.afterEach(() => mock.timers.reset());

test('a background page sleeps after the short delay and wakes the moment it is opened', () => {
  const whatsapp = page('whatsapp', 'sleep');
  const discord = page('discord', 'sleep');
  whatsapp.open = true;
  const { away } = setup(whatsapp, discord);
  mock.timers.tick(SLEEP - 1);
  assert.equal(discord.sleeping, false, 'still drawn just after leaving, for quick switching');
  mock.timers.tick(1);
  assert.deepEqual([whatsapp.sleeping, discord.sleeping], [false, true]);
  whatsapp.open = false;
  discord.open = true;
  away.update();
  assert.equal(discord.sleeping, false, 'awake at once when opened');
  mock.timers.tick(HIBERNATE * 3);
  assert.deepEqual([whatsapp.sleeping, whatsapp.hibernated], [true, false], 'sleep mode never hibernates');
});

test('hiding the window puts even the open tab to sleep; showing it wakes the tab', () => {
  const whatsapp = page('whatsapp', 'sleep');
  whatsapp.open = true;
  const { world, away } = setup(whatsapp);
  world.windowShown = false;
  away.update();
  mock.timers.tick(SLEEP);
  assert.equal(whatsapp.sleeping, true);
  world.windowShown = true;
  away.update();
  assert.equal(whatsapp.sleeping, false);
});

test('run mode keeps a background page drawn, and switching to it wakes a sleeping one', () => {
  const discord = page('discord', 'sleep');
  const { away } = setup(discord);
  mock.timers.tick(SLEEP);
  assert.equal(discord.sleeping, true);
  discord.mode = 'run';
  away.update();
  mock.timers.tick(HIBERNATE * 2);
  assert.deepEqual([discord.sleeping, discord.hibernated], [false, false]);
});

test('hibernate mode sleeps first, then closes the page after its delay out of sight', () => {
  const proton = page('proton-mail', 'hibernate');
  setup(proton);
  mock.timers.tick(SLEEP);
  assert.deepEqual([proton.sleeping, proton.hibernated], [true, false]);
  mock.timers.tick(HIBERNATE - SLEEP);
  assert.equal(proton.hibernated, true);
});

test('coming back to a tab restarts its hibernate delay from the next time it leaves', () => {
  const proton = page('proton-mail', 'hibernate');
  const { away } = setup(proton);
  mock.timers.tick(HIBERNATE - 1);
  proton.open = true;
  away.update();
  mock.timers.tick(HIBERNATE);
  assert.equal(proton.hibernated, false, 'the open tab never hibernates');
  proton.open = false;
  away.update();
  mock.timers.tick(HIBERNATE - 1);
  assert.equal(proton.hibernated, false);
  mock.timers.tick(1);
  assert.equal(proton.hibernated, true);
});

test('a busy page (a call, a screen share) is not hibernated; it tries again a full delay later', () => {
  const streamroom = page('streamroom', 'hibernate');
  streamroom.isBusy = true;
  setup(streamroom);
  mock.timers.tick(HIBERNATE * 2);
  assert.equal(streamroom.hibernated, false);
  streamroom.isBusy = false;
  mock.timers.tick(HIBERNATE - 1);
  assert.equal(streamroom.hibernated, false, 'the call has only just ended');
  mock.timers.tick(1);
  assert.equal(streamroom.hibernated, true);
});

test('a page hidden from the dock keeps running in hibernate mode, asleep; a loading page is left alone', () => {
  const gmail = page('gmail', 'hibernate');
  gmail.hidden = true;
  const messenger = page('messenger', 'sleep');
  messenger.loaded = false;
  const { away } = setup(gmail, messenger);
  mock.timers.tick(HIBERNATE * 2);
  assert.deepEqual([gmail.sleeping, gmail.hibernated], [true, false]);
  assert.equal(messenger.sleeping, false, 'it sleeps once loaded, not while loading');
  messenger.loaded = true;
  away.update();
  mock.timers.tick(SLEEP);
  assert.equal(messenger.sleeping, true);
});

test('switching a sleeping page to hibernate starts its delay from the switch', () => {
  const whatsapp = page('whatsapp', 'sleep');
  const { away } = setup(whatsapp);
  mock.timers.tick(HIBERNATE * 5);
  whatsapp.mode = 'hibernate';
  away.update();
  mock.timers.tick(HIBERNATE - 1);
  assert.equal(whatsapp.hibernated, false);
  mock.timers.tick(1);
  assert.equal(whatsapp.hibernated, true);
});

test('a busy page never sleeps, and a sleeping page that gets busy wakes on the next update', () => {
  const streamroom = page('streamroom', 'sleep');
  streamroom.isBusy = true;
  const { away } = setup(streamroom);
  mock.timers.tick(SLEEP * 10);
  assert.equal(streamroom.sleeping, false, 'a call in the background keeps drawing');
  streamroom.isBusy = false;
  away.update();
  mock.timers.tick(SLEEP);
  assert.equal(streamroom.sleeping, true);
  streamroom.isBusy = true;
  away.update();
  assert.equal(streamroom.sleeping, false);
});
