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
  /** Background throttling on: the system puts the page to sleep whenever it is out of sight. */
  mayRest: boolean;
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
    mayRest: false,
    status() {
      return this.hibernated ? { kind: 'hibernated' } : this.loaded ? { kind: 'ready' } : { kind: 'loading' };
    },
    sleepAllowed() {
      return this.mayRest;
    },
    setSleepAllowed(allowed) {
      if (!this.hibernated) this.mayRest = allowed;
    },
    busy() {
      return this.isBusy;
    },
  };
}

/** Pages run by keepAway on mocked timers. */
function setup(...pages: FakePage[]) {
  const away = keepAway({
    pages: () => pages,
    mode: (p) => p.mode,
    open: (p) => p.open,
    mayHibernate: (p) => !p.open && !p.hidden,
    hibernate: (p) => {
      p.hibernated = true;
      p.mayRest = false;
    },
    sleepAfterMs: SLEEP,
    hibernateAfterMs: HIBERNATE,
  });
  away.update();
  return away;
}

/** Opens `next` in place of the open tab, as a click on its tab does. */
function open(away: { update(): void }, from: FakePage, next: FakePage): void {
  from.open = false;
  next.open = true;
  away.update();
}

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
test.afterEach(() => mock.timers.reset());

test('the open tab may sleep at once, so it sleeps whenever its window is hidden, minimised or covered', () => {
  const whatsapp = page('whatsapp', 'sleep');
  whatsapp.open = true;
  setup(whatsapp);
  assert.equal(whatsapp.mayRest, true);
});

test('a background tab is drawn a while longer, then may sleep; opening it again keeps it allowed', () => {
  const whatsapp = page('whatsapp', 'sleep');
  const discord = page('discord', 'sleep');
  whatsapp.open = true;
  const away = setup(whatsapp, discord);
  assert.equal(discord.mayRest, false, 'still drawn just after load, for quick switching');
  mock.timers.tick(SLEEP);
  assert.deepEqual([whatsapp.mayRest, discord.mayRest], [true, true]);
  open(away, whatsapp, discord);
  assert.deepEqual([whatsapp.mayRest, discord.mayRest], [false, true], 'WhatsApp, just left, is drawn a while longer');
  mock.timers.tick(SLEEP);
  assert.equal(whatsapp.mayRest, true);
  mock.timers.tick(HIBERNATE * 3);
  assert.equal(whatsapp.hibernated, false, 'sleep mode never hibernates');
});

test('flicking back within the delay, the tab that left stays drawn and its delay starts again', () => {
  const whatsapp = page('whatsapp', 'sleep');
  const discord = page('discord', 'sleep');
  whatsapp.open = true;
  const away = setup(whatsapp, discord);
  mock.timers.tick(SLEEP);
  open(away, whatsapp, discord);
  mock.timers.tick(SLEEP - 1);
  open(away, discord, whatsapp);
  open(away, whatsapp, discord);
  mock.timers.tick(SLEEP - 1);
  assert.equal(whatsapp.mayRest, false);
  mock.timers.tick(1);
  assert.equal(whatsapp.mayRest, true);
});

test('run mode never sleeps, open or not, and switching to it wakes a sleeping page', () => {
  const discord = page('discord', 'sleep');
  const away = setup(discord);
  mock.timers.tick(SLEEP);
  assert.equal(discord.mayRest, true);
  discord.mode = 'run';
  away.update();
  assert.equal(discord.mayRest, false);
  discord.open = true;
  away.update();
  mock.timers.tick(HIBERNATE * 2);
  assert.deepEqual([discord.mayRest, discord.hibernated], [false, false]);
});

test('hibernate mode sleeps first, then closes the page after its delay in the background', () => {
  const proton = page('proton-mail', 'hibernate');
  setup(proton);
  mock.timers.tick(SLEEP);
  assert.deepEqual([proton.mayRest, proton.hibernated], [true, false]);
  mock.timers.tick(HIBERNATE - SLEEP);
  assert.equal(proton.hibernated, true);
});

test('coming back to a tab restarts its hibernate delay from the next time it leaves', () => {
  const proton = page('proton-mail', 'hibernate');
  const away = setup(proton);
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

test('a busy page never sleeps, open or not, and a sleeping page that gets busy wakes on the next update', () => {
  const streamroom = page('streamroom', 'sleep');
  const messenger = page('messenger', 'sleep');
  streamroom.isBusy = true;
  messenger.open = true;
  messenger.isBusy = true;
  const away = setup(streamroom, messenger);
  mock.timers.tick(SLEEP * 10);
  assert.deepEqual([streamroom.mayRest, messenger.mayRest], [false, false], 'a call keeps drawing, in the background or in a covered window');
  streamroom.isBusy = false;
  away.update();
  mock.timers.tick(SLEEP);
  assert.equal(streamroom.mayRest, true);
  streamroom.isBusy = true;
  away.update();
  assert.equal(streamroom.mayRest, false);
});

test('a page hidden from the dock keeps running in hibernate mode, asleep; a loading page is left alone', () => {
  const gmail = page('gmail', 'hibernate');
  gmail.hidden = true;
  const messenger = page('messenger', 'sleep');
  messenger.loaded = false;
  messenger.open = true;
  const away = setup(gmail, messenger);
  mock.timers.tick(HIBERNATE * 2);
  assert.deepEqual([gmail.mayRest, gmail.hibernated], [true, false]);
  assert.equal(messenger.mayRest, false, 'it may sleep once loaded, not while loading');
  messenger.loaded = true;
  away.update();
  assert.equal(messenger.mayRest, true);
});

test('switching a sleeping page to hibernate starts its delay from the switch', () => {
  const whatsapp = page('whatsapp', 'sleep');
  const away = setup(whatsapp);
  mock.timers.tick(HIBERNATE * 5);
  whatsapp.mode = 'hibernate';
  away.update();
  mock.timers.tick(HIBERNATE - 1);
  assert.equal(whatsapp.hibernated, false);
  mock.timers.tick(1);
  assert.equal(whatsapp.hibernated, true);
});
