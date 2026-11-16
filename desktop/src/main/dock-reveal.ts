import type { PagePointer } from '../shared/dock-edge.ts';

/**
 * When the auto-hiding dock is on screen. Main feeds it what the pointer, keyboard and menus do
 * and runs one timer per timed phase; this module only decides.
 *
 *   hidden ──pointer at the bottom edge──▶ revealing ──dwell──▶ shown
 *   shown ──nothing holds it──▶ hiding ──delay──▶ leaving ──slide──▶ hidden
 *
 * Keyboard focus in the dock, an open dock menu or a tab being dragged shows it at once. The pointer near the
 * bottom, over the dock, or gone out through the window's bottom edge keeps it shown.
 */

export type RevealPhase = 'hidden' | 'revealing' | 'shown' | 'hiding' | 'leaving';

export interface RevealState {
  /** Auto-hide applies: the dock is not kept shown, and the active page is up and not fullscreen. */
  readonly active: boolean;
  readonly phase: RevealPhase;
  readonly page: PagePointer;
  readonly overDock: boolean;
  /** Escape requires the pointer to leave the edge zone before it may reveal again. */
  readonly edgeArmed: boolean;
  /** Keyboard focus is in the dock (F6, Tab); a click's focus does not count. */
  readonly keyboard: boolean;
  readonly menu: boolean;
  /** A tab is being dragged along the dock; the pointer may stray off it meanwhile. */
  readonly drag: boolean;
}

export type RevealEvent =
  | { readonly kind: 'page'; readonly at: PagePointer }
  | { readonly kind: 'dock-pointer'; readonly over: boolean }
  | { readonly kind: 'keyboard'; readonly focused: boolean }
  | { readonly kind: 'menu'; readonly open: boolean }
  | { readonly kind: 'drag'; readonly active: boolean }
  /** Escape in the dock. */
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'active'; readonly active: boolean }
  /** The current phase's wait ran out. */
  | { readonly kind: 'timer' };

/** Milliseconds each timed phase waits before moving on. */
export const REVEAL_TIMING = {
  /** Long enough that overshooting the edge on the way to a page's composer does not flash the dock. */
  revealing: 160,
  /** Grace after the pointer leaves, so a slight overshoot off the dock does not drop it. */
  hiding: 400,
  /** The renderer's slide-out; the view keeps its bounds until it has finished. */
  leaving: 180,
} as const satisfies Partial<Record<RevealPhase, number>>;

export const initialReveal: RevealState = { active: false, phase: 'hidden', page: 'away', edgeArmed: true, overDock: false, keyboard: false, menu: false, drag: false };

/** On screen: the dock view has its bounds (sliding out included). */
export const onScreen = (phase: RevealPhase): boolean => phase === 'shown' || phase === 'hiding' || phase === 'leaving';
/** Drawn in its shown place rather than sliding away. */
export const raised = (phase: RevealPhase): boolean => phase === 'shown' || phase === 'hiding';

const urgent = (s: RevealState) => s.keyboard || s.menu || s.drag;
const atEdge = (s: RevealState) => s.edgeArmed && (s.page === 'edge' || s.page === 'below');
const held = (s: RevealState) => urgent(s) || s.overDock || s.page !== 'away';

/** The phase the inputs call for, from where it is now. */
function settle(s: RevealState): RevealState {
  if (!s.active) return s.phase === 'hidden' ? s : { ...s, phase: 'hidden' };
  const phase = ((): RevealPhase => {
    switch (s.phase) {
      case 'hidden':
      case 'revealing':
        return urgent(s) ? 'shown' : atEdge(s) ? 'revealing' : 'hidden';
      case 'shown':
      case 'hiding':
        return held(s) ? 'shown' : 'hiding';
      case 'leaving':
        return urgent(s) || atEdge(s) ? 'shown' : 'leaving';
    }
  })();
  return phase === s.phase ? s : { ...s, phase };
}

export function stepReveal(s: RevealState, event: RevealEvent): RevealState {
  switch (event.kind) {
    case 'page':
      return settle({ ...s, page: event.at, edgeArmed: s.edgeArmed || event.at === 'away' || event.at === 'band' });
    case 'dock-pointer':
      return settle(s.overDock === event.over ? s : { ...s, overDock: event.over });
    case 'keyboard':
      return settle(s.keyboard === event.focused ? s : { ...s, keyboard: event.focused });
    case 'menu':
      return settle(s.menu === event.open ? s : { ...s, menu: event.open });
    case 'drag':
      return settle(s.drag === event.active ? s : { ...s, drag: event.active });
    case 'dismiss':
      if (!s.active || !onScreen(s.phase)) return { ...s, keyboard: false };
      return { ...s, phase: 'leaving', keyboard: false, overDock: false, edgeArmed: false };
    case 'active':
      if (s.active === event.active) return s;
      // Coming back (pinning switched off, fullscreen or a load ended) starts from shown, so the
      // dock the user just saw slides away instead of vanishing; settle hides it if nothing holds it.
      return event.active ? settle({ ...s, active: true, phase: 'shown' }) : { ...s, active: false, phase: 'hidden' };
    case 'timer':
      if (s.phase === 'revealing') return settle({ ...s, phase: 'shown' });
      if (s.phase === 'hiding') return { ...s, phase: 'leaving' };
      // The view goes away under the pointer without telling the page, so nothing is over it now.
      if (s.phase === 'leaving') return settle({ ...s, phase: 'hidden', overDock: false });
      return s;
  }
}
