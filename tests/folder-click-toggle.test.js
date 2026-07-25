"use strict";

const assert = require("node:assert/strict");
const { selectAndToggleFolder } = require("../explorer-tree.js");

function createToggle() {
  const attributes = new Map([["aria-expanded", "false"]]);
  return {
    title: "",
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

(async () => {
  const toggle = createToggle();
  const childContainer = { style: {} };
  let selections = 0;
  const select = async () => {
    selections += 1;
  };

  await selectAndToggleFolder(toggle, childContainer, select);
  assert.equal(selections, 1);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(childContainer.style.display, "block");

  await selectAndToggleFolder(toggle, childContainer, select);
  assert.equal(selections, 2);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(childContainer.style.display, "none");
  console.log("PASS: Folder click selects and toggles expansion");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
