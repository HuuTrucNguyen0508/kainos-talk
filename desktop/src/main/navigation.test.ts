import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICES, findService } from '../shared/services.ts';
import { withServers } from '../shared/streamroom.ts';
import { claimingService, decideNavigation, decidePopupNavigation, decideWindowOpen, popupTitle, sharedLink } from './navigation.ts';

const proton = findService('proton-mail')!;
const discord = findService('discord')!;
const whatsapp = findService('whatsapp')!;

test('Proton sign-in moves between mail and account without leaving the app', () => {
  assert.equal(decideNavigation(proton, 'https://mail.proton.me/u/0/inbox'), 'stay');
  assert.equal(decideNavigation(proton, 'https://account.proton.me/login?product=mail'), 'stay');
  assert.equal(decideNavigation(proton, 'https://proton.me/support/two-factor'), 'external');
});

test('links to other sites open in the system browser', () => {
  assert.equal(decideNavigation(whatsapp, 'https://example.com/article'), 'external');
  assert.equal(decideNavigation(discord, 'http://example.com/'), 'external');
  assert.equal(decideNavigation(whatsapp, 'mailto:someone@example.com'), 'external');
  assert.equal(decideWindowOpen(whatsapp, 'https://www.youtube.com/watch?v=x'), 'external');
  assert.equal(decideWindowOpen(discord, 'https://github.com/'), 'external');
});

test('look-alike hosts and plain http do not count as the service', () => {
  assert.equal(decideNavigation(discord, 'https://discord.com.evil.example/login'), 'external');
  assert.equal(decideNavigation(discord, 'https://evildiscord.com/'), 'external');
  assert.equal(decideNavigation(discord, 'http://discord.com/app'), 'external');
});

test('unsafe schemes are dropped, not opened', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'smb://host/share']) {
    assert.equal(decideNavigation(discord, url), 'block', url);
    assert.equal(decideWindowOpen(discord, url), 'block', url);
    assert.equal(decidePopupNavigation(discord, url), 'block', url);
  }
});

test('only captcha and sign-in hosts open as popups', () => {
  assert.equal(decideWindowOpen(discord, 'https://newassets.hcaptcha.com/captcha/v1/abc'), 'popup');
  assert.equal(decideWindowOpen(proton, 'https://account.proton.me/sso/login'), 'popup');
  assert.equal(decideWindowOpen(proton, 'https://verify.proton.me/'), 'popup');
  // Ordinary same-site links from Discord open in the browser, not in a bare popup.
  assert.equal(decideWindowOpen(discord, 'https://discord.com/blog'), 'external');
  assert.equal(decideWindowOpen(discord, 'https://discord.com/api/connections/github/authorize'), 'external');
});

test('blank popups are refused: their opener could fill them with anything', () => {
  assert.equal(decideWindowOpen(discord, 'about:blank'), 'block');
  assert.equal(decideWindowOpen(discord, ''), 'block');
  assert.equal(decideWindowOpen(proton, 'about:blank'), 'block');
});

test('Messenger opens its call window blank, then sends it to a call page on messenger.com', () => {
  const messenger = findService('messenger')!;
  assert.equal(decideWindowOpen(messenger, 'about:blank'), 'call');
  assert.equal(decideWindowOpen(messenger, ''), 'call');
  assert.equal(decidePopupNavigation(messenger, 'https://www.messenger.com/groupcall/ROOM:1/?call_id=2'), 'stay');
  assert.equal(decidePopupNavigation(messenger, 'https://evil.example/'), 'external');
  assert.equal(decideWindowOpen(messenger, 'javascript:alert(1)'), 'block');
});

test('a popup stays on the service and its popup hosts; anything else goes to the browser', () => {
  assert.equal(decidePopupNavigation(discord, 'https://discord.com/oauth2/authorized'), 'stay');
  assert.equal(decidePopupNavigation(discord, 'https://hcaptcha.com/challenge'), 'stay');
  assert.equal(decidePopupNavigation(proton, 'https://verify.proton.me/x'), 'stay');
  assert.equal(decidePopupNavigation(discord, 'https://github.com/login/oauth/authorize?client_id=x'), 'external');
  assert.equal(decidePopupNavigation(proton, 'https://evil.example/login'), 'external');
  assert.equal(decidePopupNavigation(discord, 'http://hcaptcha.com/'), 'external');
});

test('a popup title names the host it shows', () => {
  assert.equal(popupTitle('https://newassets.hcaptcha.com/captcha/v1/x', 'hCaptcha'), 'newassets.hcaptcha.com — hCaptcha');
  assert.equal(popupTitle('https://account.proton.me/sso', ''), 'account.proton.me');
  assert.equal(popupTitle('https://account.proton.me/sso', 'account.proton.me/sso'), 'account.proton.me — account.proton.me/sso');
  assert.equal(popupTitle('about:blank', 'Hi'), 'about:blank — Hi');
});

test('a Streamroom invite sent in another service opens in the Streamroom tab; other links do not', () => {
  const services = SERVICES.map((s) => (s.id === 'streamroom' ? withServers(s, { current: 'https://rooms.example.org', saved: ['https://rooms.example.org', 'https://pc.tail1234.ts.net'], localPort: 8080 }) : s));
  assert.equal(claimingService(services, 'https://rooms.example.org/r/abc123#key')?.id, 'streamroom');
  assert.equal(claimingService(services, 'https://pc.tail1234.ts.net/?invite=x')?.id, 'streamroom', 'any saved server');
  assert.equal(decideNavigation(findService('discord')!, 'https://rooms.example.org/r/abc123'), 'external', 'it leaves Discord first');
  for (const url of ['https://web.whatsapp.com/', 'http://rooms.example.org/r/a', 'https://rooms.example.org.evil.com/', 'http://localhost:8080/r/a', 'not a url']) {
    assert.equal(claimingService(services, url), undefined, url);
  }
});

test('Streamroom on this PC keeps its plain-http pages in the tab and claims their invites', () => {
  const local = findService('streamroom')!;
  assert.equal(decideNavigation(local, 'http://localhost:8080/r/abc'), 'stay');
  assert.equal(decideNavigation(local, 'http://127.0.0.1:8080/'), 'external', 'another name for this PC is another host');
  assert.equal(claimingService(SERVICES, 'http://localhost:8080/?invite=x')?.id, 'streamroom');
  assert.equal(decideNavigation(findService('discord')!, 'http://localhost:8080/'), 'external', 'other services never trust plain http');
});

test('shared text that is one web link opens; anything else is text for the clipboard', () => {
  assert.equal(sharedLink('  https://example.com/watch?v=42\n'), 'https://example.com/watch?v=42');
  assert.equal(sharedLink('http://192.168.1.20:8080/'), 'http://192.168.1.20:8080/');
  assert.equal(sharedLink('Look at this https://example.com'), undefined);
  assert.equal(sharedLink('https://a.example https://b.example'), undefined);
  assert.equal(sharedLink('javascript:alert(1)'), undefined);
  assert.equal(sharedLink('file:///etc/passwd'), undefined);
  assert.equal(sharedLink('example.com'), undefined);
});
