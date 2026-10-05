// sw.js'yi node'da sahte bir `self` + sahte Cache Storage içinde çalıştırır (service worker testleri için ortak).
// Gerçek Request/Response/FormData/File nesneleri Node'un kendisinden gelir (undici).
//
//     const sw = await loadSw();
//     await sw.fire("activate");
//     const { responded } = sw.fetch(new Request(...));    // respondWith çağrıldıysa Response, yoksa undefined

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SW_PATH = fileURLToPath(new URL("../frontend/sw.js", import.meta.url));

/** Basit Cache Storage: ad -> Map(url -> Response). */
export function fakeCaches(initial = {}) {
  const store = new Map();
  const keyOf = (request) => (typeof request === "string" ? new URL(request, "https://example.test/").href
    : request.url);
  const make = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      async put(request, response) { entries.set(keyOf(request), response); },
      async add(request) { entries.set(keyOf(request), new Response("shell")); },
      async match(request) {
        const hit = entries.get(keyOf(request));
        return hit ? hit.clone() : undefined;
      },
      async delete(request) { return entries.delete(keyOf(request)); },
      async keys() { return [...entries.keys()].map((url) => new Request(url)); },
    };
  };
  const api = {
    store,
    async open(name) { return make(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(request) {
      for (const entries of store.values()) {
        const hit = entries.get(keyOf(request));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  for (const name of Object.keys(initial)) make(name);
  return api;
}

export async function loadSw({ caches = fakeCaches(), fetch = async () => new Response("net"),
                               location = "https://example.test/stem-mikser/sw.js" } = {}) {
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0, unregister: 0 };
  const self = {
    location: new URL(location),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    skipWaiting() { calls.skipWaiting += 1; return Promise.resolve(); },
    clients: { claim() { calls.claim += 1; return Promise.resolve(); } },
    registration: { unregister() { calls.unregister += 1; return Promise.resolve(true); } },
  };
  const sandbox = {
    self, caches, fetch, Request, Response, URL, URLSearchParams, Headers, FormData, Blob, File, crypto,
    console: { ...console, warn() {} }, setTimeout, clearTimeout, Promise, Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, "utf8"), sandbox, { filename: "sw.js" });

  /** Olayı ateşler; waitUntil/respondWith sözlerini döndürür. */
  const fire = async (type, init = {}) => {
    let responded;
    const waits = [];
    const event = { ...init, respondWith(value) { responded = Promise.resolve(value); }, waitUntil(value) { waits.push(value); } };
    for (const fn of handlers[type] || []) fn(event);
    await Promise.all(waits);
    return { responded: responded ? await responded : undefined, waits: waits.length };
  };
  return { self, caches, calls, handlers, fire, fetch: (request) => fire("fetch", { request }) };
}
