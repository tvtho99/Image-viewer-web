"use strict";

const assert = require("node:assert/strict");
const { clampPan, zoomAt } = require("../modal-zoom.js");

// Points are relative to the viewer centre; the image is drawn at x + scale * p.
assert.deepEqual(
  zoomAt({ scale: 1, x: 0, y: 0 }, 2, 400, -100),
  { scale: 2, x: -400, y: 100 },
  "Zooming in keeps the image point under the cursor fixed",
);
assert.deepEqual(
  zoomAt({ scale: 2, x: -400, y: 100 }, 4, 0, 0),
  { scale: 4, x: -800, y: 200 },
  "Zooming an already panned image keeps the centre point fixed",
);
assert.deepEqual(
  zoomAt({ scale: 1, x: 0, y: 0 }, 3, 0, 0),
  { scale: 3, x: 0, y: 0 },
  "Zooming at the centre keeps the image centred",
);

// A 1000x800 image at 2x in a 1000x600 viewport overflows by 500px per side.
assert.deepEqual(
  clampPan({ scale: 2, x: 900, y: 200 }, 1000, 800, 1000, 600),
  { scale: 2, x: 500, y: 200 },
  "Panning stops at the image edge",
);
assert.deepEqual(
  clampPan({ scale: 2, x: -900, y: -700 }, 1000, 800, 1000, 600),
  { scale: 2, x: -500, y: -500 },
  "Panning stops at the opposite image edge",
);
assert.deepEqual(
  clampPan({ scale: 0.5, x: 300, y: -40 }, 1000, 800, 1000, 600),
  { scale: 0.5, x: 0, y: 0 },
  "An image smaller than the viewport stays centred",
);

console.log("PASS: Modal zoom keeps the cursor point fixed and pan inside the image");
