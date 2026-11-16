interface Closable {
  close(): void;
}

/**
 * Bookkeeping for page notifications, keyed by sender (a service's WebContents id) and the
 * page's notification id. Handles a close that arrives while the icon is still loading, tag
 * replacement, and close events that arrive after a newer notification took the same key.
 */
export class NotificationBook<T extends Closable> {
  readonly #pending = new Set<string>();
  readonly #cancelled = new Set<string>();
  readonly #shown = new Map<string, T>();
  readonly #tagged = new Map<string, T>();

  /** The page asked to show notification `id`; its icon is loading. */
  begin(sender: number, id: number): void {
    const key = `${sender}:${id}`;
    this.#pending.add(key);
    this.#cancelled.delete(key);
  }

  /**
   * Records `item` as shown and closes the earlier one with the same non-empty tag. Returns
   * false, and records nothing, when the page closed it while it was loading.
   */
  show(sender: number, id: number, tag: string, item: T): boolean {
    const key = `${sender}:${id}`;
    this.#pending.delete(key);
    if (this.#cancelled.delete(key)) return false;
    if (tag) {
      const tagKey = `${sender}:${tag}`;
      this.#tagged.get(tagKey)?.close();
      this.#tagged.set(tagKey, item);
    }
    this.#shown.set(key, item);
    return true;
  }

  /** Notification `id` will never be shown: its page closed while its icon was loading. */
  abandon(sender: number, id: number): void {
    const key = `${sender}:${id}`;
    this.#pending.delete(key);
    this.#cancelled.delete(key);
  }

  /** The page closed notification `id`. */
  close(sender: number, id: number): void {
    const key = `${sender}:${id}`;
    if (this.#pending.has(key)) this.#cancelled.add(key);
    const item = this.#shown.get(key);
    this.#shown.delete(key);
    item?.close();
  }

  /** `item` went away (dismissed, clicked or replaced); forget it unless something newer took its place. */
  ended(sender: number, id: number, item: T): void {
    const key = `${sender}:${id}`;
    if (this.#shown.get(key) === item) this.#shown.delete(key);
    for (const [tagKey, tagged] of this.#tagged) if (tagged === item) this.#tagged.delete(tagKey);
  }
}
