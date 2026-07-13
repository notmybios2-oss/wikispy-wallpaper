/*
 * Block list: hide specific items (by cutoutId) or whole categories (terms).
 * Terms carry a scope:
 *   'title' — the head noun of the title, matched as a substring of titles
 *             (specific, e.g. "xanthogramma").
 *   'broad' — a category word derived from the description, matched as a
 *             WHOLE WORD against title + description (e.g. "spider", which
 *             catches Latin-named species whose description is
 *             "Species of spider"). Whole-word so "spider" ignores
 *             "spiderwort".
 * Persisted in localStorage; managed/reverted via an in-wallpaper overlay
 * because Wallpaper Engine's settings bridge is read-only.
 */
(function () {
  'use strict';

  window.WSW = window.WSW || {};

  var STORE_KEY = 'wsw-blocks-v1';
  // Classifier/connector words that precede the real category in a
  // description ("Species of spider" -> spider, not species/of).
  var STOPWORDS = {
    of: 1, the: 1, a: 1, an: 1, to: 1, for: 1, and: 1, in: 1, on: 1, or: 1,
    with: 1, used: 1, type: 1, kind: 1, form: 1, group: 1, species: 1,
    genus: 1, breed: 1, family: 1, class: 1, order: 1, member: 1, part: 1
  };

  var blocks = { items: [], terms: [] }; // items:{id,title}; terms:{term,scope}
  var itemIds = {};
  var titleTerms = [];   // lowercased substrings (scope 'title')
  var broadRes = [];     // { term, re } whole-word matchers (scope 'broad')
  var panel = null;

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.items) && Array.isArray(data.terms)) blocks = data;
      }
    } catch (e) { /* corrupted store: start clean */ }
    // Migrate pre-scope terms (they were title substrings).
    blocks.terms.forEach(function (t) { if (!t.scope) t.scope = 'title'; });
    reindex();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(blocks)); } catch (e) { /* full */ }
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function reindex() {
    itemIds = {};
    blocks.items.forEach(function (it) { itemIds[it.id] = true; });
    titleTerms = [];
    broadRes = [];
    blocks.terms.forEach(function (t) {
      if (t.scope === 'broad') {
        broadRes.push({ term: t.term, re: new RegExp('\\b' + escapeRe(t.term) + '\\b') });
      } else {
        titleTerms.push(t.term);
      }
    });
  }

  function isBlocked(obj) {
    if (!obj) return false;
    if (obj.cutoutId !== undefined && itemIds[obj.cutoutId]) return true;
    var title = (obj.title || '').toLowerCase();
    for (var i = 0; i < titleTerms.length; i++) {
      if (title.indexOf(titleTerms[i]) !== -1) return true;
    }
    if (broadRes.length) {
      var text = title + ' ' + (obj.description || '').toLowerCase();
      for (var j = 0; j < broadRes.length; j++) {
        if (broadRes[j].re.test(text)) return true;
      }
    }
    return false;
  }

  /* Specific: head noun of the title. "Wolf spider" -> "spider";
     "Carrhotus xanthogramma" -> "xanthogramma"; "Punch (drink)" -> "punch" */
  function categoryTerm(title) {
    var t = String(title || '').replace(/\(.*?\)/g, ' ').trim();
    var words = t.split(/[\s\-–—_/,]+/).filter(Boolean);
    if (!words.length) return null;
    var w = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    return w.length >= 3 ? w : null;
  }

  /* Broad: the category word from the description. "Species of spider"
     -> "spider"; "Breed of dog" -> "dog". Null when nothing sensible. */
  function broadTerm(obj) {
    var src = (obj && obj.description || '').toLowerCase();
    if (!src) return null;
    var words = src.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (var i = words.length - 1; i >= 0; i--) {
      if (!STOPWORDS[words[i]] && words[i].length >= 3) return words[i];
    }
    return null;
  }

  function changed() {
    reindex();
    save();
    if (WSW.world && WSW.world.purgeBlocked) WSW.world.purgeBlocked();
    render();
  }

  /* ---- manager overlay ---- */

  function build() {
    panel = document.createElement('div');
    panel.id = 'blocks';
    panel.hidden = true;
    document.body.appendChild(panel);
    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-kind]');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.kind === 'term') {
        blocks.terms = blocks.terms.filter(function (t) {
          return !(t.term === btn.dataset.value && t.scope === btn.dataset.scope);
        });
      } else {
        blocks.items = blocks.items.filter(function (it) { return String(it.id) !== btn.dataset.value; });
      }
      changed();
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    if (!panel || panel.hidden) return;
    var html = '<div class="blocks-title">Blocked</div>';
    if (!blocks.terms.length && !blocks.items.length) {
      html += '<div class="blocks-empty">Nothing blocked. Use the ✕ on an item card.</div>';
    }
    if (blocks.terms.length) {
      html += '<div class="blocks-section">Categories</div>';
      blocks.terms.forEach(function (t) {
        var tag = t.scope === 'broad' ? ' <span class="blocks-scope">all</span>' : '';
        html += '<div class="blocks-row"><span>“' + esc(t.term) + '”' + tag + '</span>' +
          '<button type="button" data-kind="term" data-value="' + esc(t.term) +
          '" data-scope="' + esc(t.scope || 'title') + '" title="Unblock">✕</button></div>';
      });
    }
    if (blocks.items.length) {
      html += '<div class="blocks-section">Items</div>';
      blocks.items.forEach(function (it) {
        html += '<div class="blocks-row"><span>' + esc(it.title || ('#' + it.id)) + '</span>' +
          '<button type="button" data-kind="item" data-value="' + esc(it.id) + '" title="Unblock">✕</button></div>';
      });
    }
    panel.innerHTML = html;
  }

  function applyVisibility() {
    if (!panel) return;
    panel.hidden = !WSW.settings.showBlocksUi;
    render();
  }

  WSW.blocks = {
    start: function () {
      load();
      build();
      applyVisibility();
      WSW.onSettingsChanged(function (keys) {
        if (keys.indexOf('showBlocksUi') !== -1) applyVisibility();
      });
    },
    isBlocked: isBlocked,
    categoryTerm: categoryTerm,
    broadTerm: broadTerm,
    blockItem: function (obj) {
      if (!obj || obj.cutoutId === undefined || itemIds[obj.cutoutId]) return;
      blocks.items.push({ id: obj.cutoutId, title: obj.title || '' });
      changed();
    },
    blockTerm: function (term, scope) {
      term = String(term || '').toLowerCase().trim();
      scope = scope === 'broad' ? 'broad' : 'title';
      if (!term) return;
      if (blocks.terms.some(function (t) { return t.term === term && t.scope === scope; })) return;
      blocks.terms.push({ term: term, scope: scope });
      changed();
    },
    counts: function () {
      return { items: blocks.items.length, terms: blocks.terms.length };
    }
  };
})();
