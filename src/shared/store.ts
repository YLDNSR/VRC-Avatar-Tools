// Persistent settings backed by the main-process JSON store.

interface StoreBridge {
  store: { all(): Record<string, any>; set(key: string, value: any): void };
}

const bridge = (window as any).vav as StoreBridge;
const cache: Record<string, any> = bridge ? bridge.store.all() : {};

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** Returns a settings object merged over defaults; call save() after mutating. */
export function persisted<T extends object>(key: string, defaults: T): T & { save(): void } {
  const stored = cache[key];
  const value: any = Object.assign(clone(defaults), stored && typeof stored === 'object' ? stored : {});
  Object.defineProperty(value, 'save', {
    enumerable: false,
    value() {
      const plain = JSON.parse(JSON.stringify(value));
      cache[key] = plain;
      bridge?.store.set(key, plain);
    },
  });
  return value;
}

export function getValue<T>(key: string, def: T): T {
  return cache[key] !== undefined ? cache[key] : def;
}

export function setValue(key: string, value: any) {
  cache[key] = value;
  bridge?.store.set(key, value);
}
