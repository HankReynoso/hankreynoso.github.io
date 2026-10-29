// Browser-only stand-in for the Price Tracker's Python server (server.py + app/), for the portfolio demo.
// It ports the server's demo prices (app/demo.py), offer filtering (app/offers.py) and product logic
// (app/tracker.py), and keeps products in this browser's localStorage instead of data/*.json.
// Source: https://github.com/HankReynoso/Price-Tracker
(() => {
  const STORES = ["Amazon", "Walmart", "Best Buy", "Target", "eBay", "B&H Photo", "Newegg", "Costco"];
  const KEY_PRODUCTS = "pt-demo-products";
  const KEY_SETTINGS = "pt-demo-settings";
  const MAX_HISTORY = 200;
  const DAY = 86400000;
  const DEFAULT_SETTINGS = { daily_checks: false, stores: [] };

  // ---- Seeded randomness (stands in for Python's random.Random(seed)) ----
  function hash(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
  }
  function rng(seed) {
    let a = hash(seed) >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      uniform: (lo, hi) => lo + (hi - lo) * next(),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      choice: (list) => list[Math.floor(next() * list.length)],
      sample(list, k) {
        const pool = [...list];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, k);
      },
    };
  }

  // ---- app/demo.py: sample shopping results in SerpApi's shape ----
  // Typical prices for the starter products, so their numbers look believable; anything else gets a seeded price.
  const KNOWN_PRICES = {
    "sony wh-1000xm5": 330,
    "nintendo switch oled": 340,
    "apple airpods pro 2": 220,
    "kitchenaid artisan stand mixer": 430,
  };

  function demoSearch(query, day) {
    const seed = query.toLowerCase();
    const base = KNOWN_PRICES[seed] ?? rng(seed).uniform(40, 600);
    // Reseeded per day so checks on different days show price movement.
    const r = rng(`${seed}:${day}`);
    const link = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
    const results = r.sample(STORES, 6).map((store) => {
      const price = Math.round(base * r.uniform(0.85, 1.15)) - 0.01;
      return {
        title: query,
        source: store,
        extracted_price: price,
        product_link: link,
        delivery: r.choice(["Free delivery", "Free 2-day delivery", "$5.99 delivery", null]),
        rating: Math.round(r.uniform(3.8, 4.9) * 10) / 10,
        reviews: r.int(20, 9000),
      };
    });
    // Listings the filters should hide: a used unit and a cheap accessory.
    results.push({ title: `${query} (Renewed)`, source: "Amazon", extracted_price: Math.round(base * 60) / 100 });
    results.push({ title: `Case for ${query}`, source: "eBay", extracted_price: 12.99 });
    return results;
  }

  // ---- app/offers.py: one clean, comparable offer per store ----
  const USED_RE = /\b(used|refurbished|renewed|pre-?owned|open[- ]box|second[- ]hand|for parts)\b/i;
  const STOPWORDS = new Set(["the", "and", "for", "with", "a", "an", "of", "in", "new", "by"]);
  const OUTLIER_RATIO = 0.4;
  const MIN_RELEVANCE = 0.5;

  function tokens(text) {
    const words = text.toLowerCase().match(/[a-z0-9]+(?:[-./][a-z0-9]+)*/g) || [];
    return words.filter((w) => !STOPWORDS.has(w)).map((w) => w.replace(/[-./]/g, "")).filter((w) => w.length >= 2);
  }
  function relevance(query, title) {
    const wanted = tokens(query);
    if (wanted.length <= 1) return 1;
    const have = new Set(tokens(title));
    const joined = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    return wanted.filter((w) => have.has(w) || joined.includes(w)).length / wanted.length;
  }
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function buildOffers(raw, query) {
    const hidden = { used: 0, unrelated: 0 };
    let offers = [];
    for (const r of raw) {
      const offer = {
        store: (r.source || "").replace(/\s+-\s+.*$/, "") || "Unknown store",
        title: r.title || "",
        price: r.extracted_price,
        url: r.product_link,
        delivery: r.delivery ?? null,
        rating: r.rating ?? null,
        reviews: r.reviews ?? null,
      };
      if (USED_RE.test(offer.title)) hidden.used++;
      else if (relevance(query, offer.title) < MIN_RELEVANCE) hidden.unrelated++;
      else offers.push(offer);
    }
    if (offers.length >= 3) {
      const floor = median(offers.map((o) => o.price)) * OUTLIER_RATIO;
      const kept = offers.filter((o) => o.price >= floor);
      hidden.unrelated += offers.length - kept.length;
      offers = kept;
    }
    const best = new Map();
    for (const o of offers) {
      const key = o.store.toLowerCase();
      if (!best.has(key) || o.price < best.get(key).price) best.set(key, o);
    }
    offers = [...best.values()].sort((a, b) => a.price - b.price);
    return { offers, hidden, lowest: offers[0] ?? null, highest: offers.at(-1)?.price ?? null, image: null };
  }

  // ---- app/resolve.py: a search name from a name or a product link ----
  const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
  function resolveName(query) {
    query = query.trim();
    if (/\s/.test(query) || !URL_RE.test(query)) return { name: query.split(/\s+/).join(" "), url: null };
    const url = /^https?:\/\//i.test(query) ? query : `https://${query}`;
    // The real server reads the page; a browser can't, so use the server's URL-slug fallback.
    let best = "";
    for (let segment of new URL(url).pathname.split("/")) {
      try { segment = decodeURIComponent(segment); } catch {}
      segment = segment.replace(/\.(html?|php|aspx?)$/i, "");
      const words = segment.split(/[-_+]+/).filter(Boolean);
      if (words.filter((w) => /[a-z]/i.test(w)).length >= 2 && words.length > best.split(" ").filter(Boolean).length) {
        best = words.join(" ");
      }
    }
    const name = best.split(" ").slice(0, 12).join(" ");
    if (!name) throw httpError("Couldn't read a product name from that link. Try typing the product name instead.", 422);
    return { name, url };
  }

  // ---- Storage ----
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  let memory = null; // used when localStorage is unavailable
  const products = {
    all: () => memory ?? read(KEY_PRODUCTS, null),
    save: (items) => { memory = items; write(KEY_PRODUCTS, items); },
  };
  const settings = {
    get: () => ({ ...DEFAULT_SETTINGS, ...read(KEY_SETTINGS, {}) }),
    update(changes) {
      const next = { ...settings.get(), ...changes };
      write(KEY_SETTINGS, next);
      return next;
    },
  };

  // ---- app/tracker.py ----
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

  function httpError(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
  }
  function apply(product, at = Date.now()) {
    const result = buildOffers(demoSearch(product.name, dayOf(at)), product.name);
    Object.assign(product, result, { image: null, checked_at: iso(at), demo: true });
    if (result.lowest) {
      product.history.push({
        at: product.checked_at,
        price: result.lowest.price,
        store: result.lowest.store,
        prices: Object.fromEntries(result.offers.map((o) => [o.store, o.price])),
      });
      product.history = product.history.slice(-MAX_HISTORY);
    }
    return product;
  }
  function blank(name, url, at) {
    return { id: newId(), name, source_url: url, page_image: null, created_at: iso(at), target_price: null, history: [] };
  }

  // First visit: a few products with three weeks of checks, so the history charts have something to show.
  function seed() {
    const now = Date.now();
    const items = [
      ["Sony WH-1000XM5", 299],
      ["Nintendo Switch OLED", null],
      ["Apple AirPods Pro 2", 199],
      ["KitchenAid Artisan Stand Mixer", null],
    ].map(([name, target]) => {
      const p = blank(name, null, now - 21 * DAY);
      for (let d = 21; d >= 0; d -= 3) apply(p, now - d * DAY - (d ? 3600000 : 0));
      p.target_price = target;
      return p;
    });
    products.save(items);
    return items;
  }
  function list() {
    return products.all() ?? seed();
  }
  function get(id) {
    const p = list().find((x) => x.id === id);
    if (!p) throw httpError("Product not found", 404);
    return p;
  }
  function upsert(product) {
    const items = list();
    const i = items.findIndex((p) => p.id === product.id);
    if (i === -1) items.unshift(product);
    else items[i] = product;
    products.save(items);
    return product;
  }
  const findByName = (name, exclude) =>
    list().find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== exclude);

  function refreshDue() {
    if (!settings.get().daily_checks) return;
    const now = Date.now();
    list().forEach((p) => now - new Date(p.checked_at) >= DAY && upsert(apply(p, now)));
  }

  // ---- server.py routes ----
  function parseChanges(body) {
    if (!body || !("name" in body || "target_price" in body)) throw httpError("Send a name or target_price to change.");
    const changes = {};
    if ("name" in body) {
      const name = String(body.name ?? "").split(/\s+/).filter(Boolean).join(" ");
      if (!name || name.length > 200) throw httpError("Enter a product name.");
      changes.name = name;
    }
    if ("target_price" in body) {
      let t = body.target_price;
      if (t !== null) {
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) throw httpError("Target price must be a positive number.");
        t = Math.round(t * 100) / 100;
      }
      changes.target_price = t;
    }
    return changes;
  }

  function route(method, path, body) {
    let m;
    if (method === "GET" && path === "/api/status") return [200, { demo: true, ...settings.get() }];
    if (method === "GET" && path === "/api/products") return [200, list()];
    if (method === "POST" && path === "/api/products") {
      const query = String(body.query ?? "").trim();
      if (!query) throw httpError("Enter a product name or link.");
      const { name, url } = resolveName(query);
      const existing = findByName(name);
      if (existing) return [200, upsert(apply(existing))];
      return [201, upsert(apply(blank(name, url, Date.now())))];
    }
    if (method === "POST" && (m = path.match(/^\/api\/products\/([0-9a-f]+)\/refresh$/))) {
      return [200, upsert(apply(get(m[1])))];
    }
    if (method === "PATCH" && path === "/api/settings") {
      const changes = {};
      if ("daily_checks" in body) changes.daily_checks = !!body.daily_checks;
      if (Array.isArray(body.stores)) changes.stores = [...new Set(body.stores.map((s) => String(s).trim()))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      const saved = settings.update(changes);
      if (changes.daily_checks) refreshDue();
      return [200, saved];
    }
    if ((m = path.match(/^\/api\/products\/([0-9a-f]+)$/))) {
      if (method === "PATCH") {
        const changes = parseChanges(body);
        const product = get(m[1]);
        if ("target_price" in changes) product.target_price = changes.target_price;
        if ("name" in changes && changes.name !== product.name) {
          if (findByName(changes.name, product.id)) throw httpError(`You're already tracking “${changes.name}”.`, 409);
          Object.assign(product, { name: changes.name, history: [] });
          apply(product);
        }
        return [200, upsert(product)];
      }
      if (method === "DELETE") {
        get(m[1]);
        products.save(list().filter((p) => p.id !== m[1]));
        return [200, { ok: true }];
      }
    }
    throw httpError("Not found", 404);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Same contract as app.js's fetch-based api(): resolves with the JSON body or throws Error(message).
  window.demoApi = async function demoApi(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    let body = {};
    try { body = options.body ? JSON.parse(options.body) : {}; } catch {}
    // A short pause so "Searching stores…" and "Checking prices…" read as they do against a real search.
    if (method !== "GET" && !path.endsWith("/settings")) await wait(method === "POST" ? 700 : 300);
    const [, data] = route(method, path, body);
    return JSON.parse(JSON.stringify(data));
  };

  // Stands in for the server's hourly background checker.
  refreshDue();
})();
