/** One cache per service session; concurrent requests share the same fetch and decode. */
export class IconCache<T> {
  readonly #pending = new Map<string, Promise<T | undefined>>();
  readonly #icons = new Map<string, { image: T; expires: number }>();
  get(url: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const cached = this.#icons.get(url);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.image);
    this.#icons.delete(url);
    const pending = this.#pending.get(url);
    if (pending) return pending;
    const promise = load().then((image) => {
      if (image !== undefined) {
        this.#icons.set(url, { image, expires: Date.now() + 3 * 60_000 });
        if (this.#icons.size > 64) this.#icons.delete(this.#icons.keys().next().value!);
      }
      return image;
    }).finally(() => this.#pending.delete(url));
    this.#pending.set(url, promise);
    return promise;
  }
}
