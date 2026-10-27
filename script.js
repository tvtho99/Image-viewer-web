"use strict";
/* script.js
- Folder: showDirectoryPicker (File System Access API) with webkitdirectory and
  drag-and-drop fallbacks. Root images are shown; subfolders appear in the
  Explorer tree and are read on demand.
- Two modes: Manga (thumbnail grid + zoomable viewer) and Manhwa (continuous
  vertical strip).
- Loading: every image gets a cheap placeholder up front, so the scrollbar and
  jumps cover the whole folder. IntersectionObservers decide what to decode
  (a queue, at most MAX_ACTIVE_LOADS at once, skipping pages scrolled past)
  and what to release (UNLOAD_DELAY after leaving UNLOAD_MARGIN).
- Manhwa placeholders keep each page's real aspect ratio once known, so pages
  never jump and width changes are one CSS variable.
- Object URLs: one per File, created on first use, revoked together when
  another folder opens (they only reference the file; decoded pixels are
  freed by unloading the element).
*/

const LOAD_MARGIN = "1200px 0px"; // decode this far ahead of the viewport
const UNLOAD_MARGIN = "5000px 0px"; // keep decoded pages this close
const UNLOAD_DELAY = 8000; // ms offscreen before releasing a page
const MAX_ACTIVE_LOADS = 4; // concurrent decodes

const chooseInput = document.getElementById("chooseFolder");
const openFolderBtn = document.getElementById("openFolderBtn");
const clearBtn = document.getElementById("clearBtn");

const mangaTab = document.getElementById("mangaTab");
const manhwaTab = document.getElementById("manhwaTab");

const thumbSizeSelect = document.getElementById("thumbSize");
const manhwaWidthControl = document.getElementById("manhwaWidthControl");
const mangaSizeControl = document.getElementById("mangaSizeControl");
const decreaseManhwaWidth = document.getElementById("decreaseManhwaWidth");
const increaseManhwaWidth = document.getElementById("increaseManhwaWidth");
const manhwaWidthValue = document.getElementById("manhwaWidthValue");

const gallery = document.getElementById("gallery");
const emptyState = document.getElementById("emptyState");
const mainBody = document.getElementById("mainBody");

// Theme Toggle Logic (saved theme is applied by the inline script in <head>)
const themeToggleBtn = document.getElementById("themeToggleBtn");
const htmlElement = document.documentElement;

themeToggleBtn.addEventListener("click", () => {
  const newTheme =
    htmlElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  if (newTheme === "light") {
    htmlElement.setAttribute("data-theme", "light");
  } else {
    htmlElement.removeAttribute("data-theme");
  }
  localStorage.setItem("theme", newTheme);
});

// Phones get a full-width strip; desktops keep the 30% reading column.
let maxWidthVW = window.matchMedia("(max-width: 768px)").matches ? 100 : 30;

let mode = "manhwa"; // 'manga' or 'manhwa'
let fileObjects = []; // Files shown in the gallery (current folder)

const objectURLs = new Map(); // File -> blob URL
const imageDimensionsCache = new Map(); // File -> natural {width, height} (Manhwa)

function getObjectURL(file) {
  let url = objectURLs.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    objectURLs.set(file, url);
  }
  return url;
}

function revokeObjectURLs() {
  objectURLs.forEach((url) => URL.revokeObjectURL(url));
  objectURLs.clear();
}

// modal elements (for Manga)
const modal = document.getElementById("modal");
const imageWrapper = document.getElementById("imageWrapper");
const modalImage = document.getElementById("modalImage");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const resetZoomBtn = document.getElementById("resetZoomBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const zoomIndicator = document.getElementById("zoomIndicator");

// === Continuous zoom system (Manga modal) ===
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 20;
const ZOOM_WHEEL_FACTOR = 0.0015; // wheel deltaY * this → log scale step (smooth)
const ZOOM_BUTTON_FACTOR = 1.15; // per button click
const ZOOM_KEYBOARD_STEP = 1.2;
const ZOOM_DBLCLICK_FACTOR = 1.9; // step zoom factor for first dblclick

// allowed extensions
const extRegex = /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i;

function isImageName(name) {
  return extRegex.test(name);
}

function naturalCompare(a, b) {
  const aStr = String(a);
  const bStr = String(b);

  // Extract all numbers appearing in the name (e.g. "Chap514" → [514], "Chap 1" → [1])
  // This makes "sort by number in name" actually work even when spacing/punctuation differs
  const aNums = (aStr.match(/\d+/g) || []).map((n) => parseInt(n, 10));
  const bNums = (bStr.match(/\d+/g) || []).map((n) => parseInt(n, 10));

  const len = Math.min(aNums.length, bNums.length);
  for (let i = 0; i < len; i++) {
    if (aNums[i] !== bNums[i]) {
      return aNums[i] - bNums[i];
    }
  }

  // One name has more numbers than the other
  if (aNums.length !== bNums.length) {
    return aNums.length - bNums.length;
  }

  // Numbers are identical (or none) → fall back to normal string sort
  return aStr.localeCompare(bStr);
}

function compareFolderNames(x, y) {
  const na = x && x.name ? x.name : typeof x === "string" ? x : "";
  const nb = y && y.name ? y.name : typeof y === "string" ? y : "";
  if (explorerSortMode === "natural") {
    return naturalCompare(na, nb);
  }
  return na.localeCompare(nb);
}

/* ---------- Gallery: placeholders, load queue, deferred unload ---------- */

let loadObserver = null;
let unloadObserver = null;
const loadQueue = new Set(); // items waiting for a decode slot, nearest first
let activeLoads = 0;
let loadGeneration = 0; // bumped on reset so stale loads don't free new slots

function initObservers() {
  loadObserver = new IntersectionObserver(
    (entries) => {
      const bounds = entries[0].rootBounds;
      const middle = bounds ? bounds.top + bounds.height / 2 : 0;
      const distance = (entry) =>
        Math.abs(
          entry.boundingClientRect.top + entry.boundingClientRect.height / 2 - middle,
        );
      const entering = [];
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (!entry.target._load) entering.push(entry);
        } else {
          // Scrolled past before its turn: skip the decode entirely.
          loadQueue.delete(entry.target);
        }
      }
      entering
        .sort((a, b) => distance(a) - distance(b))
        .forEach((entry) => loadQueue.add(entry.target));
      pumpLoadQueue();
    },
    { root: mainBody, rootMargin: LOAD_MARGIN },
  );

  unloadObserver = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        clearTimeout(target._unloadTimer);
        // Deferred: unloading the moment a page leaves would stutter quick back-scrolls.
        if (!isIntersecting && (target._load || target.firstElementChild)) {
          target._unloadTimer = setTimeout(() => unloadItem(target), UNLOAD_DELAY);
        }
      }
    },
    { root: mainBody, rootMargin: UNLOAD_MARGIN },
  );
}

function pumpLoadQueue() {
  for (const item of loadQueue) {
    if (activeLoads >= MAX_ACTIVE_LOADS) return;
    loadQueue.delete(item);
    if (item._load) continue;
    activeLoads++;
    const generation = loadGeneration;
    loadItem(item).finally(() => {
      if (generation !== loadGeneration) return;
      activeLoads--;
      pumpLoadQueue();
    });
  }
}

async function loadItem(item) {
  if (item._load || !item.isConnected) return;
  const token = (item._load = {});
  if (!item.firstElementChild) item.classList.add("is-loading");

  try {
    const isManhwa = item.classList.contains("manhwa-item");
    const content = isManhwa
      ? await decodeManhwaImage(item._file)
      : await renderThumbnail(item);

    if (item._load !== token || !item.isConnected) {
      releaseContent(content); // unloaded or folder changed while decoding
      return;
    }
    if (isManhwa) applyNaturalSize(item, content);
    releaseContent(item.firstElementChild);
    item.replaceChildren(content);
    item.classList.add("is-loaded");
  } catch (err) {
    if (item._load !== token) return;
    console.warn("Cannot display image", item._file.name, err);
    item.dataset.error = `Cannot display ${item._file.name}`;
    item.classList.add("is-error");
  } finally {
    if (item._load === token) item.classList.remove("is-loading");
  }
}

async function decodeManhwaImage(file) {
  const img = document.createElement("img");
  img.alt = file.name;
  img.decoding = "async";
  img.src = getObjectURL(file);
  await img.decode(); // decoded before it is shown: no blank flash while scrolling
  return img;
}

function applyNaturalSize(item, img) {
  const { naturalWidth: width, naturalHeight: height } = img;
  if (!width || !height) return;
  imageDimensionsCache.set(item._file, { width, height });
  const ratio = `${width} / ${height}`;
  item.style.aspectRatio = ratio;
  // The first known page shape is the best estimate for pages not decoded yet.
  if (!gallery.style.getPropertyValue("--manhwa-ratio")) {
    gallery.style.setProperty("--manhwa-ratio", ratio);
  }
}

// Manga thumbnails: decode straight to the cell size (off the main thread).
async function renderThumbnail(item) {
  const file = item._file;
  try {
    const bitmap = await createImageBitmap(file, {
      resizeWidth: Math.round((item.clientWidth || 300) * (window.devicePixelRatio || 1)),
      resizeQuality: "high",
    });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
    return canvas;
  } catch (err) {
    // createImageBitmap cannot decode some formats (e.g. SVG); let <img> try.
    const img = document.createElement("img");
    img.alt = "";
    img.src = getObjectURL(file);
    await img.decode();
    return img;
  }
}

// Free pixels now instead of waiting for garbage collection.
function releaseContent(content) {
  if (!content) return;
  if (content.tagName === "CANVAS") {
    content.getContext("bitmaprenderer").transferFromImageBitmap(null);
  } else {
    content.removeAttribute("src");
  }
}

function unloadItem(item) {
  clearTimeout(item._unloadTimer);
  item._load = null;
  releaseContent(item.firstElementChild);
  item.replaceChildren();
  item.classList.remove("is-loaded", "is-loading", "is-error");
}

function createItem(file, index) {
  const isManga = mode === "manga";
  const item = document.createElement(isManga ? "button" : "div");
  item.className = isManga ? "gallery-item" : "manhwa-item";
  item._file = file;
  item._index = index;
  if (isManga) {
    item.type = "button";
    item.setAttribute("aria-label", `Open ${file.name}`);
  } else {
    const size = imageDimensionsCache.get(file);
    if (size) item.style.aspectRatio = `${size.width} / ${size.height}`;
  }
  return item;
}

/* ---------- Reset and load ---------- */
function resetGallery() {
  if (loadObserver) loadObserver.disconnect();
  if (unloadObserver) unloadObserver.disconnect();
  loadQueue.clear();
  loadGeneration++;
  activeLoads = 0;
  for (const item of gallery.children) unloadItem(item);

  gallery.replaceChildren();
  gallery.style.removeProperty("--manhwa-ratio");
  gallery.className =
    mode === "manhwa" ? "manhwa-list" : `gallery layout-${thumbSizeSelect.value}`;
  mainBody.scrollTop = 0;
  emptyState.hidden = fileObjects.length > 0;
  if (fileObjects.length === 0) return;

  initObservers();
  const fragment = document.createDocumentFragment();
  fileObjects.forEach((file, index) => fragment.appendChild(createItem(file, index)));
  gallery.appendChild(fragment);
  for (const item of gallery.children) {
    loadObserver.observe(item);
    unloadObserver.observe(item);
  }
}

function showFolderImages(dirHandle, files) {
  currentImageFolderHandle = dirHandle;
  revokeObjectURLs();
  imageDimensionsCache.clear();
  fileObjects = files;
  resetGallery();
}

// Manga: one delegated listener instead of one per thumbnail
gallery.addEventListener("click", (e) => {
  const item = e.target.closest(".gallery-item");
  if (item) openModal(item._index);
});

/* ---------- Tab switching ---------- */
function setMode(nextMode) {
  if (mode === nextMode) return;
  mode = nextMode;
  mangaTab.classList.toggle("active", mode === "manga");
  manhwaTab.classList.toggle("active", mode === "manhwa");
  mangaTab.setAttribute("aria-pressed", String(mode === "manga"));
  manhwaTab.setAttribute("aria-pressed", String(mode === "manhwa"));
  setSizeControlMode(mode, manhwaWidthControl, mangaSizeControl);
  resetGallery();
}

mangaTab.addEventListener("click", () => setMode("manga"));
manhwaTab.addEventListener("click", () => setMode("manhwa"));
setSizeControlMode(mode, manhwaWidthControl, mangaSizeControl);

/* ---------- Thumb size control ---------- */
thumbSizeSelect.addEventListener("change", () => {
  if (mode !== "manga") return;
  gallery.className = `gallery layout-${thumbSizeSelect.value}`;
  // Thumbnails are decoded at cell size: redo the ones that would now be upscaled.
  const pixelRatio = window.devicePixelRatio || 1;
  for (const item of gallery.children) {
    const thumb = item.firstElementChild;
    if (thumb && thumb.tagName === "CANVAS" && thumb.width < item.clientWidth * pixelRatio) {
      item._load = null; // keep the old thumbnail visible until the sharper one is ready
      loadObserver.unobserve(item);
      loadObserver.observe(item);
    }
  }
});

/* ---------- Manhwa width control ---------- */
function syncManhwaWidthControl() {
  gallery.style.setProperty("--manhwa-width", `${maxWidthVW}vw`);
  manhwaWidthValue.textContent = `${maxWidthVW}%`;
  decreaseManhwaWidth.disabled = maxWidthVW === 10;
  increaseManhwaWidth.disabled = maxWidthVW === 100;
}

function changeManhwaWidth(direction) {
  maxWidthVW = stepManhwaWidth(maxWidthVW, direction);
  syncManhwaWidthControl();
}

decreaseManhwaWidth.addEventListener("click", () => changeManhwaWidth(-1));
increaseManhwaWidth.addEventListener("click", () => changeManhwaWidth(1));
syncManhwaWidthControl();

/* ---------- Sidebar ---------- */
const sidebar = document.getElementById("sidebar");
const sidebarContent = sidebar.querySelector(".sidebar-content");
const sidebarTrigger = document.getElementById("sidebarTrigger");
let subfolders = []; // [{name, handle}]
let currentFolderHandle = null; // Explorer root
let currentImageFolderHandle = null; // folder whose images are shown
let rootFileObjects = [];
let explorerSortMode =
  localStorage.getItem("explorerSortMode") === "natural" ? "natural" : "string";

function setSidebarOpen(open) {
  sidebar.classList.toggle("open", open);
  sidebarTrigger.setAttribute("aria-expanded", String(open));
}

sidebarTrigger.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent document click from closing it immediately
  setSidebarOpen(!sidebar.classList.contains("open"));
});

// Close sidebar when clicking outside (if not pinned)
document.addEventListener("click", (e) => {
  if (
    sidebar.classList.contains("open") &&
    !sidebar.contains(e.target) &&
    !sidebarTrigger.contains(e.target) &&
    !contextMenu.contains(e.target)
  ) {
    setSidebarOpen(false);
  }
});

// Context Menu
const contextMenu = document.getElementById("contextMenu");
const ctxOpen = document.getElementById("ctxOpen");
const ctxSetRoot = document.getElementById("ctxSetRoot");
let activeCtxNode = null;

function hideContextMenu() {
  contextMenu.hidden = true;
}

document.addEventListener("click", hideContextMenu);
// Capture: scrolls of the gallery or sidebar don't bubble to document.
document.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("resize", hideContextMenu);
window.addEventListener("blur", hideContextMenu);

function showContextMenu(e, node, button) {
  e.preventDefault();
  e.stopPropagation();
  activeCtxNode = { ...node, button };
  contextMenu.hidden = false;

  // Keyboard-opened menus (Shift+F10) carry no pointer position: anchor to the button.
  let x = e.clientX;
  let y = e.clientY;
  if (!x && !y) {
    const anchor = button.getBoundingClientRect();
    x = anchor.left + 16;
    y = anchor.bottom;
  }
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  ctxOpen.focus();
}

ctxOpen.addEventListener("click", () => {
  if (activeCtxNode) activeCtxNode.button.click();
});

ctxSetRoot.addEventListener("click", () => {
  if (activeCtxNode) openRootFolder(activeCtxNode.handle).catch(reportFolderError);
});

// Sidebar Resize Logic
const resizer = document.getElementById("sidebarResizer");
const savedWidth = localStorage.getItem("sidebarWidth");
if (savedWidth) {
  htmlElement.style.setProperty("--sidebar-width", `${savedWidth}px`);
}

resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("is-resizing");
  document.body.classList.add("is-resizing");
});

resizer.addEventListener("pointermove", (e) => {
  if (!resizer.hasPointerCapture(e.pointerId)) return;
  const left = sidebar.getBoundingClientRect().left;
  const newWidth = Math.min(600, Math.max(250, e.clientX - left));
  htmlElement.style.setProperty("--sidebar-width", `${newWidth}px`);
});

resizer.addEventListener("lostpointercapture", () => {
  resizer.classList.remove("is-resizing");
  document.body.classList.remove("is-resizing");
  const currentWidth = getComputedStyle(htmlElement).getPropertyValue("--sidebar-width");
  localStorage.setItem("sidebarWidth", parseInt(currentWidth, 10));
});

// Sidebar Pin
const sidebarPin = document.getElementById("sidebarPin");

function setSidebarPinned(pinned) {
  sidebar.classList.toggle("pinned", pinned);
  sidebarPin.classList.toggle("pinned", pinned);
  sidebarPin.title = pinned ? "Unpin sidebar" : "Pin sidebar";
  sidebarPin.setAttribute("aria-pressed", String(pinned));
  document.body.classList.toggle("sidebar-pinned", pinned);
}

setSidebarPinned(localStorage.getItem("sidebarPinned") === "true");

sidebarPin.addEventListener("click", () => {
  const pinned = !sidebar.classList.contains("pinned");
  setSidebarPinned(pinned);
  localStorage.setItem("sidebarPinned", pinned);
});

// Reload Folder Action: re-read the tree and keep showing the same folder
const sidebarReload = document.getElementById("sidebarReload");
sidebarReload.addEventListener("click", async () => {
  if (!currentFolderHandle) return;

  sidebarReload
    .querySelector("svg")
    .animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: 500,
      easing: "ease",
    });

  const viewHandle = currentImageFolderHandle;
  const viewingRoot = viewHandle === currentFolderHandle;
  try {
    const contents = await readFolderContents(currentFolderHandle);
    rootFileObjects = contents.files;
    subfolders = contents.folders;
    const viewFiles = viewingRoot
      ? contents.files
      : (await readFolderContents(viewHandle)).files;
    showFolderImages(viewHandle, viewFiles);
    renderSidebarTree();
    if (!viewingRoot) await markActiveFolder(viewHandle);
  } catch (err) {
    reportFolderError(err);
  }
});

// Sidebar Sort Toggle (only affects folder tree in explorer — per user requirement)
const sidebarSort = document.getElementById("sidebarSort");

function updateSortButtonUI() {
  if (explorerSortMode === "natural") {
    sidebarSort.textContent = "1–9";
    sidebarSort.title = "Natural sort (by number in name) — click to use A-Z string sort";
  } else {
    sidebarSort.textContent = "A–Z";
    sidebarSort.title = "A-Z string sort — click to use natural sort by number";
  }
}

sidebarSort.addEventListener("click", () => {
  explorerSortMode = explorerSortMode === "string" ? "natural" : "string";
  localStorage.setItem("explorerSortMode", explorerSortMode);
  updateSortButtonUI();

  // Re-order rendered folders in place so expanded folders and the selection survive.
  subfolders.sort(compareFolderNames);
  for (const container of sidebar.querySelectorAll(".folder-tree-children")) {
    const nodes = Array.from(container.children).filter((child) => child._node);
    nodes.sort((a, b) => compareFolderNames(a._node, b._node));
    container.prepend(...nodes);
  }
});

updateSortButtonUI();

/* ---------- Folder reading ---------- */
async function folderHandlesMatch(first, second) {
  if (!first || !second) return false;
  if (first === second) return true;

  if (typeof first.isSameEntry === "function") {
    try {
      return await first.isSameEntry(second);
    } catch (err) {
      console.warn("Cannot compare folder handles", err);
    }
  }

  return Boolean(
    first.dirEntry &&
      second.dirEntry &&
      first.dirEntry.fullPath === second.dirEntry.fullPath,
  );
}

// Image files at this level (reading order) and its subfolders
async function readFolderContents(dirHandle) {
  const fileHandles = [];
  const folders = [];

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && isImageName(name)) {
      fileHandles.push(handle);
    } else if (handle.kind === "directory") {
      folders.push({ name, handle });
    }
  }

  // getFile() in parallel: one await per file made big folders slow to open.
  const files = await Promise.all(
    fileHandles.map((handle) =>
      handle.getFile().catch((err) => {
        console.warn("Cannot read file", handle.name, err);
        return null;
      }),
    ),
  );

  return {
    files: files.filter(Boolean).sort(compareFileNames),
    folders: folders.sort(compareFolderNames),
  };
}

async function openRootFolder(dirHandle) {
  const contents = await readFolderContents(dirHandle);
  currentFolderHandle = dirHandle;
  rootFileObjects = contents.files;
  subfolders = contents.folders;
  showFolderImages(dirHandle, contents.files);
  renderSidebarTree();
  setSidebarOpen(true);
}

function reportFolderError(err) {
  if (err && err.name === "AbortError") return; // picker cancelled
  console.error("Cannot open folder", err);
}

/* ---------- Explorer tree ---------- */
function createFolderToggle(name) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "folder-toggle";
  toggle.setAttribute("aria-label", `Expand ${name}`);
  toggle.setAttribute("aria-expanded", "false");
  return toggle;
}

function createFolderButton(name, handle) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "folder-btn";
  btn._folderHandle = handle;
  const span = document.createElement("span");
  span.className = "folder-name";
  span.textContent = name;
  btn.appendChild(span);
  return btn;
}

function setActiveFolderButton(button) {
  sidebar.querySelectorAll(".folder-btn.active").forEach((item) => {
    item.classList.remove("active");
  });
  button.classList.add("active");
}

async function markActiveFolder(handle) {
  for (const btn of sidebar.querySelectorAll(".folder-btn")) {
    if (await folderHandlesMatch(btn._folderHandle, handle)) {
      setActiveFolderButton(btn);
      return;
    }
  }
}

function scrollToExplorerImage(fileName) {
  const index = fileObjects.findIndex((file) => file.name === fileName);
  if (index < 0) return;
  gallery.children[index].scrollIntoView({
    block: mode === "manhwa" ? "start" : "center",
  });
}

function renderSidebarTree() {
  sidebarContent.replaceChildren();
  if (!currentFolderHandle) return;

  const rootName = currentFolderHandle.name || "Root Folder";
  const rootWrapper = document.createElement("div");
  rootWrapper.className = "folder-node";

  const rootToggle = createFolderToggle(rootName);
  const rootBtn = createFolderButton(rootName, currentFolderHandle);
  if (currentImageFolderHandle === currentFolderHandle) rootBtn.classList.add("active");

  const rootChildren = document.createElement("div");
  rootChildren.className = "folder-tree-children";
  setFolderExpanded(rootToggle, rootChildren, true);

  async function selectRoot() {
    if (currentImageFolderHandle !== currentFolderHandle) {
      showFolderImages(currentFolderHandle, rootFileObjects);
    }
    setActiveFolderButton(rootBtn);
  }

  rootToggle.onclick = () => {
    const expanded = rootToggle.getAttribute("aria-expanded") !== "true";
    setFolderExpanded(rootToggle, rootChildren, expanded);
  };
  rootBtn.onclick = () => selectAndToggleFolder(rootToggle, rootChildren, selectRoot);
  rootBtn.oncontextmenu = (e) =>
    showContextMenu(e, { name: rootName, handle: currentFolderHandle }, rootBtn);

  renderTreeNodes(subfolders, rootChildren);
  renderImageNodes(rootFileObjects, rootChildren, async (file) => {
    await selectRoot();
    scrollToExplorerImage(file.name);
  });

  rootWrapper.appendChild(rootToggle);
  rootWrapper.appendChild(rootBtn);
  rootWrapper.appendChild(rootChildren);
  sidebarContent.appendChild(rootWrapper);
}

function renderTreeNodes(nodes, container) {
  nodes.forEach((node) => {
    const wrapper = document.createElement("div");
    wrapper.className = "folder-node";
    wrapper._node = node;

    const toggle = createFolderToggle(node.name);
    const btn = createFolderButton(node.name, node.handle);

    const childContainer = document.createElement("div");
    childContainer.className = "folder-tree-children";
    setFolderExpanded(toggle, childContainer, false);

    let loaded = false;
    let contents = null;
    let loadPromise = null;
    let selectPromise = null;

    async function loadChildren() {
      if (loaded) return contents;
      if (!loadPromise) {
        loadPromise = readFolderContents(node.handle)
          .then((result) => {
            contents = result;
            renderTreeNodes(result.folders, childContainer);
            renderImageNodes(result.files, childContainer, async (file) => {
              await selectFolder();
              setFolderExpanded(toggle, childContainer, true);
              scrollToExplorerImage(file.name);
            });
            loaded = true;
            return result;
          })
          .finally(() => {
            if (!loaded) loadPromise = null;
          });
      }
      return loadPromise;
    }

    async function selectFolder() {
      if (selectPromise) return selectPromise;

      selectPromise = (async () => {
        const folderContents = await loadChildren();
        if (!(await folderHandlesMatch(currentImageFolderHandle, node.handle))) {
          showFolderImages(node.handle, folderContents.files);
        }
        setActiveFolderButton(btn);
      })();

      try {
        await selectPromise;
      } finally {
        selectPromise = null;
      }
    }

    toggle.onclick = async () => {
      await loadChildren();
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      setFolderExpanded(toggle, childContainer, expanded);
    };
    btn.onclick = () =>
      selectAndToggleFolder(toggle, childContainer, selectFolder).catch(reportFolderError);
    btn.oncontextmenu = (e) => showContextMenu(e, node, btn);

    wrapper.appendChild(toggle);
    wrapper.appendChild(btn);
    wrapper.appendChild(childContainer);
    container.appendChild(wrapper);
  });
}

/* ---------- Opening folders ---------- */
let isPicking = false;

async function openDirectoryPicker() {
  if (isPicking) return;
  if (!window.showDirectoryPicker) {
    chooseInput.click();
    return;
  }
  isPicking = true;
  try {
    await openRootFolder(await window.showDirectoryPicker());
  } catch (err) {
    reportFolderError(err);
  } finally {
    isPicking = false;
  }
}

openFolderBtn.addEventListener("click", openDirectoryPicker);
// The whole drop zone (and its Browse button) opens the picker.
document.getElementById("dropZone").addEventListener("click", openDirectoryPicker);

/* ---------- Virtual File System for Fallbacks ---------- */
class VirtualDirHandle {
  constructor(name) {
    this.name = name;
    this.kind = "directory";
    this.children = new Map();
  }
  async *entries() {
    for (const [name, handle] of this.children.entries()) {
      yield [name, handle];
    }
  }
}

class VirtualFileHandle {
  constructor(file) {
    this.name = file.name;
    this.kind = "file";
    this.file = file;
  }
  async getFile() {
    return this.file;
  }
}

function buildVirtualFileSystem(files) {
  let rootName = "Root Folder";
  if (files.length && files[0].webkitRelativePath) {
    rootName = files[0].webkitRelativePath.split("/")[0];
  }
  const rootHandle = new VirtualDirHandle(rootName);

  files.forEach((f) => {
    if (!isImageName(f.name)) return;
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split("/");

    // Only file name, put at root
    if (parts.length === 1) {
      rootHandle.children.set(f.name, new VirtualFileHandle(f));
      return;
    }

    let current = rootHandle;
    for (let i = 1; i < parts.length - 1; i++) {
      const dirName = parts[i];
      if (!current.children.has(dirName)) {
        current.children.set(dirName, new VirtualDirHandle(dirName));
      }
      current = current.children.get(dirName);
    }
    current.children.set(f.name, new VirtualFileHandle(f));
  });

  return rootHandle;
}

// fallback input handling (recursive via virtual handles)
chooseInput.addEventListener("change", () => {
  const files = Array.from(chooseInput.files || []);
  chooseInput.value = ""; // choosing the same folder again must fire "change" again
  if (files.length === 0) return;
  openRootFolder(buildVirtualFileSystem(files)).catch(reportFolderError);
});

/* ---------- Drag and Drop (anywhere in the window) ---------- */
let dragDepth = 0;

function isFileDrag(e) {
  return Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types).includes("Files");
}

document.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("drag-over");
});

document.addEventListener("dragover", (e) => {
  if (isFileDrag(e)) e.preventDefault(); // allow dropping files
});

document.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("drag-over");
});

document.addEventListener("drop", (e) => {
  e.preventDefault(); // never let the browser navigate to a dropped file
  dragDepth = 0;
  document.body.classList.remove("drag-over");
  handleDrop(e);
});

async function handleDrop(e) {
  const dt = e.dataTransfer;
  if (!dt) return;
  const item = Array.from(dt.items || []).find((entry) => entry.kind === "file");

  // DataTransfer is only readable during the event: take everything before awaiting.
  const handlePromise =
    item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  const files = Array.from(dt.files || []);

  let handle = null;
  try {
    handle = await handlePromise;
  } catch (err) {
    console.warn("getAsFileSystemHandle failed, falling back:", err);
  }

  try {
    if (handle && handle.kind === "directory") {
      await openRootFolder(handle);
    } else if (entry && entry.isDirectory) {
      await openRootFolder(new FileSystemEntryDirHandle(entry));
    } else if (files.some((file) => isImageName(file.name))) {
      await openRootFolder(buildVirtualFileSystem(files));
    }
  } catch (err) {
    reportFolderError(err);
  }
}

// Read all entries from a directory entry reader (handles batched reads)
async function readAllEntriesFromReader(reader) {
  const entries = [];
  for (;;) {
    const results = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (results.length === 0) return entries;
    entries.push(...results);
  }
}

class FileSystemEntryDirHandle {
  constructor(dirEntry) {
    this.name = dirEntry.name;
    this.kind = "directory";
    this.dirEntry = dirEntry;
  }
  async *entries() {
    const reader = this.dirEntry.createReader();
    const entries = await readAllEntriesFromReader(reader);
    for (const entry of entries) {
      if (entry.isFile) {
        yield [entry.name, new FileSystemEntryFileHandle(entry)];
      } else if (entry.isDirectory) {
        yield [entry.name, new FileSystemEntryDirHandle(entry)];
      }
    }
  }
}

class FileSystemEntryFileHandle {
  constructor(fileEntry) {
    this.name = fileEntry.name;
    this.kind = "file";
    this.fileEntry = fileEntry;
  }
  async getFile() {
    return new Promise((resolve, reject) => {
      this.fileEntry.file(resolve, reject);
    });
  }
}

/* ---------- Clear ---------- */
clearBtn.addEventListener("click", () => {
  if (modal.open) modal.close();
  currentFolderHandle = null;
  rootFileObjects = [];
  subfolders = [];
  showFolderImages(null, []);
  renderSidebarTree();
});

/* ---------- Modal logic (Manga only) ---------- */
let currentModalIndex = -1;
let view = { scale: 1, x: 0, y: 0 }; // see modal-zoom.js
let baseWidth = 0; // fitted image size before zoom
let baseHeight = 0;

function openModal(index) {
  if (mode !== "manga" || !fileObjects[index]) return;
  currentModalIndex = index;
  showModalImage();
  if (!modal.open) modal.showModal();
}

function showModalImage() {
  const file = fileObjects[currentModalIndex];
  const url = getObjectURL(file);
  modalImage.alt = file.name;
  modalImage.src = url;
  resetView();
  modalImage.decode().then(
    () => {
      if (modalImage.src === url) fitImageToView();
    },
    () => {}, // broken image: alt text is shown
  );
}

function navigateModal(delta) {
  if (fileObjects.length === 0) return;
  currentModalIndex =
    (currentModalIndex + delta + fileObjects.length) % fileObjects.length;
  showModalImage();
}

function closeModal() {
  modal.close();
}

// Esc (native <dialog>) and the close button both end here
modal.addEventListener("close", () => {
  pointers.clear();
  resetView();
});

function fitImageToView() {
  const aspect = (modalImage.naturalHeight || 1) / (modalImage.naturalWidth || 1);
  baseWidth = window.innerWidth * 0.85;
  baseHeight = baseWidth * aspect;
  const maxHeight = window.innerHeight * 0.85;
  if (baseHeight > maxHeight) {
    baseHeight = maxHeight;
    baseWidth = baseHeight / aspect;
  }
  modalImage.style.width = `${baseWidth}px`;
  modalImage.style.height = `${baseHeight}px`;
  resetView();
}

function resetView() {
  view = { scale: 1, x: 0, y: 0 };
  renderView(true);
  hideZoomIndicator();
}

function renderView(animate = false) {
  view = clampPan(view, baseWidth, baseHeight, imageWrapper.clientWidth, imageWrapper.clientHeight);
  modalImage.style.transition = animate ? "transform 0.15s ease-out" : "none";
  modalImage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  imageWrapper.classList.toggle("is-zoomed", view.scale > 1.01);
}

// Zoom keeping the point under (clientX, clientY) fixed; null = viewer centre.
function zoomTo(scale, clientX = null, clientY = null, animate = false) {
  const nextScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
  if (nextScale === view.scale) return;
  const rect = imageWrapper.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  view = zoomAt(
    view,
    nextScale,
    (clientX === null ? centerX : clientX) - centerX,
    (clientY === null ? centerY : clientY) - centerY,
  );
  renderView(animate);
  showZoomIndicator(Math.round(view.scale * 100));
}

closeModalBtn.addEventListener("click", closeModal);

// Double-click: toggle between fit and a closer look at the click point
modalImage.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (view.scale > 1.05) {
    fitImageToView();
  } else {
    zoomTo(view.scale * ZOOM_DBLCLICK_FACTOR, e.clientX, e.clientY, true);
  }
});

// Wheel = zoom at the cursor, anywhere in the viewer
imageWrapper.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomTo(view.scale * Math.exp(-e.deltaY * ZOOM_WHEEL_FACTOR), e.clientX, e.clientY);
  },
  { passive: false },
);

zoomInBtn.addEventListener("click", () => zoomTo(view.scale * ZOOM_BUTTON_FACTOR, null, null, true));
zoomOutBtn.addEventListener("click", () => zoomTo(view.scale / ZOOM_BUTTON_FACTOR, null, null, true));
resetZoomBtn.addEventListener("click", fitImageToView);

/* Pan (one pointer, when zoomed) and pinch (two pointers): mouse, pen and touch alike */
const pointers = new Map(); // pointerId -> {x, y}
let pinchDistance = 0;
let dragStart = null;
let dragMoved = false;

imageWrapper.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchDistance = 0;
  dragStart = { x: e.clientX, y: e.clientY };
  dragMoved = false;
});

imageWrapper.addEventListener("pointermove", (e) => {
  const last = pointers.get(e.pointerId);
  if (!last) return;
  const point = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, point);
  if (!dragMoved && Math.hypot(point.x - dragStart.x, point.y - dragStart.y) > 4) {
    dragMoved = true;
    imageWrapper.setPointerCapture(e.pointerId);
  }

  if (pointers.size === 2) {
    const [a, b] = pointers.values();
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDistance) {
      zoomTo(view.scale * (distance / pinchDistance), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    pinchDistance = distance;
  } else if (dragMoved && view.scale > 1.01) {
    imageWrapper.classList.add("is-panning");
    view = { ...view, x: view.x + point.x - last.x, y: view.y + point.y - last.y };
    renderView();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  pinchDistance = 0;
  if (pointers.size === 0) imageWrapper.classList.remove("is-panning");
}
imageWrapper.addEventListener("pointerup", endPointer);
imageWrapper.addEventListener("pointercancel", endPointer);

// Click on the empty area around the image closes the viewer (not after a drag).
imageWrapper.addEventListener("click", (e) => {
  if (e.target === imageWrapper && !dragMoved) closeModal();
});

// prev/next buttons
prevBtn.addEventListener("click", () => navigateModal(-1));
nextBtn.addEventListener("click", () => navigateModal(1));

/* Zoom indicator helpers */
let zoomIndicatorTimeout = null;

function showZoomIndicator(percent) {
  zoomIndicator.textContent = `${percent}%`;
  zoomIndicator.classList.add("visible");
  clearTimeout(zoomIndicatorTimeout);
  zoomIndicatorTimeout = setTimeout(hideZoomIndicator, 8000);
}

function hideZoomIndicator() {
  zoomIndicator.classList.remove("visible");
}

zoomIndicator.addEventListener("click", fitImageToView);

/* ---------- Keyboard ---------- */
let arrowScrollVelocity = 0;
let arrowScrollRAF = null;
const ARROW_SCROLL_SPEED = 30; // Pixels per frame for continuous scroll

function arrowContinuousScroll() {
  if (arrowScrollVelocity !== 0) {
    mainBody.scrollTop += arrowScrollVelocity;
    arrowScrollRAF = requestAnimationFrame(arrowContinuousScroll);
  } else {
    arrowScrollRAF = null;
  }
}

function handleModalKey(e) {
  if (e.key === "ArrowRight") navigateModal(1);
  else if (e.key === "ArrowLeft") navigateModal(-1);
  else if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    zoomTo(view.scale * ZOOM_KEYBOARD_STEP, null, null, true);
  } else if (e.key === "-") {
    e.preventDefault();
    zoomTo(view.scale / ZOOM_KEYBOARD_STEP, null, null, true);
  } else if (e.key === "0" || e.key === "r" || e.key === "R") {
    e.preventDefault();
    fitImageToView();
  } else if (e.key === "1") {
    e.preventDefault();
    zoomTo((modalImage.naturalWidth || baseWidth) / baseWidth, null, null, true);
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && view.scale > 1.05) {
    // Pan vertically with arrows when zoomed
    e.preventDefault();
    view = { ...view, y: view.y + (e.key === "ArrowUp" ? 80 : -80) };
    renderView(true);
  }
}

window.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return; // keep browser shortcuts (Alt+← = back)
  // Skip if focused on input elements
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;

  if (modal.open) {
    handleModalKey(e); // Esc is handled natively by <dialog>
    return;
  }

  if (e.key === "Escape") {
    if (!contextMenu.hidden) {
      hideContextMenu();
      if (activeCtxNode) activeCtxNode.button.focus();
    } else if (!sidebar.classList.contains("pinned")) {
      setSidebarOpen(false);
    }
  } else if (e.key === "ArrowLeft") {
    // Folder navigation (when modal is not open)
    e.preventDefault();
    navigateToSiblingFolder(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    navigateToSiblingFolder(1);
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const direction = e.key === "ArrowUp" ? -1 : 1;
    if (e.repeat) {
      arrowScrollVelocity = direction * ARROW_SCROLL_SPEED;
      if (!arrowScrollRAF) arrowContinuousScroll();
    } else {
      mainBody.scrollBy({ top: direction * 400, behavior: "smooth" });
    }
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowUp" && arrowScrollVelocity < 0) {
    arrowScrollVelocity = 0;
  } else if (e.key === "ArrowDown" && arrowScrollVelocity > 0) {
    arrowScrollVelocity = 0;
  }
});

// Check if a folder handle contains at least one image file
async function folderHasImages(handle) {
  try {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === "file" && isImageName(name)) return true;
    }
  } catch (err) {
    console.warn("Error checking folder for images:", err);
  }
  return false;
}

// Navigate to previous/next sibling folder containing images
// If no sibling with images at current level, go up to parent's siblings
async function navigateToSiblingFolder(direction) {
  const activeBtn = sidebar.querySelector(".folder-btn.active");
  if (!activeBtn) return;

  let folderNode = activeBtn.closest(".folder-node");

  while (folderNode) {
    const container = folderNode.parentElement;
    // Stop if we've reached the sidebar-content (root has no siblings)
    if (!container || container.classList.contains("sidebar-content")) break;

    // Get all sibling folder-node elements at this level
    const siblings = Array.from(container.querySelectorAll(":scope > .folder-node"));
    const index = siblings.indexOf(folderNode);

    // Search siblings in the given direction
    let nextIndex = index + direction;
    while (nextIndex >= 0 && nextIndex < siblings.length) {
      const candidateBtn = siblings[nextIndex].querySelector(":scope > .folder-btn");
      if (candidateBtn && candidateBtn._folderHandle) {
        if (await folderHasImages(candidateBtn._folderHandle)) {
          candidateBtn.click();
          return;
        }
      }
      nextIndex += direction;
    }

    // No valid sibling found at this level — go up to parent
    folderNode = container.closest(".folder-node");
  }
}

/* ---------- Resize: refit the viewer if not zoomed, otherwise keep the pan in bounds ---------- */
let resizeTimeout;
window.addEventListener("resize", () => {
  if (!modal.open) return;
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (view.scale > 1.001) renderView();
    else fitImageToView();
  }, 100);
});

/* ---------- Scroll performance ---------- */
let scrollTimeout;

// Add is-scrolling to drop hover effects and backdrop blur while scrolling.
function markScrolling() {
  document.body.classList.add("is-scrolling");
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    document.body.classList.remove("is-scrolling");
  }, 150);
}

mainBody.addEventListener("scroll", markScrolling, { passive: true });
// Pre-activate scroll optimizations on wheel, which fires BEFORE the scroll:
// avoids the first-frame stutter after idle (blur/hover off before the first paint).
mainBody.addEventListener("wheel", markScrolling, { passive: true });

// Scroll buttons
const scrollTopBtn = document.getElementById("scrollTopBtn");
const scrollBottomBtn = document.getElementById("scrollBottomBtn");
const scrollButtonsContainer = document.querySelector(".scroll-buttons");

function updateScrollButtonsVisibility() {
  const hasScroll = mainBody.scrollHeight > mainBody.clientHeight + 1;
  scrollButtonsContainer.classList.toggle("visible", hasScroll);
}

// Fires after layout when content or viewport size changes (no forced reflow).
const scrollSizeObserver = new ResizeObserver(updateScrollButtonsVisibility);
scrollSizeObserver.observe(mainBody);
scrollSizeObserver.observe(gallery);

function scrollMainTo(top) {
  // Smooth-scrolling across a long chapter would start decoding every page on the way.
  const far = Math.abs(top - mainBody.scrollTop) > 3 * mainBody.clientHeight;
  mainBody.scrollTo({ top, behavior: far ? "auto" : "smooth" });
}

scrollTopBtn.addEventListener("click", () => scrollMainTo(0));
scrollBottomBtn.addEventListener("click", () => scrollMainTo(mainBody.scrollHeight));

// Set current year in footer
document.getElementById("copyrightYear").textContent = new Date().getFullYear();
