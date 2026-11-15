import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncConversation } from '../shared/sync-protocol.ts';
import { findCode, groupCode, matching, splitBySender, unreadIn } from './texts.ts';

test('finds the code in English and French verification texts', () => {
  assert.equal(findCode('248677 is your Link verification code.'), '248677');
  assert.equal(findCode('Votre code de vérification Deliveroo est 913042. Ne le partagez avec personne.'), '913042');
  assert.equal(findCode('Tiens, le code de vérification Netflix : 482913. Il est valable 15 minutes.'), '482913');
  assert.equal(findCode('236370 est votre code leboncoin. Ne le communiquez à personne.'), '236370');
  assert.equal(findCode('Votre code de vérification DELLIN : 660218'), '660218');
  assert.equal(findCode('492343 is your Shop verification code.'), '492343');
  assert.equal(findCode('Your OTP is 7731, valid for 10 minutes.'), '7731');
  assert.equal(findCode('Use 12345678 to verify your account'), '12345678');
  assert.equal(findCode('VERIFICATION CODE: 5521'), '5521');
  assert.equal(findCode('Your code:123456'), '123456');
  assert.equal(findCode('OTP:1234'), '1234');
  assert.equal(findCode('code:482913'), '482913');
});

test('finds nothing in texts without a code word', () => {
  assert.equal(findCode('Sosh : la facture du 06 39 98 01 42 est disponible dans votre espace client. Montant : 15,99 €, prélevé le 20/11.'), undefined);
  assert.equal(findCode('Black Friday Sosh : jusqu’à -80 € sur une sélection de smartphones, jusqu’au 30/11. STOP au 36180.'), undefined);
  assert.equal(findCode('Livraison terminée. Votre colis a été déposé dans votre boîte aux lettres.'), undefined);
  assert.equal(findCode('Manpower PONTOISE recherche préparateurs de commandes H/F. Rappelez le 01 99 00 01 20.'), undefined);
  assert.equal(findCode('Bonjour, RDV aujourd’hui 02/11 à 15h30 chez Atelier Coiffure.'), undefined);
});

test('a code word does not turn phone numbers, prices, references or dates into codes', () => {
  assert.equal(findCode('Payment revision needed: please update your payment method for order 404-8812345. Code 4 applies.'), undefined);
  assert.equal(findCode('Pour recevoir votre code, appelez le 0612345678.'), undefined);
  assert.equal(findCode('Pour recevoir votre code, appelez le 06 12 34 56 78.'), undefined);
  assert.equal(findCode('Code promo : 1500 € de remise sur votre commande'), undefined);
  assert.equal(findCode('Votre code expire le 2026/11/20'), undefined);
  assert.equal(findCode('Your verification fee is 1250.50 today'), undefined);
  assert.equal(findCode('Votre code postal 75011 est enregistré.'), undefined);
  assert.equal(findCode('Votre code expire à 14:32'), undefined);
  assert.equal(findCode('Votre code expire le 02/11 à 15h30'), undefined);
  assert.equal(findCode('Votre code coûte 15,99 €'), undefined);
  assert.equal(findCode('Pour votre code, appelez le 06 39 98 01 42'), undefined);
  assert.equal(findCode('Code envoyé à 12:3456'), undefined);
  assert.equal(findCode('Code envoyé à 1234:56'), undefined);
  assert.equal(findCode('Code: 123'), undefined, 'too short');
  assert.equal(findCode('Code: 123456789'), undefined, 'too long');
});

test('a code far from its word is not taken', () => {
  assert.equal(findCode(`Your code is below. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod. '.repeat(2)}4821`), undefined);
});

test('six-digit codes read in two groups', () => {
  assert.equal(groupCode('482913'), '482 913');
  assert.equal(groupCode('7731'), '7731');
});

const at = (key: string, title: string, sender: 'person' | 'service', unread: number): SyncConversation => ({
  key,
  title,
  isGroup: false,
  sender,
  unread,
  lastActivityMs: 1,
  canReply: true,
  messages: [{ id: key, sender: title, text: `hello from ${title}`, timeMs: 1, outgoing: false, status: 'incoming', media: null, image: null }],
});

test('people and notices split by sender and keep their order', () => {
  const all = [at('a', 'Camille', 'person', 0), at('b', 'StripeLink', 'service', 1), at('c', 'Maman', 'person', 2), at('d', '36679', 'service', 2)];
  const { people, notices } = splitBySender(all);
  assert.deepEqual(people.map((c) => c.key), ['a', 'c']);
  assert.deepEqual(notices.map((c) => c.key), ['b', 'd']);
  assert.equal(unreadIn(people), 2);
  assert.equal(unreadIn(notices), 3);
});

test('search matches names and message text, ignoring case', () => {
  const all = [at('a', 'Camille', 'person', 0), at('b', 'StripeLink', 'service', 1)];
  assert.deepEqual(matching(all, 'stripe').map((c) => c.key), ['b']);
  assert.deepEqual(matching(all, 'FROM CAMILLE').map((c) => c.key), ['a']);
  assert.equal(matching(all, '  ').length, 2);
});
