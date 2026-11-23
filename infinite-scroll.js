"use strict";

const EDGE_EPSILON = 2;
const EDGE_SCROLL_THRESHOLD = 160;
const EDGE_RESET_DELAY_MS = 350;
const EDGE_SWITCH_COOLDOWN_MS = 800;

function getScrollEdgeState(
  { scrollTop = 0, clientHeight = 0, scrollHeight = 0 },
  epsilon = EDGE_EPSILON,
) {
  const atTop = scrollTop <= epsilon;
  const atBottom = scrollTop + clientHeight >= scrollHeight - epsilon;
  return { atTop, atBottom };
}

function createEdgeScrollController({
  threshold = EDGE_SCROLL_THRESHOLD,
  resetDelayMs = EDGE_RESET_DELAY_MS,
  cooldownMs = EDGE_SWITCH_COOLDOWN_MS,
} = {}) {
  let direction = 0;
  let accumulated = 0;
  let lastInputAt = 0;
  let cooldownUntil = 0;
  let locked = false;

  function reset() {
    direction = 0;
    accumulated = 0;
    lastInputAt = 0;
  }

  function setLocked(isLocked) {
    locked = Boolean(isLocked);
    if (locked) {
      direction = 0;
      accumulated = 0;
    }
  }

  function startCooldown(now = Date.now()) {
    cooldownUntil = now + cooldownMs;
    direction = 0;
    accumulated = 0;
  }

  function feed({ deltaY, atTop, atBottom, now = Date.now() }) {
    if (locked || now < cooldownUntil || !deltaY) {
      direction = 0;
      accumulated = 0;
      return { trigger: 0, progress: 0, direction: 0 };
    }

    const dir = deltaY > 0 ? 1 : -1;
    const atEdge = (dir === 1 && atBottom) || (dir === -1 && atTop);
    if (!atEdge) {
      direction = 0;
      accumulated = 0;
      return { trigger: 0, progress: 0, direction: 0 };
    }

    if (dir !== direction || now - lastInputAt > resetDelayMs) {
      accumulated = 0;
      direction = dir;
    }

    lastInputAt = now;
    accumulated += Math.abs(deltaY);
    const progress = Math.min(1, accumulated / threshold);

    if (accumulated >= threshold) {
      direction = 0;
      accumulated = 0;
      return { trigger: dir, progress: 1, direction: dir };
    }

    return { trigger: 0, progress, direction: dir };
  }

  return {
    feed,
    reset,
    setLocked,
    startCooldown,
  };
}

const infiniteScroll = {
  EDGE_EPSILON,
  EDGE_SCROLL_THRESHOLD,
  EDGE_RESET_DELAY_MS,
  EDGE_SWITCH_COOLDOWN_MS,
  getScrollEdgeState,
  createEdgeScrollController,
};

if (typeof module !== "undefined") {
  module.exports = infiniteScroll;
} else {
  Object.assign(window, infiniteScroll);
}
