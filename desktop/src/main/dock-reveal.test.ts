import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialReveal, onScreen, raised, stepReveal, type RevealEvent, type RevealState } from './dock-reveal.ts';

const run = (events: readonly RevealEvent[], from: RevealState = { ...initialReveal, active: true }) => events.reduce(stepReveal, from);
const phases = (events: readonly RevealEvent[], from?: RevealState) => {
  let s = from ?? { ...initialReveal, active: true };
  return events.map((event) => (s = stepReveal(s, event)).phase);
};
const page = (at: 'away' | 'band' | 'edge' | 'below'): RevealEvent => ({ kind: 'page', at });
const timer: RevealEvent = { kind: 'timer' };

test('the pointer at the bottom edge shows the dock after the dwell', () => {
  assert.deepEqual(phases([page('band'), page('edge'), timer]), ['hidden', 'revealing', 'shown']);
});

test('leaving the window through its bottom edge (a compositor gap) shows it too', () => {
  assert.deepEqual(phases([page('below'), timer]), ['revealing', 'shown']);
});

test('overshooting the edge on the way to a composer does not show the dock', () => {
  assert.deepEqual(phases([page('edge'), page('band')]), ['revealing', 'hidden']);
  assert.deepEqual(phases([page('below'), page('away')]), ['revealing', 'hidden']);
});

test('it stays while the pointer is in the band, at the edge, below or over the dock', () => {
  const shown = run([page('edge'), timer]);
  assert.equal(shown.phase, 'shown');
  assert.equal(run([page('band')], shown).phase, 'shown');
  assert.equal(run([{ kind: 'dock-pointer', over: true }, page('away')], shown).phase, 'shown');
  assert.equal(run([page('below')], shown).phase, 'shown');
});

test('it hides after the delay and the slide once the pointer moves up and away', () => {
  const shown = run([page('edge'), timer, { kind: 'dock-pointer', over: true }]);
  assert.deepEqual(phases([page('away'), { kind: 'dock-pointer', over: false }, timer, timer], shown), ['shown', 'hiding', 'leaving', 'hidden']);
});

test('coming back during the hide delay keeps it, and touching the edge while it slides out brings it back', () => {
  const hiding = run([page('edge'), timer, page('away')]);
  assert.equal(hiding.phase, 'hiding');
  assert.equal(run([{ kind: 'dock-pointer', over: true }], hiding).phase, 'shown');
  const leaving = run([timer], hiding);
  assert.equal(leaving.phase, 'leaving');
  assert.equal(run([page('edge')], leaving).phase, 'shown');
  assert.equal(run([page('band')], leaving).phase, 'leaving', 'the band alone does not stop it leaving');
});

test('keyboard focus shows it at once and keeps it; losing focus hides it', () => {
  assert.deepEqual(phases([{ kind: 'keyboard', focused: true }, page('away'), { kind: 'keyboard', focused: false }, timer, timer]), ['shown', 'shown', 'hiding', 'leaving', 'hidden']);
});

test('Escape slides it away straight away, even with the pointer on it', () => {
  const s = run([{ kind: 'keyboard', focused: true }, { kind: 'dock-pointer', over: true }, { kind: 'dismiss' }]);
  assert.equal(s.phase, 'leaving');
  assert.equal(s.keyboard, false);
  assert.equal(run([timer], s).phase, 'hidden');
});

test('an open menu keeps it until the menu closes', () => {
  const s = run([page('edge'), timer, { kind: 'menu', open: true }, page('away')]);
  assert.equal(s.phase, 'shown');
  assert.equal(run([{ kind: 'menu', open: false }], s).phase, 'hiding');
});

test('while it does not apply (kept shown, loading, fullscreen) nothing reveals, and inputs are still tracked', () => {
  const off = { ...initialReveal };
  const s = run([page('edge'), timer, { kind: 'keyboard', focused: true }], off);
  assert.equal(s.phase, 'hidden');
  assert.equal(s.keyboard, true);
});

test('fullscreen drops a shown dock at once; coming back shows it and lets it slide away', () => {
  const shown = run([page('edge'), timer]);
  assert.equal(run([{ kind: 'active', active: false }], shown).phase, 'hidden');
  assert.deepEqual(phases([{ kind: 'active', active: true }, timer, timer], initialReveal), ['hiding', 'leaving', 'hidden']);
  assert.deepEqual(phases([{ kind: 'active', active: true }], { ...initialReveal, page: 'band' }), ['shown']);
});

test('the dock is on screen while shown, hiding and sliding out, and raised only while shown or hiding', () => {
  assert.deepEqual(['hidden', 'revealing', 'shown', 'hiding', 'leaving'].map((p) => onScreen(p as never)), [false, false, true, true, true]);
  assert.deepEqual(['hidden', 'revealing', 'shown', 'hiding', 'leaving'].map((p) => raised(p as never)), [false, false, true, true, false]);
});

test('once hidden, the dock no longer counts the pointer as over it', () => {
  const s = run([page('edge'), timer, page('away'), timer, { kind: 'dock-pointer', over: true }, timer]);
  assert.equal(s.phase, 'hidden');
  assert.equal(s.overDock, false);
});

for (const at of ['edge', 'below'] as const) {
  test(`Escape stays hidden with a stationary pointer ${at}, then rearms after leaving the edge`, () => {
    const shown = run([page(at), timer, { kind: 'keyboard', focused: true }]);
    assert.deepEqual(phases([
      { kind: 'dismiss' },
      { kind: 'keyboard', focused: false },
      { kind: 'dock-pointer', over: false },
      page(at), timer, timer, page(at),
      page('band'), page(at), timer,
    ], shown), ['leaving', 'leaving', 'leaving', 'leaving', 'hidden', 'hidden', 'hidden', 'hidden', 'revealing', 'shown']);
  });
}
