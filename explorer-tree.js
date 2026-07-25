"use strict";

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

if (typeof module !== "undefined") {
  module.exports = { renderImageNodes };
} else {
  window.renderImageNodes = renderImageNodes;
}
