"use strict";

const assert = require("node:assert/strict");
const { compareFileNames } = require("../explorer-tree.js");

const sortNames = (names) =>
  names.map((name) => ({ name })).sort(compareFileNames).map((file) => file.name);

assert.deepEqual(
  sortNames(["10.jpg", "2.jpg", "1.jpg", "11.jpg"]),
  ["1.jpg", "2.jpg", "10.jpg", "11.jpg"],
  "Unpadded page numbers sort by value, not as text",
);
assert.deepEqual(
  sortNames(["page_10.png", "page_9.png", "page_100.png"]),
  ["page_9.png", "page_10.png", "page_100.png"],
  "Numbers after a common prefix sort by value",
);
assert.deepEqual(
  sortNames(["010.jpg", "002.jpg", "001.jpg"]),
  ["001.jpg", "002.jpg", "010.jpg"],
  "Zero-padded names keep their order",
);

console.log("PASS: Image files sort in reading order");
