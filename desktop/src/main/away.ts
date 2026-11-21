import type { AwayMode } from '../shared/services.ts';
import type { ServiceRuntime } from './service-runtime.ts';

/** The part of a service runtime the background rules work on. */
export type AwayPage = Pick<ServiceRuntime, 'status' | 'asleep' | 'setAsleep' | 'busy'>;

export interface AwayRules<Page extends AwayPage> {
  readonly pages: () => readonly Page[];
  readonly mode: (page: Page) => AwayMode;
  /** On screen: the open tab, in a window that is shown. */
  readonly inSight: (page: Page) => boolean;
  /**
   * May close on its own after a while: not the open tab (which is always awake), and not hidden
   * from the dock (which promises to keep running).
   */
  readonly mayHibernate: (page: Page) => boolean;
  readonly hibernate: (page: Page) => void;
  /** How long a page stays drawn after leaving the screen, so flicking between tabs costs nothing. */
  readonly sleepAfterMs: number;
  /** How long a page in 'hibernate' mode stays out of sight before its page closes. */
  readonly hibernateAfterMs: number;
}

export interface Away {
  /** Applies the rules to every page now. Safe to call on any change, as often as wanted. */
  update(): void;
}

/**
 * Puts background pages to sleep and hibernates the ones set to, each after its delay. A page back
 * on screen or busy wakes at once and its sleep delay starts again. A busy page due to hibernate
 * waits another full delay instead.
 */
export function keepAway<Page extends AwayPage>(rules: AwayRules<Page>): Away {
  const sleepTimers = new Map<Page, NodeJS.Timeout>();
  const hibernateTimers = new Map<Page, NodeJS.Timeout>();
  const cancel = (timers: Map<Page, NodeJS.Timeout>, page: Page) => {
    clearTimeout(timers.get(page));
    timers.delete(page);
  };
  const after = (timers: Map<Page, NodeJS.Timeout>, page: Page, ms: number, action: () => void) => {
    if (timers.has(page)) return;
    timers.set(
      page,
      setTimeout(() => {
        timers.delete(page);
        action();
        update();
      }, ms),
    );
  };

  function update(): void {
    for (const page of rules.pages()) {
      const mode = rules.mode(page);
      // A page loading, failed or hibernating is left as it is.
      const away = page.status().kind === 'ready' && !rules.inSight(page);
      // A busy page (a call, a screen share) stays fully awake: a sleeping page draws nothing.
      if (!away || mode === 'run' || page.busy()) {
        cancel(sleepTimers, page);
        page.setAsleep(false);
      } else if (!page.asleep()) {
        after(sleepTimers, page, rules.sleepAfterMs, () => page.setAsleep(true));
      }
      if (away && mode === 'hibernate' && rules.mayHibernate(page)) {
        after(hibernateTimers, page, rules.hibernateAfterMs, () => {
          if (!page.busy()) rules.hibernate(page);
        });
      } else {
        cancel(hibernateTimers, page);
      }
    }
  }
  return { update };
}
