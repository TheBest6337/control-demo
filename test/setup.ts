// jsdom lacks a few browser APIs that UI modules touch at import time.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
await import("../ui/src/browser-shim.ts");
