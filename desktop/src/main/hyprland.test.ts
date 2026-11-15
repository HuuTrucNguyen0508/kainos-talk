import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outerSide } from './bar.ts';
import { hyprMonitorRects, hyprWindowMonitor } from './hyprland.ts';

// Trimmed from `hyprctl monitors -j` on a 3440×1440 screen with a 2560×1440 one rotated 270° on its right.
const monitors = [
  { id: 0, name: 'DP-2', x: 0, y: 0, width: 3440, height: 1440, scale: 1, transform: 0 },
  { id: 1, name: 'DP-3', x: 3440, y: -560, width: 2560, height: 1440, scale: 1, transform: 3 },
];

test('rotated and scaled monitors get their layout size', () => {
  const rects = hyprMonitorRects([...monitors, { id: 2, x: 0, y: 1440, width: 3840, height: 2160, scale: 2, transform: 0 }, { id: 'x' }]);
  assert.deepEqual(rects.get(1), { x: 3440, y: -560, width: 1440, height: 2560 });
  assert.deepEqual(rects.get(2), { x: 0, y: 1440, width: 1920, height: 1080 });
  assert.equal(rects.size, 3);
});

test('finds the main window among the app’s own windows', () => {
  const clients = [
    { pid: 42, monitor: 0, title: 'account.proton.me — Sign in', mapped: true, hidden: false },
    { pid: 42, monitor: 1, title: '(3) Kainos Talk', mapped: true, hidden: false },
    { pid: 7, monitor: 0, title: 'Kainos Talk', mapped: true, hidden: false },
  ];
  assert.equal(hyprWindowMonitor(clients, 42, '(3) Kainos Talk'), 1);
  assert.equal(hyprWindowMonitor(clients, 42, 'Kainos Talk'), 1, 'title changed since the last query');
  assert.equal(hyprWindowMonitor(clients, 99, 'Kainos Talk'), undefined);
  assert.equal(hyprWindowMonitor('nonsense', 42, 'Kainos Talk'), undefined);
});

test('the window on the right-hand portrait screen gets the bar on the right', () => {
  const rects = hyprMonitorRects(monitors);
  const monitor = hyprWindowMonitor([{ pid: 1, monitor: 1, title: 'Kainos Talk' }], 1, 'Kainos Talk')!;
  assert.equal(outerSide(rects.get(monitor)!, [...rects.values()]), 'right');
  assert.equal(outerSide(rects.get(0)!, [...rects.values()]), 'left');
});
