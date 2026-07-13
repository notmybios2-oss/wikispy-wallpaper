/*
 * Hover card: tracking an object eases the drift to a stop (see world.js);
 * shortly after the world has stopped, a rounded panel appears with the
 * Wikipedia showcase and an Apple-style Wikipedia button.
 */
(function () {
  'use strict';

  window.WSW = window.WSW || {};

  var MIN_DWELL_MS = 500;     // minimum focus time before a card can appear
  var STOPPED_MS = 300;       // required stillness after the drift stops
  var FALLBACK_DWELL_MS = 1100; // used when interaction damping is disabled
  var STICKY_MS = 260;        // tolerate brief hover loss (mask gaps, drift)
  var GRACE_MS = 450;         // delay before hiding after hover truly ends
  var SWITCH_MS = 450;        // hovering a DIFFERENT object this long refocuses;
                              // brushing objects on the way to the card is ignored
  var EDGE = 12;              // viewport clamp margin
  var GAP = 16;               // distance from object edge
  var CARD_PAD = 10;          // pointer slack around the card keep-alive rect

  var el = null;
  var parts = null;
  var current = null;         // object record the card belongs to
  var candidate = null;       // object record being focused
  var dwellMs = 0;
  var stoppedMs = 0;
  var lostMs = 0;
  var switchMs = 0;
  var visible = false;

  function build() {
    el = document.createElement('div');
    el.id = 'card';
    el.innerHTML =
      '<div class="card-title"></div>' +
      '<div class="card-desc"></div>' +
      '<div class="card-extract"></div>' +
      '<div class="card-footer">' +
        '<span class="card-attrib"></span>' +
        '<button class="card-block" type="button" title="Block this item or its category">✕</button>' +
        '<button class="card-wiki" type="button" title="Copy the Wikipedia link">' +
          '<span class="card-wiki-w">W</span><span class="card-wiki-label">Copy link</span>' +
        '</button>' +
      '</div>' +
      '<div class="card-blockchoice" hidden>' +
        '<button class="card-block-item" type="button">Block this item</button>' +
        '<button class="card-block-term" type="button"></button>' +
        '<button class="card-block-broad" type="button"></button>' +
        '<button class="card-block-cancel" type="button" title="Cancel">↩ Cancel</button>' +
      '</div>';
    document.body.appendChild(el);
    parts = {
      title: el.querySelector('.card-title'),
      desc: el.querySelector('.card-desc'),
      extract: el.querySelector('.card-extract'),
      attrib: el.querySelector('.card-attrib'),
      wiki: el.querySelector('.card-wiki'),
      footer: el.querySelector('.card-footer'),
      block: el.querySelector('.card-block'),
      choice: el.querySelector('.card-blockchoice'),
      blockItem: el.querySelector('.card-block-item'),
      blockTerm: el.querySelector('.card-block-term'),
      blockBroad: el.querySelector('.card-block-broad'),
      blockCancel: el.querySelector('.card-block-cancel')
    };
    parts.wiki.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!current || !current.articleUrl) return;
      copyLink(current.articleUrl);
    });
    parts.block.addEventListener('click', function (e) {
      e.stopPropagation();
      setBlockMode(true);
    });
    parts.blockCancel.addEventListener('click', function (e) {
      e.stopPropagation();
      setBlockMode(false);
    });
    parts.blockItem.addEventListener('click', function (e) {
      e.stopPropagation();
      if (current && current.src && WSW.blocks) WSW.blocks.blockItem(current.src);
      hide(); // purge fades the object itself
    });
    parts.blockTerm.addEventListener('click', function (e) {
      e.stopPropagation();
      var term = parts.blockTerm.dataset.term;
      if (term && WSW.blocks) WSW.blocks.blockTerm(term, 'title');
      hide();
    });
    parts.blockBroad.addEventListener('click', function (e) {
      e.stopPropagation();
      var term = parts.blockBroad.dataset.term;
      if (term && WSW.blocks) WSW.blocks.blockTerm(term, 'broad');
      hide();
    });
  }

  /*
   * Wallpaper Engine blocks opening browsers from wallpapers, so the button
   * copies the article link instead. navigator.clipboard needs a secure
   * context, which the wallpaper runtime may not be, so fall back to a
   * temporary textarea + execCommand.
   */
  function copyLink(url) {
    var done = function (ok) { flashButton(ok); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () {
        done(legacyCopy(url));
      });
    } else {
      done(legacyCopy(url));
    }
  }

  function legacyCopy(url) {
    var ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  var flashTimer = null;
  function flashButton(ok) {
    var label = el.querySelector('.card-wiki-label');
    label.textContent = ok ? 'Link copied ✓' : 'Copy failed';
    parts.wiki.classList.add(ok ? 'copied' : 'copy-failed');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      label.textContent = 'Copy link';
      parts.wiki.classList.remove('copied', 'copy-failed');
    }, 1600);
  }

  function setBlockMode(on) {
    parts.footer.hidden = !!on;
    parts.choice.hidden = !on;
    if (on && current) {
      // Specific: head noun of the title (e.g. "xanthogramma").
      var term = WSW.blocks ? WSW.blocks.categoryTerm(current.title) : null;
      parts.blockTerm.style.display = term ? '' : 'none';
      parts.blockTerm.textContent = term ? 'Block “' + term + '”' : '';
      parts.blockTerm.dataset.term = term || '';
      // Broad: category word from the description (e.g. "spider"). Only
      // shown when it exists and differs from the specific term.
      var broad = WSW.blocks && WSW.blocks.broadTerm ? WSW.blocks.broadTerm(current.src) : null;
      var showBroad = broad && broad !== term;
      parts.blockBroad.style.display = showBroad ? '' : 'none';
      parts.blockBroad.textContent = showBroad ? 'Block all “' + broad + '”' : '';
      parts.blockBroad.dataset.term = showBroad ? broad : '';
    }
  }

  function fill(o) {
    setBlockMode(false);
    parts.title.textContent = o.title || 'Untitled';
    parts.desc.textContent = o.description || '';
    parts.desc.style.display = o.description ? '' : 'none';
    parts.extract.textContent = o.extract || '';
    parts.extract.style.display = o.extract ? '' : 'none';
    var attrib = [];
    if (o.artist) attrib.push(o.artist);
    if (o.license) attrib.push(o.license);
    parts.attrib.textContent = attrib.join(' · ');
    parts.wiki.style.display = o.articleUrl ? '' : 'none';
  }

  function place(o, cam) {
    var sx = o.x - cam.x * o.f;
    var sy = o.y - cam.y * o.f;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cw = el.offsetWidth, ch = el.offsetHeight;

    var x = sx + o.w + GAP;                    // prefer right of the object
    if (x + cw > vw - EDGE) x = sx - cw - GAP; // flip to the left
    if (x < EDGE) x = Math.min(vw - cw - EDGE, Math.max(EDGE, sx));
    var y = sy + o.h / 2 - ch / 2;
    y = Math.max(EDGE, Math.min(vh - ch - EDGE, y));

    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  function pointerOnCard(pointer) {
    if (!visible || !pointer.inside) return false;
    var r = el.getBoundingClientRect();
    return pointer.x >= r.left - CARD_PAD && pointer.x <= r.right + CARD_PAD &&
           pointer.y >= r.top - CARD_PAD && pointer.y <= r.bottom + CARD_PAD;
  }

  function show(o) {
    current = o;
    fill(o);
    el.classList.add('visible');
    visible = true;
  }

  function hide() {
    current = null;
    el.classList.remove('visible');
    visible = false;
  }

  /* Called every frame from the world loop. */
  function tick(dtMs, hovered, cam, pointer, motionStopped) {
    if (!el) return;
    if (!WSW.settings.cardsEnabled) {
      if (visible) hide();
      candidate = null;
      dwellMs = 0;
      stoppedMs = 0;
      return;
    }

    if (visible) {
      // The card owns the pointer: resting on it (even when another object
      // sits behind or between) keeps it open. Only a sustained hover on a
      // different object, or truly leaving, closes it.
      var onCard = pointerOnCard(pointer);
      if (onCard || hovered === current) {
        lostMs = 0;
        switchMs = 0;
      } else if (hovered) {
        switchMs += dtMs;
        lostMs = 0;
        if (switchMs >= SWITCH_MS) {
          hide();
          candidate = hovered;
          dwellMs = 0;
          stoppedMs = 0;
          switchMs = 0;
        }
      } else {
        lostMs += dtMs;
        switchMs = 0;
        if (lostMs > GRACE_MS) {
          hide();
          candidate = null;
          dwellMs = 0;
          stoppedMs = 0;
        }
      }
    } else {
      // Dwell-to-card is opt-in; the default path is a left click
      // (world.js calls forceShow), which bypasses this branch entirely.
      if (hovered && WSW.settings.hoverCardsEnabled) {
        lostMs = 0;
        if (hovered === candidate) {
          dwellMs += dtMs;
        } else {
          candidate = hovered;
          dwellMs = 0;
          stoppedMs = 0;
        }
        stoppedMs = motionStopped ? stoppedMs + dtMs : 0;

        var ready = WSW.settings.interactionEnabled
          ? (dwellMs >= MIN_DWELL_MS && stoppedMs >= STOPPED_MS)
          : dwellMs >= FALLBACK_DWELL_MS;
        if (ready) show(candidate);
      } else {
        lostMs += dtMs;
        if (lostMs > STICKY_MS) {
          candidate = null;
          dwellMs = 0;
          stoppedMs = 0;
        }
      }
    }

    if (visible && current) place(current, cam);
  }

  WSW.cards = {
    start: build,
    tick: tick,
    /* While a card is up the world holds still, so its object stays put. */
    isVisible: function () {
      return visible;
    },
    /* Clicking an object skips the dwell entirely. */
    forceShow: function (record) {
      if (!el || !record) return;
      candidate = record;
      dwellMs = 0;
      stoppedMs = 0;
      lostMs = 0;
      switchMs = 0;
      show(record);
    },
    /* True when the pointer is on the visible card (with slack). */
    onCard: function (pointer) {
      return pointerOnCard(pointer);
    },
    status: function () {
      return {
        visible: visible,
        dwellMs: Math.round(dwellMs),
        stoppedMs: Math.round(stoppedMs),
        card: current ? current.title : null
      };
    }
  };
})();
