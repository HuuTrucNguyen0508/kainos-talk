import type { AwayMode } from '../shared/services.ts';
import type { ServiceRuntime } from './service-runtime.ts';

/** The part of a service runtime the background rules work on. */
export type AwayPage = Pick<ServiceRuntime, 'status' | 'sleepAllowed' | 'setSleepAllowed' | 'busy'>;

export interface AwayRules<Page extends AwayPage> {
  readonly pages: () => readonly Page[];
  readonly mode: (page: Page) => AwayMode;
  /** The open tab. Whether its window is shown is the system's to tell (see `setSleepAllowed`). */
  readonly open: (page: Page) => boolean;
  /**
   * May close on its own after a while: not the open tab (which is always awake), and not hidden
   * from the dock (which promises to keep running).
   */
  readonly mayHibernate: (page: Page) => boolean;
  readonly hibernate: (page: Page) => void;
  /** How long a tab stays drawn after another opens, so flicking between tabs costs nothing. */
  readonly sleepAfterMs: number;
  /** How long a page in 'hibernate' mode stays out of sight before its page closes. */
  readonly hibernateAfterMs: number;
}

export interface Away {
  /** Applies the rules to every page now. Safe to call on any change, as often as wanted. */
  update(): void;
}

/**
 * Lets pages sleep and hibernates the ones set to. The open tab may sleep at once, so it does
 * whenever its window is out of sight (hidden, minimised, or covered on Windows) and is drawn
 * whenever it shows. A tab that another replaces stays drawn for `sleepAfterMs` first, then may
 * sleep. A page in 'run' mode, busy (a call, a screen share) or still loading never sleeps.
 * A page set to hibernate closes after `hibernateAfterMs` in the background; a busy one waits
 * another full delay instead.
 */
export function keepAway<Page extends AwayPage>(rules: AwayRules<Page>): Away {
  const sleepTimers = new Map<Page, NodeJS.Timeout>();
  const hibernateTimers = new Map<Page, NodeJS.Timeout>();
  /** Background tabs whose drawn spell after leaving is over. */
  const rested = new Set<Page>();
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
      const ready = page.status().kind === 'ready';
      const background = ready && !rules.open(page);
      if (!ready || mode === 'run' || page.busy()) {
        cancel(sleepTimers, page);
        rested.delete(page);
        page.setSleepAllowed(false);
      } else if (!background) {
        cancel(sleepTimers, page);
        rested.delete(page);
        page.setSleepAllowed(true);
      } else if (!rested.has(page)) {
        // Just left the screen: drawn a while longer, in case it is opened again straight away.
        page.setSleepAllowed(false);
        after(sleepTimers, page, rules.sleepAfterMs, () => {
          rested.add(page);
          page.setSleepAllowed(true);
        });
      }
      if (background && mode === 'hibernate' && rules.mayHibernate(page)) {
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
