"use strict";

const assert = require("node:assert/strict");
const { renderImageNodes } = require("../explorer-tree.js");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.listeners = new Map();
  }

  appendChild(child) {
    this.children.push(child);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    this.listeners.get("click")?.();
  }
}

const documentStub = {
  createElement: (tagName) => new Element(tagName),
};
const container = new Element("div");
const file = { name: "cover.jpg" };
let selectedFile = null;

renderImageNodes([file], container, (selected) => {
  selectedFile = selected;
}, documentStub);

assert.deepEqual(
  container.children.map((node) => node.textContent),
  ["cover.jpg"],
  "Explorer should show image names in the selected folder",
);
assert.equal(container.children[0].tagName, "button");
assert.equal(container.children[0].title, "cover.jpg");
container.children[0].click();
assert.equal(selectedFile, file, "Explorer should select the clicked image file");
console.log("PASS: Explorer shows images in the selected folder");
