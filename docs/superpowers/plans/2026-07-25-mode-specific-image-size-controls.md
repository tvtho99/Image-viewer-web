# Mode-Specific Image Size Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Manhwa width dropdown with a 10–100% stepper and show exactly one size control for the active reading mode.

**Architecture:** Follow the existing `explorer-tree.js` pattern: put the two independently testable state operations in a tiny browser/CommonJS helper, then let `script.js` bind those operations to the existing page. Native buttons, `hidden`, `disabled`, and `output` provide the interaction and accessibility without dependencies.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node.js assertions.

## Global Constraints

- Manhwa width range is exactly 10–100%, inclusive.
- Each click changes width by exactly 5%.
- Manhwa shows only the width stepper; Manga shows only the existing `Small`, `Medium`, `Large` dropdown.
- Keep width state client-side only and preserve it while switching modes.
- Add no dependency, build step, or unrelated refactor.

---

### Task 1: Implement and verify mode-specific size controls

**Files:**
- Create: `image-size-controls.js`
- Create: `tests/image-size-controls.test.js`
- Modify: `index.html:39-62`
- Modify: `script.js:186-192,1191-1230,1697-1713`
- Modify: `style.css:245-280`

**Interfaces:**
- Produces: `stepManhwaWidth(currentWidth: number, direction: number): number`
- Produces: `setSizeControlMode(mode: "manga" | "manhwa", manhwaControl: HTMLElement, mangaControl: HTMLElement): void`
- Consumes: existing `maxWidthVW`, `mode`, and `updateManhwaImagesWidth()` in `script.js`

- [ ] **Step 1: Write the failing behavior test**

```js
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
```

- [ ] **Step 2: Run the test and verify the missing feature fails**

Run: `node tests/image-size-controls.test.js`

Expected: FAIL with `Cannot find module '../image-size-controls.js'`.

- [ ] **Step 3: Add the minimum reusable behavior**

```js
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
```

- [ ] **Step 4: Replace the width dropdown and separate the mode controls**

In `index.html`, replace `#modalMaxWidthSelect` with:

```html
<div
  id="manhwaWidthControl"
  class="mode-size-control size-stepper"
  aria-label="Manhwa image width"
>
  <button
    id="decreaseManhwaWidth"
    class="size-stepper-btn"
    type="button"
    aria-label="Decrease Manhwa image width"
  >−</button>
  <output id="manhwaWidthValue" aria-live="polite">30%</output>
  <button
    id="increaseManhwaWidth"
    class="size-stepper-btn"
    type="button"
    aria-label="Increase Manhwa image width"
  >+</button>
</div>
<div id="mangaSizeControl" class="mode-size-control" hidden>
  <select id="thumbSize" class="select-input" title="Thumbnail Size">
    <option value="small">Small</option>
    <option value="medium" selected>Medium</option>
    <option value="large">Large</option>
  </select>
</div>
```

Load `image-size-controls.js` immediately before `script.js`.

- [ ] **Step 5: Bind the buttons and mode visibility**

In `script.js`, cache the new elements and add:

```js
function syncManhwaWidthControl() {
  manhwaWidthValue.textContent = `${maxWidthVW}%`;
  decreaseManhwaWidth.disabled = maxWidthVW === 10;
  increaseManhwaWidth.disabled = maxWidthVW === 100;
}

function changeManhwaWidth(direction) {
  maxWidthVW = stepManhwaWidth(maxWidthVW, direction);
  syncManhwaWidthControl();
  if (mode === "manhwa") updateManhwaImagesWidth();
}

decreaseManhwaWidth.addEventListener("click", () => changeManhwaWidth(-1));
increaseManhwaWidth.addEventListener("click", () => changeManhwaWidth(1));
```

Call `setSizeControlMode(mode, manhwaWidthControl, mangaSizeControl)` after each mode change and once during initialization. Remove the Manhwa tab handler's forced reset to 30% and remove the old width-select change handler.

- [ ] **Step 6: Style the compact native stepper**

Add focused rules to `style.css`:

```css
.mode-size-control[hidden] {
  display: none;
}

.size-stepper {
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-input);
}

.size-stepper-btn {
  border: 0;
  background: transparent;
  color: var(--text-main);
  padding: 8px 12px;
  cursor: pointer;
  font: inherit;
}

.size-stepper-btn:hover:not(:disabled) {
  background: var(--bg-input-hover);
}

.size-stepper-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

#manhwaWidthValue {
  min-width: 48px;
  text-align: center;
  color: var(--text-main);
}
```

- [ ] **Step 7: Verify the automated behavior**

Run:

```powershell
node tests/image-size-controls.test.js
node tests/explorer-images.test.js
node tests/folder-click-toggle.test.js
```

Expected: all three commands print `PASS` and exit 0.

- [ ] **Step 8: Verify the browser behavior**

Open `index.html` and confirm:

1. Initial Manhwa mode shows `− 30% +`, with Manga dropdown hidden.
2. Clicking minus four times shows 10% and disables minus.
3. Clicking plus eighteen times shows 100% and disables plus.
4. Manga mode hides the stepper and shows the unchanged thumbnail dropdown.
5. Returning to Manhwa restores the previous percentage and hides the Manga dropdown.

- [ ] **Step 9: Commit the implementation**

```powershell
git add -- image-size-controls.js tests/image-size-controls.test.js index.html script.js style.css docs/superpowers/plans/2026-07-25-mode-specific-image-size-controls.md
git commit -m "feat: add mode-specific image size controls"
```
