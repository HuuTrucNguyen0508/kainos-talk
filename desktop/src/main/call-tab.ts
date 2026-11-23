/** A tab and the call it has, if any (see ServiceRuntime.callPhase; Texts has the phone's). */
export interface TabCall {
  readonly id: string;
  readonly phase: 'ringing' | 'call' | undefined;
}

/** The tab to open for a call: one ringing before one connected, and among those alike the first listed. */
export function callTab(tabs: readonly TabCall[]): string | undefined {
  return (tabs.find((tab) => tab.phase === 'ringing') ?? tabs.find((tab) => tab.phase === 'call'))?.id;
}
