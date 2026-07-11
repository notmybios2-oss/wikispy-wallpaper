/*
 * Debug overlay: API status, FPS, object counts, hover state.
 * Hidden unless the debugoverlay property (or ?debug=1 / 'd' key) enables it.
 */
(function () {
  'use strict';

  window.WSW = window.WSW || {};

  var el = null;
  var timer = null;

  function render() {
    if (!WSW.settings.debugOverlay) return;
    var api = WSW.feed.status();
    var world = WSW.world.status();
    var s = WSW.settings;
    el.textContent = [
      'HUMANITY WALLPAPER — debug',
      'api: ' + api.base + '  mode: ' + api.mode + (api.query ? ' "' + api.query + '"' : ''),
      'queue: ' + api.queue + '  fetched: ' + api.fetched + '  total: ' + api.total,
      'failures: ' + api.failures + (api.offline ? '  OFFLINE (cache mode)' : '') +
        (api.lastError ? '  last: ' + api.lastError : ''),
      'cache: ' + api.cached + '  router batch: ' + api.router + '  recycle pool: ' + api.recycle +
        (WSW.blocks ? '  blocks: ' + WSW.blocks.counts().items + ' items, ' + WSW.blocks.counts().terms + ' terms' : ''),
      'fps: ' + world.fps.toFixed(1) + (s.fpsLimit ? ' (limit ' + s.fpsLimit + ')' : ' (uncapped)') +
        (s.lowPowerEnabled ? ' LOW POWER' : '') +
        (world.densityScale < 1 ? '  density scaled: ' + world.densityScale.toFixed(2) : '') +
        '  idle skips: ' + world.idleSkips,
      'objects: [' + world.objects.join(', ') + '] / targets [' + world.targets.join(', ') + ']',
      'img errors: ' + world.imgErrors + '  initial fill: ' + world.initialFill,
      'cam: ' + world.cam.x + ', ' + world.cam.y +
        '  speed: ' + s.speed + ' px/s  dir: ' + s.directionDeg + '°' +
        (s.wanderEnabled ? ' +wander' : ''),
      'pan: ' + (world.dragging ? 'dragging' : world.panVel.x + ',' + world.panVel.y) +
        '  damping: ' + world.speedFactor.toFixed(2) +
        '  stopped: ' + world.motionStopped,
      'stir: ' + (WSW.settings.stirEnabled ? (world.stir.active ? 'ACTIVE' : 'idle') : 'off') +
        '  input seen L/M/R/wheel: ' + world.clicks.left + '/' + world.clicks.middle + '/' +
        world.clicks.right + '/' + world.clicks.wheel,
      'hover: ' + (world.hovered || '—') +
        '  interaction: ' + (s.interactionEnabled ? 'on' : 'off') +
        '  cards: ' + (s.cardsEnabled ? 'on' : 'off') +
        (s.hoverCardsEnabled ? '+hover' : ''),
      'card: ' + (WSW.cards ? JSON.stringify(WSW.cards.status()) : 'n/a')
    ].join('\n');
  }

  function applyVisibility() {
    el.hidden = !WSW.settings.debugOverlay;
    if (WSW.settings.debugOverlay && !timer) {
      timer = setInterval(render, 500);
      render();
    } else if (!WSW.settings.debugOverlay && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  WSW.debug = {
    start: function () {
      el = document.getElementById('debug');
      applyVisibility();
      WSW.onSettingsChanged(function (keys) {
        if (keys.indexOf('debugOverlay') !== -1) applyVisibility();
      });
    }
  };
})();
