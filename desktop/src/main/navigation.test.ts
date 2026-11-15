import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findService } from '../shared/services.ts';
import { decideNavigation, decidePopupNavigation, decideWindowOpen, popupTitle } from './navigation.ts';

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
