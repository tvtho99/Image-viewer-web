"use strict";

// Zoom/pan math for the Manga modal. A view is { scale, x, y }: the image is
// scaled around its centre (transform-origin: center) and then translated by
// (x, y). Points are given relative to the viewer centre.

function zoomAt(view, scale, pointX, pointY) {
  const ratio = scale / view.scale;
  return {
    scale,
    x: pointX - ratio * (pointX - view.x),
    y: pointY - ratio * (pointY - view.y),
  };
}

// Allow panning only as far as the scaled image overflows the viewport.
function clampPan(view, imageWidth, imageHeight, viewportWidth, viewportHeight) {
  const maxX = Math.max(0, (imageWidth * view.scale - viewportWidth) / 2);
  const maxY = Math.max(0, (imageHeight * view.scale - viewportHeight) / 2);
  return {
    scale: view.scale,
    x: Math.min(maxX, Math.max(-maxX, view.x)) || 0,
    y: Math.min(maxY, Math.max(-maxY, view.y)) || 0,
  };
}

const modalZoom = { clampPan, zoomAt };

if (typeof module !== "undefined") {
  module.exports = modalZoom;
} else {
  Object.assign(window, modalZoom);
}
