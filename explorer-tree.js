"use strict";

function setFolderExpanded(toggle, childContainer, expanded) {
  childContainer.style.display = expanded ? "block" : "none";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.title = expanded ? "Collapse folder" : "Expand folder";
}

async function selectAndToggleFolder(toggle, childContainer, onSelect) {
  const expanded = toggle.getAttribute("aria-expanded") !== "true";
  await onSelect();
  setFolderExpanded(toggle, childContainer, expanded);
}

function renderImageNodes(files, container, onSelect, documentRef = document) {
  files.forEach((file) => {
    const item = documentRef.createElement("button");
    item.type = "button";
    item.className = "image-file";
    item.textContent = file.name;
    item.title = file.name;
    if (onSelect) {
      item.addEventListener("click", () => onSelect(file));
    }
    container.appendChild(item);
  });
}

const explorerTree = {
  renderImageNodes,
  selectAndToggleFolder,
  setFolderExpanded,
};

if (typeof module !== "undefined") {
  module.exports = explorerTree;
} else {
  Object.assign(window, explorerTree);
}
