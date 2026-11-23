import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPause, isOwnPlayer, type MediaBus, type PlaybackStatus } from './media-pause.ts';

/** Players on a pretend session bus; `user` changes one the way its own controls would. */
function fakeBus(players: Record<string, PlaybackStatus>) {
  const now = new Map(Object.entries(players));
  const watchers = new Map<string, Set<(status: PlaybackStatus) => void>>();
  const calls: string[] = [];
  const set = (name: string, status: PlaybackStatus) => {
    if (now.get(name) === status) return;
    now.set(name, status);
    for (const watcher of watchers.get(name) ?? []) watcher(status);
  };
  const bus: MediaBus = {
    players: async () => [...now].map(([name, status]) => ({ name, status })),
    status: async (name) => now.get(name),
    pause: async (name) => {
      calls.push(`pause ${name}`);
      set(name, 'Paused');
    },
    play: async (name) => {
      calls.push(`play ${name}`);
      set(name, 'Playing');
    },
    watch: async (name, onStatus) => {
      const set = watchers.get(name) ?? new Set();
      watchers.set(name, set.add(onStatus));
      return () => set.delete(onStatus);
    },
    close: () => calls.push('close'),
  };
  return {
    bus,
    calls,
    now,
    user: set,
    quit: (name: string) => {
      now.delete(name);
      watchers.delete(name);
    },
  };
}

const MUSIC = 'org.mpris.MediaPlayer2.spotify';
const VIDEO = 'org.mpris.MediaPlayer2.mpv';
const IDLE = 'org.mpris.MediaPlayer2.vlc';

test('a call pauses what plays, and its end plays those again', async () => {
  const fake = fakeBus({ [MUSIC]: 'Playing', [VIDEO]: 'Playing', [IDLE]: 'Paused' });
  const media = createMediaPause(fake.bus);
  media.update(true);
  await media.idle();
  assert.deepEqual(fake.calls, [`pause ${MUSIC}`, `pause ${VIDEO}`], 'a player already paused is not touched');
  media.update(true); // ringing, then answered: still the same call
  await media.idle();
  media.update(false);
  await media.idle();
  assert.deepEqual(fake.calls.slice(2), [`play ${MUSIC}`, `play ${VIDEO}`]);
  assert.equal(fake.now.get(IDLE), 'Paused', 'and it stays paused');
});

test('a player the user played, played and paused, stopped or closed during the call is left as it is', async () => {
  const PAUSED_AGAIN = 'org.mpris.MediaPlayer2.firefox';
  const STOPPED = 'org.mpris.MediaPlayer2.rhythmbox';
  const fake = fakeBus({ [MUSIC]: 'Playing', [VIDEO]: 'Playing', [PAUSED_AGAIN]: 'Playing', [STOPPED]: 'Playing', [IDLE]: 'Playing' });
  const media = createMediaPause(fake.bus);
  media.update(true);
  await media.idle();
  fake.user(MUSIC, 'Playing');
  fake.user(PAUSED_AGAIN, 'Playing');
  fake.user(PAUSED_AGAIN, 'Paused');
  fake.user(STOPPED, 'Stopped');
  fake.quit(IDLE);
  fake.calls.length = 0;
  media.update(false);
  await media.idle();
  assert.deepEqual(fake.calls, [`play ${VIDEO}`], 'only the one still paused for the call');
});

test('a new call after the last one pauses afresh, and a player started during a call is not paused', async () => {
  const fake = fakeBus({ [MUSIC]: 'Paused' });
  const media = createMediaPause(fake.bus);
  media.update(true);
  await media.idle();
  fake.user(MUSIC, 'Playing');
  media.update(false);
  await media.idle();
  assert.deepEqual(fake.calls, [], 'it was not playing when the call came');
  media.update(true);
  await media.idle();
  media.update(false);
  await media.idle();
  assert.deepEqual(fake.calls, [`pause ${MUSIC}`, `play ${MUSIC}`]);
});

test('a bus that fails does not stop the others from pausing and playing', async () => {
  const fake = fakeBus({ [MUSIC]: 'Playing', [VIDEO]: 'Playing' });
  const pause = fake.bus.pause;
  fake.bus.pause = async (name) => (name === MUSIC ? Promise.reject(new Error('no reply')) : pause(name));
  const media = createMediaPause(fake.bus);
  media.update(true);
  await media.idle();
  assert.equal(fake.now.get(VIDEO), 'Paused');
  media.update(false);
  await media.idle();
  assert.equal(fake.now.get(VIDEO), 'Playing');
  assert.deepEqual(fake.calls, [`pause ${VIDEO}`, `play ${VIDEO}`], 'the one it could not pause is not played either');
});

test('a rejected pause drops its watcher and cannot resume the player', async () => {
  const fake = fakeBus({ [MUSIC]: 'Playing' });
  fake.bus.pause = async () => { throw new Error('no reply'); };
  const watch = fake.bus.watch;
  let unwatched = false;
  fake.bus.watch = async (name, onStatus) => {
    const unwatch = await watch(name, onStatus);
    return () => {
      unwatched = true;
      unwatch();
    };
  };
  const media = createMediaPause(fake.bus);
  media.update(true);
  await media.idle();
  fake.user(MUSIC, 'Paused');
  const droppedDuringCall = unwatched;
  media.update(false);
  await media.idle();
  assert.deepEqual(fake.calls, []);
  assert.equal(droppedDuringCall, true);
});

test('playerctld, which passes commands on to another player, is not a player of its own', () => {
  assert.equal(isOwnPlayer('org.mpris.MediaPlayer2.chromium.instance15745'), true);
  assert.equal(isOwnPlayer('org.mpris.MediaPlayer2.playerctld'), false);
  assert.equal(isOwnPlayer('org.freedesktop.Notifications'), false);
});
