import type { ServiceIcon } from './services.ts';

/**
 * Where a desktop app on a Kainos tab (Thunderbird) stands, as its tab's page shows it. Kainos
 * cannot draw another app inside its window, so on Hyprland it places the app's own window over
 * the tab instead; the page shows through only while that window is not there.
 */
export type NativeAppState =
  /** Started by Kainos; its window is not up yet. */
  | { readonly kind: 'starting' }
  /** Its window sits over the tab. */
  | { readonly kind: 'placed' }
  /** Not running. */
  | { readonly kind: 'closed' }
  /** The system could not start it: not installed, or not on the PATH. */
  | { readonly kind: 'missing' }
  /** Not on Hyprland: the app opens in a window of its own, beside Kainos. */
  | { readonly kind: 'separate' };

export interface NativeAppView {
  readonly name: string;
  readonly icon: ServiceIcon;
  readonly state: NativeAppState;
}

export const NativeChannel = {
  getView: 'native:get-view',
  view: 'native:view',
  open: 'native:open',
} as const;

/** What the native app's tab page may call, as window.kainosNative. */
export interface NativeApi {
  getView(): Promise<NativeAppView | undefined>;
  onView(listener: (view: NativeAppView) => void): void;
  /** Starts the app, or brings its window back to the tab. */
  open(): void;
}
