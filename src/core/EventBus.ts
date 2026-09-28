/** Minimal typed event emitter. */
export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private readonly handlers = new Map<keyof Events, Set<(e: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as (e: never) => void);
    return () => set!.delete(fn as (e: never) => void);
  }

  emit<K extends keyof Events>(type: K, e: Events[K]) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) (fn as (e: Events[K]) => void)(e);
  }
}
