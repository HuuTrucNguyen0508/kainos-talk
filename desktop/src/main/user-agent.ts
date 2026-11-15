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
