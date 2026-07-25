"use strict";

const assert = require("node:assert/strict");
const {
  setSizeControlMode,
  stepManhwaWidth,
} = require("../image-size-controls.js");

assert.equal(stepManhwaWidth(30, -1), 25);
assert.equal(stepManhwaWidth(30, 1), 35);
assert.equal(stepManhwaWidth(10, -1), 10);
assert.equal(stepManhwaWidth(100, 1), 100);

const manhwaControl = {};
const mangaControl = {};
setSizeControlMode("manhwa", manhwaControl, mangaControl);
assert.equal(manhwaControl.hidden, false);
assert.equal(mangaControl.hidden, true);
setSizeControlMode("manga", manhwaControl, mangaControl);
assert.equal(manhwaControl.hidden, true);
assert.equal(mangaControl.hidden, false);

console.log("PASS: Image size controls step within bounds and follow mode");
