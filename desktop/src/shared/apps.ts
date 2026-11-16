import type { ServiceIcon } from './services.ts';

/** IPC between the Choose your apps page and main. */
export const AppsChannel = {
  /** Page to main: what to list (AppsChoices). */
  get: 'kainos:apps-get',
  /** Page to main: the ids to have on. */
  save: 'kainos:apps-save',
  /** Page to main: close without changes (not on first launch). */
  cancel: 'kainos:apps-cancel',
} as const;

export interface AppChoice {
  readonly id: string;
  readonly name: string;
  readonly about: string;
  readonly icon: ServiceIcon;
  readonly on: boolean;
}

export interface AppsChoices {
  /** First launch: nothing is on yet, and the page cannot be closed without a choice. */
  readonly firstRun: boolean;
  readonly services: readonly AppChoice[];
}

/** The page's API, exposed as window.kainosApps. */
export interface AppsApi {
  get(): Promise<AppsChoices>;
  save(ids: readonly string[]): void;
  cancel(): void;
}
