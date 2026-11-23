"use strict";

const assert = require("node:assert/strict");
const {
  EDGE_EPSILON,
  EDGE_SCROLL_THRESHOLD,
  EDGE_RESET_DELAY_MS,
  EDGE_SWITCH_COOLDOWN_MS,
  getScrollEdgeState,
  createEdgeScrollController,
} = require("../infinite-scroll.js");

// getScrollEdgeState: top, middle, bottom, epsilon, and short content
assert.deepEqual(
  getScrollEdgeState({ scrollTop: 0, clientHeight: 800, scrollHeight: 3000 }),
  { atTop: true, atBottom: false },
);

assert.deepEqual(
  getScrollEdgeState({ scrollTop: 500, clientHeight: 800, scrollHeight: 3000 }),
  { atTop: false, atBottom: false },
);

assert.deepEqual(
  getScrollEdgeState({ scrollTop: 2200, clientHeight: 800, scrollHeight: 3000 }),
  { atTop: false, atBottom: true },
);

// Epsilon tolerance
assert.deepEqual(
  getScrollEdgeState({ scrollTop: EDGE_EPSILON, clientHeight: 800, scrollHeight: 3000 }),
  { atTop: true, atBottom: false },
);
assert.deepEqual(
  getScrollEdgeState({ scrollTop: EDGE_EPSILON + 1, clientHeight: 800, scrollHeight: 3000 }),
  { atTop: false, atBottom: false },
);
assert.deepEqual(
  getScrollEdgeState({
    scrollTop: 3000 - 800 - EDGE_EPSILON,
    clientHeight: 800,
    scrollHeight: 3000,
  }),
  { atTop: false, atBottom: true },
);

// Short content (fits inside viewport): both edges are active
assert.deepEqual(
  getScrollEdgeState({ scrollTop: 0, clientHeight: 800, scrollHeight: 600 }),
  { atTop: true, atBottom: true },
);

// No trigger when not at edge
{
  const ctrl = createEdgeScrollController();
  const res = ctrl.feed({ deltaY: 300, atTop: false, atBottom: false, now: 1000 });
  assert.deepEqual(res, { trigger: 0, progress: 0, direction: 0 });
}

// Accumulates wheel delta at bottom -> triggers +1 at threshold
{
  const ctrl = createEdgeScrollController();
  let res = ctrl.feed({ deltaY: 80, atTop: false, atBottom: true, now: 1000 });
  assert.equal(res.trigger, 0);
  assert.equal(res.direction, 1);
  assert.equal(res.progress, 80 / EDGE_SCROLL_THRESHOLD);

  res = ctrl.feed({
    deltaY: EDGE_SCROLL_THRESHOLD - 80,
    atTop: false,
    atBottom: true,
    now: 1100,
  });
  assert.deepEqual(res, { trigger: 1, progress: 1, direction: 1 });
}

// Accumulates wheel delta at top -> triggers -1 at threshold
{
  const ctrl = createEdgeScrollController();
  let res = ctrl.feed({ deltaY: -100, atTop: true, atBottom: false, now: 2000 });
  assert.equal(res.trigger, 0);
  assert.equal(res.direction, -1);
  assert.equal(res.progress, 100 / EDGE_SCROLL_THRESHOLD);

  res = ctrl.feed({
    deltaY: -(EDGE_SCROLL_THRESHOLD - 100),
    atTop: true,
    atBottom: false,
    now: 2100,
  });
  assert.deepEqual(res, { trigger: -1, progress: 1, direction: -1 });
}

// Resets accumulation after resetDelayMs idle gap
{
  const ctrl = createEdgeScrollController();
  let res = ctrl.feed({ deltaY: 120, atTop: false, atBottom: true, now: 1000 });
  assert.equal(res.trigger, 0);
  assert.equal(res.progress, 120 / EDGE_SCROLL_THRESHOLD);

  // Idle longer than EDGE_RESET_DELAY_MS -> resets prior 120, only counts new 80
  res = ctrl.feed({
    deltaY: 80,
    atTop: false,
    atBottom: true,
    now: 1000 + EDGE_RESET_DELAY_MS + 1,
  });
  assert.equal(res.trigger, 0);
  assert.equal(res.progress, 80 / EDGE_SCROLL_THRESHOLD);
}

// Resets accumulation on direction reversal or leaving edge
{
  const ctrl = createEdgeScrollController();
  ctrl.feed({ deltaY: 120, atTop: false, atBottom: true, now: 1000 });
  // Reverse direction while not at top -> resets
  let res = ctrl.feed({ deltaY: -50, atTop: false, atBottom: true, now: 1050 });
  assert.deepEqual(res, { trigger: 0, progress: 0, direction: 0 });
  // Scrolling down again starts from 0
  res = ctrl.feed({ deltaY: 60, atTop: false, atBottom: true, now: 1100 });
  assert.equal(res.trigger, 0);
  assert.equal(res.progress, 60 / EDGE_SCROLL_THRESHOLD);

  // Leaving edge resets
  ctrl.feed({ deltaY: 40, atTop: false, atBottom: false, now: 1150 });
  res = ctrl.feed({ deltaY: 60, atTop: false, atBottom: true, now: 1200 });
  assert.equal(res.trigger, 0);
  assert.equal(res.progress, 60 / EDGE_SCROLL_THRESHOLD);
}

// Suppresses triggers while locked and during cooldownMs after startCooldown
{
  const ctrl = createEdgeScrollController();
  ctrl.setLocked(true);
  assert.deepEqual(
    ctrl.feed({ deltaY: 500, atTop: false, atBottom: true, now: 3000 }),
    { trigger: 0, progress: 0, direction: 0 },
  );

  ctrl.setLocked(false);
  ctrl.startCooldown(3000);
  assert.deepEqual(
    ctrl.feed({
      deltaY: 500,
      atTop: false,
      atBottom: true,
      now: 3000 + EDGE_SWITCH_COOLDOWN_MS - 1,
    }),
    { trigger: 0, progress: 0, direction: 0 },
  );

  const afterCooldown = ctrl.feed({
    deltaY: EDGE_SCROLL_THRESHOLD,
    atTop: false,
    atBottom: true,
    now: 3000 + EDGE_SWITCH_COOLDOWN_MS,
  });
  assert.deepEqual(afterCooldown, { trigger: 1, progress: 1, direction: 1 });
}

// Short content (atTop && atBottom) triggers +1 on downward scroll and -1 on upward scroll
{
  const ctrl = createEdgeScrollController();
  assert.deepEqual(
    ctrl.feed({ deltaY: EDGE_SCROLL_THRESHOLD, atTop: true, atBottom: true, now: 5000 }),
    { trigger: 1, progress: 1, direction: 1 },
  );
  assert.deepEqual(
    ctrl.feed({ deltaY: -EDGE_SCROLL_THRESHOLD, atTop: true, atBottom: true, now: 5100 }),
    { trigger: -1, progress: 1, direction: -1 },
  );
}

console.log("PASS: Infinite scroll edge detection and threshold controller");
