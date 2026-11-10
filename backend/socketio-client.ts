// Drop-in for the parts of `socket.io-client` the UI uses
// (ui/src/client/socketioStore.ts), connected in memory to the in-browser
// backend instead of a server. ui/vite.config.ts aliases the package here.
//
// Behaves like socket.io towards the UI: events arrive asynchronously and in
// order, "connect" comes before the first event, a dropped connection
// ("transport close", e.g. Troubleshoot → Restart Backend) is retried until
// the backend is back, and an explicit disconnect() stays disconnected.

import { getBackend } from "./browser.ts";
import type { ConnectionHandle } from "./browser.ts";

type Listener = (...args: any[]) => void;

const RECONNECT_MS = 1000;

export class Socket {
  readonly nsp: string;
  connected = false;
  private active = false;
  private handle: ConnectionHandle | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Map<string, Set<Listener>>();
  /** Increments per connection, so events of an old one are dropped. */
  private session = 0;
  private queue: (() => void)[] = [];
  private flushScheduled = false;

  constructor(nsp: string) {
    this.nsp = nsp;
  }

  get disconnected() {
    return !this.connected;
  }

  on(name: string, fn: Listener) {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(name?: string, fn?: Listener) {
    if (!name) this.listeners.clear();
    else if (!fn) this.listeners.delete(name);
    else this.listeners.get(name)?.delete(fn);
    return this;
  }

  connect() {
    if (this.active) return this;
    this.active = true;
    this.tryOpen();
    return this;
  }

  open() {
    return this.connect();
  }

  disconnect() {
    this.active = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.connected) {
      this.handle?.disconnect();
      this.handle = undefined;
      this.connected = false;
      this.session++;
      this.fire("disconnect", "io client disconnect");
    }
    return this;
  }

  close() {
    return this.disconnect();
  }

  private tryOpen() {
    this.retryTimer = undefined;
    if (!this.active || this.connected) return;
    const session = ++this.session;
    // the backend sends its initial events from inside connect(); they are
    // delivered after "connect"
    let opening = true;
    const initial: unknown[] = [];
    const deliver = (e: unknown) =>
      this.enqueue(() => {
        if (this.session === session) this.fire("event", e);
      });
    const handle = getBackend().connect(this.nsp, {
      emit: (e) => {
        // a real transport hands the UI a fresh copy of every message
        const copy = structuredClone(e);
        if (opening) initial.push(copy);
        else deliver(copy);
      },
      close: () => {
        if (this.session !== session || !this.connected) return;
        this.handle = undefined;
        this.connected = false;
        this.session++;
        this.enqueue(() => this.fire("disconnect", "transport close"));
        this.scheduleRetry();
      },
    });
    opening = false;
    if (!handle) {
      // backend is "down": refused, as a real server would; retry
      this.scheduleRetry();
      return;
    }
    this.handle = handle;
    this.connected = true;
    this.enqueue(() => {
      if (this.session === session) this.fire("connect");
    });
    for (const e of initial) deliver(e);
  }

  private scheduleRetry() {
    if (!this.active || this.retryTimer) return;
    this.retryTimer = setTimeout(() => this.tryOpen(), RECONNECT_MS);
  }

  private enqueue(fn: () => void) {
    this.queue.push(fn);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const queue = this.queue;
      this.queue = [];
      for (const f of queue) f();
    }, 0);
  }

  private fire(name: string, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`${this.nsp} "${name}" handler:`, e);
      }
    }
  }
}

/** `io(url, opts)`: the namespace is the URL's path; the origin is ignored. */
export function io(url: string, opts: { autoConnect?: boolean } = {}): Socket {
  const nsp = new URL(url, window.location.href).pathname;
  const socket = new Socket(nsp);
  if (opts.autoConnect !== false) socket.connect();
  return socket;
}

export default io;
