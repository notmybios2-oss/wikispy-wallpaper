/*
 * World renderer: ambient camera drift, middle-mouse free panning, parallax
 * layers, object spawning/cleanup, and the focus interaction (tracking an
 * object eases the drift to a stop before the hover card appears).
 *
 * Model: an infinite world. Each layer is a DOM container translated by
 * -camera * layerFactor. Objects spawn in a strip along the edge the camera
 * is moving toward and are removed once far behind. No wrapping, no loops.
 */
(function () {
  'use strict';

  window.WSW = window.WSW || {};

  var BASE_MAX_DIM = 210;      // px at 1080p before scale multipliers
  var AREA_PER_OBJECT = 30000; // px^2 of screen per object at density 1
  var SPAWN_TRIES = 9;
  var DT_CLAMP = 0.25;         // seconds; guards against tab-sleep jumps
  var PAN_INERTIA_TAU = 1.0;   // seconds; glide decay after releasing a pan
  var PAN_MAX_VEL = 2600;      // px/sec cap on pan glide
  var DRIFT_RESUME_DELAY = 1.2;   // seconds after a pan before drift returns
  var DRIFT_RESUME_RAMP = 1.6;    // seconds to ramp drift back to full

  var PARALLAX_LAYERS = [
    { factor: 0.55, scale: 0.68, share: 0.26, opacity: 0.55 },
    { factor: 0.78, scale: 0.85, share: 0.32, opacity: 0.80 },
    { factor: 1.00, scale: 1.00, share: 0.42, opacity: 1.00 }
  ];
  var FLAT_LAYERS = [
    { factor: 1.00, scale: 1.00, share: 1.00, opacity: 1.00 }
  ];

  var root = null;
  var layers = [];          // { def, el, objects: [] }
  var cam = { x: 0, y: 0 };
  var camPrev = { x: 0, y: 0 };
  var vw = 0, vh = 0;
  var wanderPhase = Math.random() * 1000;
  var speedFactor = 1;      // focus damping (eased toward 0 when tracking)
  var pointer = { x: -1, y: -1, inside: false };
  var hovered = null;
  var dragging = false;
  var dragButton = -1;             // which button started the grab (0 or 1)
  var leftDown = false;            // left held but not yet a drag
  var leftDownPos = { x: 0, y: 0 };
  var DRAG_START_PX = 6;           // movement beyond this turns a click into a drag
  var dragLast = { x: 0, y: 0 };
  // Desktop-icon guard: a real empty-desktop grab carries buttons&1 the whole
  // time; icon drags/clicks that leak through Wallpaper Engine tend to arrive
  // with buttons=0 (OS captured the button for its own drag). We only trust
  // this signal once we've seen it work, so browsers and odd runtimes that
  // never populate `buttons` fall back to the old behavior instead of breaking.
  var buttonsReliable = false;
  var lastInput = { type: '-', button: -1, buttons: -1, over: false };
  // The decisive diagnostic: the most recent left mousedown's button bitmask,
  // whether it landed over an item, and whether the guard let it arm a click.
  var lastDown = { buttons: -1, over: false, armed: false };
  var panVel = { x: 0, y: 0 };     // camera px/sec from pan/stir inertia
  var lastPanAt = -1e9;            // performance.now()/1000 of last pan input

  // Stir the cosmos: sustained fast pointer sweeps push the world.
  var STIR_THRESHOLD = 1500;       // px/sec pointer speed (scaled by viewport)
  var STIR_SUSTAIN_MS = 120;       // must stay fast this long before stirring
  var STIR_TELEPORT = 260;         // px in one event = monitor jump, ignore
  var stir = {
    lastX: 0, lastY: 0, lastT: 0, speed: 0,
    chargeMs: 0, belowMs: 0, active: false,
    impulse: { x: 0, y: 0 }
  };
  var motionStopped = false;
  var measuredFps = 0;
  var frameCount = 0;
  var fpsWindowStart = 0;
  var lastFrameTime = 0;
  var fpsAccumulator = 0;
  var running = false;
  var initialFill = true;
  var imgErrors = 0;
  var clicksSeen = { left: 0, middle: 0, right: 0, wheel: 0 }; // diagnoses WE input forwarding

  /* Idle short-circuit: when nothing moves, skip per-frame DOM/scan work. */
  var pointerMoved = false;
  var appliedCamX = NaN;      // last camera applied to layer transforms
  var lastMaintenance = 0;    // cleanup+spawn cadence while idle
  var idleSkips = 0;          // diagnostic

  /* Adaptive density: shed objects when FPS can't keep up, recover slowly. */
  var densityScale = 1;
  var lowStreak = 0;
  var healthyStreak = 0;

  function dirVector() {
    var deg = WSW.settings.directionDeg;
    if (WSW.settings.wanderEnabled) {
      var t = performance.now() / 1000 + wanderPhase;
      deg += Math.sin(t * 0.037) * 8 + Math.sin(t * 0.011) * 4;
    }
    var rad = deg * Math.PI / 180;
    return { x: Math.sin(rad), y: -Math.cos(rad) };
  }

  function unitScale() {
    return (vh / 1080) || 1;
  }

  function buildLayers() {
    var defs = WSW.settings.parallaxEnabled ? PARALLAX_LAYERS : FLAT_LAYERS;
    for (var i = 0; i < layers.length; i++) layers[i].el.remove();
    layers = defs.map(function (def) {
      var el = document.createElement('div');
      el.className = 'ws-layer';
      el.style.opacity = def.opacity;
      root.appendChild(el);
      return { def: def, el: el, objects: [] };
    });
    initialFill = true;
    appliedCamX = NaN; // force transform writes on the fresh layers
  }

  function targetCount(layer) {
    var total = (vw * vh) / AREA_PER_OBJECT * WSW.settings.density * densityScale;
    if (WSW.settings.lowPowerEnabled) total *= 0.5;
    total = Math.min(total, 200); // 4K/multi-monitor safety cap
    return Math.max(1, Math.round(total * layer.def.share));
  }

  function effectiveFpsLimit() {
    var limit = WSW.settings.fpsLimit;
    if (WSW.settings.lowPowerEnabled) return limit > 0 ? Math.min(24, limit) : 24;
    return limit;
  }

  function viewRect(layer) {
    var f = layer.def.factor;
    return { x: cam.x * f, y: cam.y * f, w: vw, h: vh };
  }

  function expandRect(r, m) {
    return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
  }

  function margin() {
    return BASE_MAX_DIM * unitScale() * Math.max(1, WSW.settings.objectScale) * 1.4;
  }

  function displaySize(obj, layer) {
    var maxDim = Math.max(obj.width, obj.height);
    var variety = 0.5 + Math.random() * 0.85;
    var target = BASE_MAX_DIM * unitScale() * variety;
    var s = Math.min(target / maxDim, 1.15); // avoid heavy upscaling blur
    s *= WSW.settings.objectScale * layer.def.scale;
    return { w: obj.width * s, h: obj.height * s };
  }

  function tooClose(layer, cx, cy, size) {
    var objs = layer.objects;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      var ox = o.x + o.w / 2, oy = o.y + o.h / 2;
      var minDist = (Math.max(o.w, o.h) + Math.max(size.w, size.h)) * 0.5 * 0.62;
      var dx = ox - cx, dy = oy - cy;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
    return false;
  }

  /*
   * camDir is the direction the camera moved this frame (normalized), or
   * null when it barely moved: then any deficit is filled across the whole
   * expanded rect instead of an entry strip.
   */
  function pickSpawnPos(layer, size, camDir) {
    var m = margin();
    var R = expandRect(viewRect(layer), m);
    for (var attempt = 0; attempt < SPAWN_TRIES; attempt++) {
      var x, y;
      if (initialFill || !camDir) {
        x = R.x + Math.random() * R.w;
        y = R.y + Math.random() * R.h;
      } else {
        var ax = Math.abs(camDir.x), ay = Math.abs(camDir.y);
        var useX = Math.random() < ax / (ax + ay || 1);
        if (useX) {
          x = camDir.x < 0 ? R.x + Math.random() * m : R.x + R.w - m + Math.random() * m;
          y = R.y + Math.random() * R.h;
        } else {
          y = camDir.y < 0 ? R.y + Math.random() * m : R.y + R.h - m + Math.random() * m;
          x = R.x + Math.random() * R.w;
        }
      }
      if (!tooClose(layer, x, y, size)) return { x: x - size.w / 2, y: y - size.h / 2 };
    }
    return null;
  }

  function spawnOne(layer, camDir) {
    var obj = WSW.feed.next();
    if (!obj) return false;
    var size = displaySize(obj, layer);
    var pos = pickSpawnPos(layer, size, camDir);
    if (!pos) return false;
    var img = document.createElement('img');
    img.className = 'ws-obj';
    img.decoding = 'async';
    img.src = obj.url;
    img.style.width = size.w.toFixed(1) + 'px';
    img.style.height = size.h.toFixed(1) + 'px';
    img.style.transform = 'translate3d(' + pos.x.toFixed(1) + 'px,' + pos.y.toFixed(1) + 'px,0)';
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () {
      imgErrors++;
      removeObject(layer, record);
    });
    layer.el.appendChild(img);
    var record = {
      el: img, x: pos.x, y: pos.y, w: size.w, h: size.h,
      f: layer.def.factor, src: obj,
      title: obj.title, articleUrl: obj.articleUrl || obj.pageUrl,
      description: obj.description || '',
      extract: (obj.extract || '').slice(0, 360),
      artist: (obj.artist || '').slice(0, 80),
      license: obj.license || '',
      mask: WSW.mask ? WSW.mask.decode(obj.mask) : null
    };
    layer.objects.push(record);
    return true;
  }

  function removeObject(layer, record) {
    var idx = layer.objects.indexOf(record);
    if (idx !== -1) layer.objects.splice(idx, 1);
    record.el.remove();
  }

  function cleanupLayer(layer) {
    var m = margin();
    var R = expandRect(viewRect(layer), m * 2.5);
    for (var i = layer.objects.length - 1; i >= 0; i--) {
      var o = layer.objects[i];
      if (o.x + o.w < R.x || o.x > R.x + R.w || o.y + o.h < R.y || o.y > R.y + R.h) {
        layer.objects.splice(i, 1);
        o.el.remove();
        WSW.feed.recycle(o.src); // reusable if the API goes down
      }
    }
  }

  function updateHover() {
    hovered = null;
    if (!pointer.inside || dragging) return;
    for (var li = layers.length - 1; li >= 0; li--) {
      var layer = layers[li];
      var f = layer.def.factor;
      var wx = pointer.x + cam.x * f;
      var wy = pointer.y + cam.y * f;
      var objs = layer.objects;
      for (var i = objs.length - 1; i >= 0; i--) {
        var o = objs[i];
        if (wx >= o.x && wx <= o.x + o.w && wy >= o.y && wy <= o.y + o.h) {
          if (WSW.mask && !WSW.mask.hit(o.mask, (wx - o.x) / o.w, (wy - o.y) / o.h)) continue;
          hovered = o;
          return;
        }
      }
    }
  }

  function step(dt, nowSec) {
    var s = WSW.settings;

    // Focus damping: tracking an object (or having its card open) eases the
    // drift to a full stop.
    var focusing = hovered || (WSW.cards && WSW.cards.isVisible());
    var damp = (s.interactionEnabled && focusing) ? 0 : 1;
    var ease = 1 - Math.exp(-dt / 0.55);
    speedFactor += (damp - speedFactor) * ease;

    // Drift is suppressed while panning and ramps back afterward.
    var sincePan = nowSec - lastPanAt;
    var driftWeight = dragging ? 0 :
      Math.max(0, Math.min(1, (sincePan - DRIFT_RESUME_DELAY) / DRIFT_RESUME_RAMP));

    var driftSpeed = (s.motionEnabled ? s.speed : 0) * speedFactor * driftWeight;
    var v = dirVector();
    cam.x -= v.x * driftSpeed * dt;
    cam.y -= v.y * driftSpeed * dt;

    settleStir(dt);

    // Pan glide after release.
    if (!dragging && (panVel.x || panVel.y)) {
      var decay = Math.exp(-dt / PAN_INERTIA_TAU);
      panVel.x *= decay;
      panVel.y *= decay;
      if (Math.abs(panVel.x) < 2 && Math.abs(panVel.y) < 2) { panVel.x = 0; panVel.y = 0; }
      cam.x += panVel.x * dt;
      cam.y += panVel.y * dt;
    }

    // Camera motion this frame drives the spawn entry edge and spawn rate.
    var cdx = cam.x - camPrev.x, cdy = cam.y - camPrev.y;
    camPrev.x = cam.x; camPrev.y = cam.y;
    var camSpeed = Math.sqrt(cdx * cdx + cdy * cdy) / (dt || 1e-6);
    var camDir = camSpeed * dt > 0.01
      ? { x: cdx, y: cdy }
      : null;

    motionStopped = !dragging && camSpeed < 0.5;
    var camMoved = Math.abs(cdx) > 0.001 || Math.abs(cdy) > 0.001;

    // Idle short-circuit: with a still camera, transforms cannot change and
    // cleanup/spawn only needs an occasional pass (density/resize changes).
    var writeTransforms = camMoved || isNaN(appliedCamX);
    var maintain = camMoved || initialFill || (nowSec - lastMaintenance > 0.5);
    if (!writeTransforms && !maintain) idleSkips++;

    var maxSpawns = initialFill ? 6 : Math.max(3, Math.min(10, Math.ceil(camSpeed / 60)));

    for (var li = 0; li < layers.length; li++) {
      var layer = layers[li];
      var f = layer.def.factor;
      if (writeTransforms) {
        layer.el.style.transform =
          'translate3d(' + (-cam.x * f).toFixed(2) + 'px,' + (-cam.y * f).toFixed(2) + 'px,0)';
      }
      if (maintain) {
        cleanupLayer(layer);
        var deficit = targetCount(layer) - layer.objects.length;
        var spawns = Math.min(deficit, maxSpawns);
        for (var k = 0; k < spawns; k++) {
          if (!spawnOne(layer, camDir)) break;
        }
      }
    }
    if (writeTransforms) appliedCamX = cam.x;
    if (maintain) lastMaintenance = nowSec;

    if (initialFill) {
      var done = layers.every(function (l) {
        return l.objects.length >= targetCount(l) * 0.9;
      });
      if (done) initialFill = false;
    }

    // Hover can only change when the pointer or the world moved.
    if (pointerMoved || camMoved || maintain) {
      updateHover();
      pointerMoved = false;
    }
    if (WSW.cards) {
      WSW.cards.tick(dt * 1000, hovered, cam, pointer, motionStopped);
    }
    WSW.feed.tick();
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);

    var fpsLimit = effectiveFpsLimit();
    if (fpsLimit > 0) {
      var interval = 1000 / fpsLimit;
      fpsAccumulator += now - (lastFrameTime || now);
      lastFrameTime = now;
      if (fpsAccumulator < interval) return;
      var dt = Math.min(fpsAccumulator / 1000, DT_CLAMP);
      fpsAccumulator = fpsAccumulator % interval;
      step(dt, now / 1000);
    } else {
      var dtMs = now - (lastFrameTime || now);
      lastFrameTime = now;
      step(Math.min(dtMs / 1000, DT_CLAMP), now / 1000);
    }

    frameCount++;
    if (now - fpsWindowStart >= 1000) {
      measuredFps = frameCount * 1000 / (now - fpsWindowStart);
      frameCount = 0;
      fpsWindowStart = now;

      // Adaptive density: three low seconds shed 10% of objects; ten
      // healthy seconds recover 5%, back up to the configured density.
      var limit = effectiveFpsLimit();
      var baseline = limit > 0 ? limit : 60;
      if (measuredFps < baseline * 0.85) {
        lowStreak++;
        healthyStreak = 0;
        if (lowStreak >= 3) {
          densityScale = Math.max(0.4, densityScale * 0.9);
          lowStreak = 0;
        }
      } else {
        healthyStreak++;
        lowStreak = 0;
        if (healthyStreak >= 10 && densityScale < 1) {
          densityScale = Math.min(1, densityScale * 1.05);
          healthyStreak = 0;
        }
      }
    }
  }

  /* ---- input ---- */

  function trackStir(e) {
    if (!WSW.settings.stirEnabled || dragging) return;
    var nowSec = performance.now() / 1000;
    var dtp = nowSec - stir.lastT;
    var dx = e.clientX - stir.lastX;
    var dy = e.clientY - stir.lastY;
    stir.lastX = e.clientX;
    stir.lastY = e.clientY;
    stir.lastT = nowSec;
    if (dtp <= 0 || dtp > 0.12) { stir.speed = 0; return; }       // idle gap
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > STIR_TELEPORT) { stir.speed = 0; return; }         // monitor jump
    var inst = dist / dtp;
    stir.speed = stir.speed * 0.6 + inst * 0.4;

    var threshold = STIR_THRESHOLD * unitScale();
    if (stir.speed >= threshold) {
      stir.chargeMs += dtp * 1000;
      stir.belowMs = 0;
      if (stir.chargeMs >= STIR_SUSTAIN_MS) {
        if (!stir.active) { stir.active = true; stir.impulse.x = 0; stir.impulse.y = 0; }
        // Camera velocity is opposite pointer motion so content follows the sweep.
        var k = 1.6 * WSW.settings.stirStrength;
        panVel.x = Math.max(-PAN_MAX_VEL, Math.min(PAN_MAX_VEL, panVel.x - dx * k));
        panVel.y = Math.max(-PAN_MAX_VEL, Math.min(PAN_MAX_VEL, panVel.y - dy * k));
        stir.impulse.x -= dx;
        stir.impulse.y -= dy;
        lastPanAt = nowSec; // suppress drift while stirring, like a drag
      }
    }
  }

  /* Called each frame: ends a stir episode once the sweep has settled. */
  function settleStir(dt) {
    if (!stir.active) {
      if (stir.speed < STIR_THRESHOLD * unitScale() * 0.5) stir.chargeMs = 0;
      return;
    }
    if (stir.speed < STIR_THRESHOLD * unitScale() * 0.4) {
      stir.belowMs += dt * 1000;
    } else {
      stir.belowMs = 0;
    }
    stir.speed *= Math.exp(-dt / 0.25); // decays when events stop entirely
    if (stir.belowMs >= 150 || stir.speed < 40) {
      stir.active = false;
      stir.chargeMs = 0;
      // Re-aim the ambient drift along the stir, like a middle-mouse fling.
      // impulse is camera-ward; content moves the opposite way.
      var mag = Math.sqrt(stir.impulse.x * stir.impulse.x + stir.impulse.y * stir.impulse.y);
      if (mag > 60) {
        var vx = -stir.impulse.x / mag, vy = -stir.impulse.y / mag;
        var deg = Math.atan2(vx, -vy) * 180 / Math.PI;
        WSW.settings.directionDeg = (deg + 360) % 360;
      }
      stir.impulse.x = 0;
      stir.impulse.y = 0;
    }
  }

  function startDrag(button, x, y) {
    dragging = true;
    dragButton = button;
    dragLast.x = x;
    dragLast.y = y;
    panVel.x = 0;
    panVel.y = 0;
    lastPanAt = performance.now() / 1000;
  }

  function endDrag() {
    dragging = false;
    dragButton = -1;
    lastPanAt = performance.now() / 1000;
    // Force applied in space: a real fling re-aims the ambient drift so the
    // cosmos keeps moving the way you steered it.
    var mag = Math.sqrt(panVel.x * panVel.x + panVel.y * panVel.y);
    if (mag > 120) {
      var vx = -panVel.x / mag, vy = -panVel.y / mag; // content motion direction
      var deg = Math.atan2(vx, -vy) * 180 / Math.PI;
      WSW.settings.directionDeg = (deg + 360) % 360;
    }
  }

  window.addEventListener('mousemove', function (e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
    pointerMoved = true;
    lastInput = { type: 'move', button: -1, buttons: e.buttons, over: !!hovered };
    trackStir(e);
    // A held left button becomes a grab once it travels far enough;
    // staying put keeps it a click. (The icon guard acts at mousedown, not
    // here, so a genuine drag is never cancelled by odd per-move button data.)
    if (leftDown && !dragging) {
      var mx = e.clientX - leftDownPos.x;
      var my = e.clientY - leftDownPos.y;
      if (mx * mx + my * my > DRAG_START_PX * DRAG_START_PX) {
        startDrag(0, e.clientX, e.clientY);
      }
    }
    if (dragging) {
      var dx = e.clientX - dragLast.x;
      var dy = e.clientY - dragLast.y;
      dragLast.x = e.clientX;
      dragLast.y = e.clientY;
      // Content follows the pointer: dragging right moves the world right.
      cam.x -= dx;
      cam.y -= dy;
      var nowSec = performance.now() / 1000;
      var frameDt = Math.max(1e-3, nowSec - lastPanAt);
      // Velocity estimate for the release glide (camera px/sec).
      var k = 0.35;
      panVel.x = panVel.x * (1 - k) + (-dx / frameDt) * k;
      panVel.y = panVel.y * (1 - k) + (-dy / frameDt) * k;
      panVel.x = Math.max(-PAN_MAX_VEL, Math.min(PAN_MAX_VEL, panVel.x));
      panVel.y = Math.max(-PAN_MAX_VEL, Math.min(PAN_MAX_VEL, panVel.y));
      lastPanAt = nowSec;
    }
  });

  function onUiElement(e) {
    return e.target && e.target.closest && e.target.closest('#blocks, #card button');
  }

  window.addEventListener('mousedown', function (e) {
    if (e.button === 0) clicksSeen.left++;
    else if (e.button === 1) clicksSeen.middle++;
    else if (e.button === 2) clicksSeen.right++;
    // A genuine press reports its own button in the bitmask; the first time we
    // see that, we start trusting `buttons` to reject leaked icon events.
    if (e.button === 0 && (e.buttons & 1)) buttonsReliable = true;
    lastInput = { type: 'down', button: e.button, buttons: e.buttons, over: !!hovered };
    if (onUiElement(e)) return; // UI clicks must not start pans
    if (!WSW.settings.panEnabled) return;
    // Skip presses the OS says have no button actually held (icon leak).
    var heldOk = !buttonsReliable || (e.buttons & 1);
    if (e.button === 1) {
      e.preventDefault();
      startDrag(1, e.clientX, e.clientY);
    } else if (e.button === 0 && heldOk) {
      leftDown = true;
      leftDownPos.x = e.clientX;
      leftDownPos.y = e.clientY;
    }
    if (e.button === 0) lastDown = { buttons: e.buttons, over: !!hovered, armed: leftDown };
  });

  window.addEventListener('mouseup', function (e) {
    lastInput = { type: 'up', button: e.button, buttons: e.buttons, over: !!hovered };
    if (e.button === 1 && dragging && dragButton === 1) {
      endDrag();
      return;
    }
    if (e.button === 0) {
      if (dragging && dragButton === 0) {
        endDrag();
      } else if (leftDown && hovered && WSW.settings.cardsEnabled &&
                 WSW.cards && !WSW.cards.onCard(pointer)) {
        // A plain click on an object opens its card. Clicks on the card
        // itself must not refocus objects behind it.
        WSW.cards.forceShow(hovered);
      }
      leftDown = false;
    }
  });

  window.addEventListener('mouseout', function () {
    pointer.inside = false;
    pointerMoved = true; // hover must re-evaluate (and clear)
    leftDown = false;
    if (dragging) endDrag();
  });

  // Middle-click autoscroll cursor must not appear in browsers.
  window.addEventListener('auxclick', function (e) {
    if (e.button === 1 && WSW.settings.panEnabled) e.preventDefault();
  });

  window.addEventListener('wheel', function () {
    clicksSeen.wheel++; // diagnostic only: does WE forward wheel events?
  }, { passive: true });

  window.addEventListener('resize', function () {
    vw = window.innerWidth;
    vh = window.innerHeight;
  });

  WSW.onSettingsChanged(function (keys) {
    if (keys.indexOf('parallaxEnabled') !== -1) buildLayers();
    if (keys.indexOf('backgroundColor') !== -1) {
      document.body.style.background = WSW.settings.backgroundColor;
    }
  });

  WSW.world = {
    start: function () {
      root = document.getElementById('world');
      vw = window.innerWidth;
      vh = window.innerHeight;
      document.body.style.background = WSW.settings.backgroundColor;
      buildLayers();
      running = true;
      fpsWindowStart = performance.now();
      requestAnimationFrame(frame);
    },
    /* Fade out anything on screen that just became blocked. */
    purgeBlocked: function () {
      if (!WSW.blocks) return;
      for (var li = 0; li < layers.length; li++) {
        var layer = layers[li];
        for (var i = layer.objects.length - 1; i >= 0; i--) {
          var o = layer.objects[i];
          if (WSW.blocks.isBlocked(o.src)) {
            layer.objects.splice(i, 1);
            o.el.classList.remove('loaded'); // opacity transition back to 0
            (function (elm) { setTimeout(function () { elm.remove(); }, 1600); })(o.el);
            if (hovered === o) hovered = null;
          }
        }
      }
      lastMaintenance = 0; // refill the gaps promptly even while idle
    },
    status: function () {
      var counts = layers.map(function (l) { return l.objects.length; });
      return {
        fps: measuredFps,
        cam: { x: Math.round(cam.x), y: Math.round(cam.y) },
        objects: counts,
        targets: layers.map(targetCount),
        hovered: hovered ? hovered.title : null,
        dragging: dragging,
        panVel: { x: Math.round(panVel.x), y: Math.round(panVel.y) },
        stir: { active: stir.active, speed: Math.round(stir.speed) },
        clicks: clicksSeen,
        lastInput: lastInput,
        lastDown: lastDown,
        buttonsReliable: buttonsReliable,
        speedFactor: speedFactor,
        motionStopped: motionStopped,
        densityScale: densityScale,
        idleSkips: idleSkips,
        imgErrors: imgErrors,
        initialFill: initialFill
      };
    }
  };
})();
