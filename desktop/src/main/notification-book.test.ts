import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationBook } from './notification-book.ts';

class Fake {
  closed = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  close(): void {
    this.closed++;
  }
}

test('a notification closed while its icon loads is never shown', () => {
  const book = new NotificationBook<Fake>();
  book.begin(1, 10);
  book.close(1, 10);
  assert.equal(book.show(1, 10, '', new Fake('a')), false);
  // The same id can come back later, from a new page, and shows normally.
  book.begin(1, 10);
  assert.equal(book.show(1, 10, '', new Fake('b')), true);
});

test('close() on a shown notification closes it once', () => {
  const book = new NotificationBook<Fake>();
  const a = new Fake('a');
  book.begin(1, 10);
  book.show(1, 10, '', a);
  book.close(1, 10);
  book.close(1, 10);
  assert.equal(a.closed, 1);
});

test('a tag replaces the earlier notification with the same tag from the same page', () => {
  const book = new NotificationBook<Fake>();
  const [a, b, c, other] = [new Fake('a'), new Fake('b'), new Fake('c'), new Fake('other')];
  book.begin(1, 1);
  book.show(1, 1, 'chat', a);
  book.begin(2, 1);
  book.show(2, 1, 'chat', other); // another service, same tag: untouched
  book.begin(1, 2);
  book.show(1, 2, 'chat', b);
  assert.deepEqual([a.closed, b.closed, other.closed], [1, 0, 0]);
  book.begin(1, 3);
  book.show(1, 3, '', c); // no tag: replaces nothing
  assert.deepEqual([b.closed, c.closed], [0, 0]);
});

test("an old notification's late close event does not forget a newer one", () => {
  const book = new NotificationBook<Fake>();
  const [a, b] = [new Fake('a'), new Fake('b')];
  book.begin(1, 1);
  book.show(1, 1, 'chat', a);
  book.begin(1, 2);
  book.show(1, 2, 'chat', b); // closes a
  book.ended(1, 1, a);
  book.close(1, 2);
  assert.equal(b.closed, 1);
  // Same id reused: the stale close event of the first one leaves the second alone.
  const [c, d] = [new Fake('c'), new Fake('d')];
  book.begin(1, 5);
  book.show(1, 5, '', c);
  book.ended(1, 5, c);
  book.begin(1, 5);
  book.show(1, 5, '', d);
  book.ended(1, 5, c);
  book.close(1, 5);
  assert.equal(d.closed, 1);
});
