const PLATFORM_TOKEN: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
};

/**
 * The user agent stock Chrome sends on this platform: reduced to the major version, with no
 * Electron or app tokens. WhatsApp Web refuses browsers that do not look like this.
 */
export function chromeUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  const major = chromeVersion.split('.')[0] ?? '0';
  const os = PLATFORM_TOKEN[platform] ?? 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const FIREFOX_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10.15',
};

/**
 * Firefox's release number on `date`: 134 shipped on 2025-01-07, and one follows every four
 * weeks. Worked out from the date, so the sign-in pages never see a Firefox long out of date.
 */
export function firefoxVersion(date: Date): number {
  const weeks = (date.getTime() - Date.UTC(2025, 0, 7)) / (7 * 24 * 3600 * 1000);
  return 134 + Math.max(0, Math.floor(weeks / 4));
}

/** The user agent stock Firefox sends on this platform, for Google's sign-in pages (`googleSignIn`). */
export function firefoxUserAgent(platform: NodeJS.Platform, date: Date): string {
  const version = firefoxVersion(date);
  const os = FIREFOX_PLATFORM[platform] ?? 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
}
