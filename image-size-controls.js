"use strict";

function stepManhwaWidth(currentWidth, direction) {
  return Math.min(100, Math.max(10, currentWidth + direction * 5));
}

function setSizeControlMode(mode, manhwaControl, mangaControl) {
  manhwaControl.hidden = mode !== "manhwa";
  mangaControl.hidden = mode !== "manga";
}

const imageSizeControls = { setSizeControlMode, stepManhwaWidth };

if (typeof module !== "undefined") {
  module.exports = imageSizeControls;
} else {
  Object.assign(window, imageSizeControls);
}
