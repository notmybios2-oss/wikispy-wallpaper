/*
 * WikiSpyClient + object feed.
 * Talks to Neal's Wiki Spy backend politely: small batches, spaced requests,
 * exponential backoff, no full-catalogue crawling.
 *
 * The API only sends CORS headers to https://neal.fun, so in a normal browser
 * we fall back to the dev proxy (/wsapi). Wallpaper Engine's CEF is expected
 * to allow the direct call; the probe picks whichever base works.
 */
(function () {
  'use strict';

  window.WSW = window.WSW || {};

  var DIRECT_BASE = 'https://wiki-spy-uaew8.ondigitalocean.app';
  var PROXY_BASE = '/wsapi';
  var SNAPSHOT_DIR = 'snapshot/';    // bundled FULL catalogue in rotating
                                     // chunks: the data source for
                                     // CORS-strict hosts (Plash/Pages)

  var BATCH_SIZE = 100;        // API serves up to 150; one big request is far
                               // kinder at Workshop scale than many small ones
  var LOW_WATER = 60;          // refill queue below this (free panning eats fast)
  var MIN_REQUEST_GAP = 2500;  // ms between requests
  var MAX_BACKOFF = 60000;
  var RESEED_AFTER_PAGES = 60; // reseed cursor so long sessions roam the catalogue
  var DEDUPE_CAP = 800;        // remember this many recent cutoutIds

  /* Offline resilience (Phase 5) */
  var CACHE_KEY = 'wsw-cache-v1';    // rolling metadata cache
  var ROUTER_KEY = 'wsw-router-v1';  // themed fallback batch, fetched once
  var CACHE_MAX = 150;
  var RECYCLE_MAX = 300;             // despawned objects reusable during outages
  var PROBE_INTERVAL = 20000;        // offline: retry the API this often even
                                     // when the cache has filled the queue
  var FAIL_SIM = /[?&]failapi=1/.test(window.location.search); // test hook

  var state = {
    base: null,
    baseLabel: 'probing',
    queue: [],
    total: 0,
    cursor: Math.random(),
    searchOffset: 0,
    pagesSinceSeed: 0,
    fetching: false,
    lastRequestAt: 0,
    failures: 0,
    lastError: '',
    fetchedCount: 0,
    mode: 'random',   // 'random' | 'search'
    query: '',
    offline: false,
    cacheSeeded: false,
    routerStored: false
  };

  var recycle = [];
  var storeCounts = { cache: -1, router: -1 }; // -1 = not read yet

  /* Cache writes are buffered: serializing 150 objects every batch is
   * wasteful, so flush at most every 45s (first batch flushes at once). */
  var CACHE_WRITE_INTERVAL = 45000;
  var pendingCache = [];
  var lastCacheWrite = 0;
  var cacheWrites = 0;

  function readStore(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return Array.isArray(data.objects) ? data.objects : null;
    } catch (e) { return null; }
  }

  function writeStore(key, objects) {
    try {
      localStorage.setItem(key, JSON.stringify({ v: 1, savedAt: Date.now(), objects: objects }));
      return true;
    } catch (e) { return false; }
  }

  function updateCache(newObjs) {
    pendingCache = pendingCache.concat(newObjs);
    var now = Date.now();
    if (lastCacheWrite && now - lastCacheWrite < CACHE_WRITE_INTERVAL) return;
    var existing = readStore(CACHE_KEY) || [];
    var byId = {};
    existing.forEach(function (o) { byId[o.cutoutId] = o; });
    pendingCache.forEach(function (o) { byId[o.cutoutId] = o; });
    var merged = Object.keys(byId).map(function (k) { return byId[k]; });
    if (merged.length > CACHE_MAX) merged = merged.slice(merged.length - CACHE_MAX);
    if (writeStore(CACHE_KEY, merged)) {
      storeCounts.cache = merged.length;
      pendingCache = [];
      lastCacheWrite = now;
      cacheWrites++;
    }
  }

  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* When the API is down and the queue runs dry, live off stored metadata. */
  function seedFromCache() {
    if (state.cacheSeeded) return 0;
    state.cacheSeeded = true;
    var seed = (readStore(ROUTER_KEY) || []).concat(readStore(CACHE_KEY) || []);
    seed = shuffled(seed);
    for (var i = 0; i < seed.length; i++) state.queue.push(seed[i]);
    return seed.length;
  }

  /* The user's chosen outage theme: keep a batch of routers forever. */
  function maybeStoreRouterBatch() {
    if (state.routerStored || !state.base) return;
    state.routerStored = true;
    if (readStore(ROUTER_KEY)) return;
    setTimeout(function () {
      fetchJson(state.base + '/search?q=router&offset=0&limit=32').then(function (data) {
        var items = (data.results || []).filter(function (o) { return o && o.url && o.width; });
        if (items.length && writeStore(ROUTER_KEY, items)) storeCounts.router = items.length;
      }).catch(function () { state.routerStored = false; /* retry after next success */ });
    }, 8000);
  }

  var seenIds = new Set();
  var seenOrder = [];

  function remember(id) {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > DEDUPE_CAP) {
      seenIds.delete(seenOrder.shift());
    }
    return true;
  }

  function fetchJson(url) {
    if (FAIL_SIM) return Promise.reject(new Error('failapi simulation'));
    return fetch(url, { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /*
   * Snapshot mode: the full catalogue lives in ~3000-object chunk files.
   * One chunk is held in memory at a time; when it runs dry the next one
   * (prefetched in the background, random order, all chunks before any
   * repeat) takes its place. Whole catalogue, small memory.
   */
  var snap = {
    manifest: null,
    order: [],      // shuffled chunk indices for this cycle
    orderPos: 0,
    pool: null,     // current chunk's objects, shuffled
    poolIdx: 0,
    nextPool: null, // prefetched next chunk
    loading: false
  };

  function chunkUrl(i) {
    var n = String(i);
    while (n.length < 3) n = '0' + n;
    return SNAPSHOT_DIR + 'chunk-' + n + '.json';
  }

  function nextChunkIndex() {
    if (snap.orderPos >= snap.order.length) {
      snap.order = shuffled(snap.order);
      snap.orderPos = 0;
    }
    return snap.order[snap.orderPos++];
  }

  function prefetchNextChunk() {
    if (snap.loading || snap.nextPool || snap.manifest.chunkCount < 2) return;
    snap.loading = true;
    fetchJson(chunkUrl(nextChunkIndex())).then(function (data) {
      snap.nextPool = shuffled(data.objects || []);
    }).catch(function () { /* retried on next refill */ }).then(function () {
      snap.loading = false;
    });
  }

  function resolveBase() {
    var probePath = '/objects?cursor=0.5&limit=1';
    return fetchJson(DIRECT_BASE + probePath).then(function () {
      state.base = DIRECT_BASE;
      state.baseLabel = 'direct';
    }).catch(function () {
      return fetchJson(PROXY_BASE + probePath).then(function () {
        state.base = PROXY_BASE;
        state.baseLabel = 'proxy';
      });
    }).catch(function () {
      return fetchJson(SNAPSHOT_DIR + 'index.json').then(function (manifest) {
        if (!manifest || !manifest.chunkCount) throw new Error('bad snapshot manifest');
        snap.manifest = manifest;
        snap.order = shuffled(Array.from({ length: manifest.chunkCount }, function (_, i) { return i; }));
        snap.orderPos = 0;
        return fetchJson(chunkUrl(nextChunkIndex()));
      }).then(function (data) {
        snap.pool = shuffled(data.objects || []);
        snap.poolIdx = 0;
        state.base = 'snapshot';
        state.baseLabel = 'snapshot';
        state.total = snap.manifest.total;
        prefetchNextChunk();
      });
    });
  }

  function refillFromSnapshot() {
    if (state.queue.length >= LOW_WATER || !snap.pool) return;
    for (var i = 0; i < BATCH_SIZE; i++) {
      if (snap.poolIdx >= snap.pool.length) {
        if (snap.nextPool && snap.nextPool.length) {
          snap.pool = snap.nextPool;   // rotate to the prefetched chunk
          snap.nextPool = null;
          prefetchNextChunk();
        } else {
          snap.pool = shuffled(snap.pool); // next chunk not ready: re-walk
          prefetchNextChunk();
        }
        snap.poolIdx = 0;
      }
      state.queue.push(snap.pool[snap.poolIdx++]);
      state.fetchedCount++;
    }
  }

  function backoffDelay() {
    if (state.failures === 0) return 0;
    return Math.min(MAX_BACKOFF, 1500 * Math.pow(2, state.failures - 1));
  }

  function applyModeFromSettings() {
    var q = (WSW.settings.searchQuery || '').trim();
    var mode = q ? 'search' : 'random';
    if (mode !== state.mode || q !== state.query) {
      state.mode = mode;
      state.query = q;
      state.queue.length = 0;
      state.searchOffset = 0;
      state.cursor = Math.random();
      state.pagesSinceSeed = 0;
      seenIds.clear();
      seenOrder.length = 0;
    }
  }

  function buildUrl() {
    if (state.mode === 'search') {
      return state.base + '/search?q=' + encodeURIComponent(state.query) +
        '&offset=' + state.searchOffset + '&limit=' + BATCH_SIZE;
    }
    return state.base + '/objects?cursor=' + state.cursor + '&limit=' + BATCH_SIZE;
  }

  function ingest(data) {
    var items = data.objects || data.results || [];
    var added = 0;
    for (var i = 0; i < items.length; i++) {
      var obj = items[i];
      if (!obj || !obj.url || !obj.width || !obj.height) continue;
      if (!remember(obj.cutoutId)) continue;
      state.queue.push(obj);
      added++;
    }
    if (data.total) state.total = data.total;

    if (state.mode === 'search') {
      state.searchOffset += BATCH_SIZE;
      // Small result sets: loop and allow repeats rather than starving.
      if (items.length < BATCH_SIZE) {
        state.searchOffset = 0;
        if (added === 0) { seenIds.clear(); seenOrder.length = 0; }
      }
    } else {
      if (data.nextCursor !== undefined) state.cursor = data.nextCursor;
      state.pagesSinceSeed++;
      if (data.wrap || state.pagesSinceSeed >= RESEED_AFTER_PAGES) {
        state.cursor = Math.random();
        state.pagesSinceSeed = 0;
      }
    }
    state.fetchedCount += added;
    if (added && state.mode === 'random') updateCache(items);
    maybeStoreRouterBatch();
  }

  function maybeFetch() {
    if (!state.base || state.fetching) return;
    if (state.base === 'snapshot') { refillFromSnapshot(); return; }
    var starving = state.queue.length < LOW_WATER;
    // Offline with a cache-filled queue still probes for the network's
    // return; otherwise recovery would wait until the cache drained.
    if (!starving && !state.offline) return;
    var now = Date.now();
    var wait = starving
      ? Math.max(MIN_REQUEST_GAP, backoffDelay())
      : Math.max(PROBE_INTERVAL, backoffDelay());
    if (now - state.lastRequestAt < wait) return;

    applyModeFromSettings();
    state.fetching = true;
    state.lastRequestAt = now;

    fetchJson(buildUrl()).then(function (data) {
      state.failures = 0;
      state.lastError = '';
      state.offline = false;
      state.cacheSeeded = false; // a fresh outage may seed again later
      ingest(data);
    }).catch(function (err) {
      state.failures++;
      state.lastError = String(err && err.message || err);
      if (state.failures >= 2) {
        state.offline = true;
        seedFromCache();
      }
    }).then(function () {
      state.fetching = false;
    });
  }

  WSW.feed = {
    start: function () {
      return resolveBase().then(function () {
        maybeFetch();
      }).catch(function (err) {
        // Boot with no API at all: live off the cache and keep retrying
        // the direct base with normal backoff until the network returns.
        state.lastError = 'No API base reachable: ' + String(err && err.message || err);
        state.baseLabel = 'unreachable';
        state.base = DIRECT_BASE;
        state.failures = 2;
        state.offline = true;
        seedFromCache();
      });
    },
    /* Called every frame; cheap when nothing to do. */
    tick: function () {
      maybeFetch();
    },
    next: function () {
      var blocked = function (o) { return WSW.blocks && WSW.blocks.isBlocked(o); };
      while (state.queue.length) {
        var o = state.queue.shift();
        if (!blocked(o)) return o;
      }
      // Outage and nothing left: reuse a despawned object. Its image was
      // just on screen, so the HTTP cache can serve it without network.
      while (state.offline && recycle.length) {
        var r = recycle.splice(Math.floor(Math.random() * recycle.length), 1)[0];
        if (!blocked(r)) return r;
      }
      return null;
    },
    /* World hands back despawned objects so outages can reuse them. */
    recycle: function (obj) {
      if (!obj || !obj.url) return;
      recycle.push(obj);
      if (recycle.length > RECYCLE_MAX) recycle.shift();
    },
    available: function () {
      return state.queue.length;
    },
    status: function () {
      return {
        base: state.baseLabel,
        queue: state.queue.length,
        total: state.total,
        fetched: state.fetchedCount,
        failures: state.failures,
        lastError: state.lastError,
        mode: state.mode,
        query: state.query,
        offline: state.offline,
        recycle: recycle.length,
        cacheWrites: cacheWrites,
        cachePending: pendingCache.length,
        cached: storeCounts.cache < 0 ? (storeCounts.cache = (readStore(CACHE_KEY) || []).length) : storeCounts.cache,
        router: storeCounts.router < 0 ? (storeCounts.router = (readStore(ROUTER_KEY) || []).length) : storeCounts.router
      };
    }
  };

  WSW.onSettingsChanged(function (keys) {
    if (keys.indexOf('searchQuery') !== -1) {
      applyModeFromSettings();
      maybeFetch();
    }
  });
})();
