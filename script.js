"use strict";
/* script.js
- Supports selecting a folder (showDirectoryPicker or fallback webkitdirectory)
- Non-recursive: only root folder images
- Two tabs: Manga (grid + modal) and Manhwa (vertical, 70vw, no modal)
- Gallery thumbnails uniform size via .gallery-item & object-fit: cover
- Infinite scroll with IntersectionObserver on #sentinel + requestAnimationFrame
- Batch size fixed = 20
- Performance Optimization:
    - createImageBitmap + canvas for Manga thumbnails
    - Custom visibility-based loader + decoded blob cache for Manhwa (prioritizes back-scroll smoothness)
    - Deferred Object URL creation + 8s delayed unload with generous cache for ~50 image folders
- Temporary debug metrics: window.__imgDebug (enable with .enabled = true, use .getStats())
*/

// Configure lazysizes for fast scrolling (must be before lazysizes loads)
window.lazySizesConfig = window.lazySizesConfig || {};
window.lazySizesConfig.expand = 300; // Preload 300px ahead (reduced from default 370)
window.lazySizesConfig.expFactor = 1.5; // Expansion factor during idle
window.lazySizesConfig.hFac = 0.8; // Height factor for horizontal scroll
window.lazySizesConfig.loadMode = 2; // Load images in view + nearby
window.lazySizesConfig.throttleDelay = 125; // Throttle scroll events

// === Temporary Performance Debug Instrumentation (Manhwa optimization focus) ===
// Enable with:  window.__imgDebug.enabled = true
// View live stats: window.__imgDebug
// Reset with:   window.__imgDebug.reset()
const __imgDebug = {
  enabled: false,
  liveBlobs: 0,
  totalCreated: 0,
  totalRevoked: 0,
  manhwaDecodes: 0,
  unloads: 0,
  reloads: 0,
  cacheHits: 0,
  cacheMisses: 0,
  activeURLs: new Set(),

  _updateLive() {
    this.liveBlobs = this.activeURLs.size;
  },

  log(msg, data) {
    if (this.enabled) {
      console.log(`[ImgPerf] ${msg}`, data || '');
    }
  },

  recordCreate(url, isManhwa = false) {
    this.totalCreated++;
    this.activeURLs.add(url);
    this._updateLive();
    if (isManhwa) this.manhwaDecodes++;
    this.log('Blob created', { live: this.liveBlobs, total: this.totalCreated, isManhwa });
  },

  recordRevoke(url) {
    this.totalRevoked++;
    this.activeURLs.delete(url);
    this._updateLive();
    this.log('Blob revoked', { live: this.liveBlobs, totalRevoked: this.totalRevoked });
  },

  recordUnload() {
    this.unloads++;
    this.log('Image unloaded (DOM cleared)', { unloads: this.unloads, liveBlobs: this.liveBlobs });
  },

  recordReload(isCacheHit = false) {
    this.reloads++;
    if (isCacheHit) this.cacheHits++; else this.cacheMisses++;
    this.log('Image reloaded', { reloads: this.reloads, hits: this.cacheHits, misses: this.cacheMisses });
  },

  reset() {
    this.liveBlobs = 0;
    this.totalCreated = 0;
    this.totalRevoked = 0;
    this.manhwaDecodes = 0;
    this.unloads = 0;
    this.reloads = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.activeURLs.clear();
    this.log('Debug stats reset');
  },

  getStats() {
    return {
      liveBlobs: this.liveBlobs,
      renderedImages: renderedImages.size,
      manhwaCacheSize: manhwaImageCache.size,
      totalCreated: this.totalCreated,
      totalRevoked: this.totalRevoked,
      unloads: this.unloads,
      reloads: this.reloads,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      manhwaDecodes: this.manhwaDecodes
    };
  }
};

window.__imgDebug = __imgDebug;
// === End Debug Instrumentation ===

// === Manhwa Image Cache (Phase 2) - prioritizes back-scroll smoothness for ~50 images ===
// Keeps recently decoded blob URLs alive so scrolling back is near-instant.
const manhwaImageCache = new Map(); // filename -> {url, lastUsed}
const MAX_MANHWA_CACHE_SIZE = 28; // Generous for target size + smoothness priority

function getCachedManhwaURL(file) {
  const entry = manhwaImageCache.get(file.name);
  if (entry) {
    entry.lastUsed = Date.now();
    __imgDebug.cacheHits++;
    __imgDebug.log('Cache HIT for Manhwa image', file.name);
    return entry.url;
  }
  __imgDebug.cacheMisses++;
  return null;
}

// Check if a blob URL is still actively used by a visible <img> in the DOM
function isBlobURLInUseByDOM(url) {
  const images = gallery.querySelectorAll('img');
  for (const img of images) {
    if (img.src === url) return true;
  }
  return false;
}

function cacheManhwaURL(file, url) {
  // Evict oldest if over limit
  if (manhwaImageCache.size >= MAX_MANHWA_CACHE_SIZE) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, val] of manhwaImageCache) {
      if (val.lastUsed < oldestTime) {
        oldestTime = val.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const oldEntry = manhwaImageCache.get(oldestKey);
      if (oldEntry) {
        // Only revoke if no DOM <img> still references this blob URL
        if (!isBlobURLInUseByDOM(oldEntry.url)) {
          __imgDebug.recordRevoke(oldEntry.url);
          URL.revokeObjectURL(oldEntry.url);
          objectURLs.delete(oldEntry.url);
        } else {
          __imgDebug.log('Skipped revoke — blob URL still in use by DOM', oldEntry.url);
          // Still tracked in objectURLs for cleanup on clear/reset
        }
      }
      manhwaImageCache.delete(oldestKey);
    }
  }

  manhwaImageCache.set(file.name, { url, lastUsed: Date.now() });
  __imgDebug.log('Cached Manhwa image', file.name);
}

function clearManhwaCache() {
  for (const [key, entry] of manhwaImageCache) {
    __imgDebug.recordRevoke(entry.url);
    URL.revokeObjectURL(entry.url);
    objectURLs.delete(entry.url);
  }
  manhwaImageCache.clear();
  __imgDebug.log('Manhwa cache cleared');
}

// === End Manhwa Cache ===

const chooseInput = document.getElementById("chooseFolder");
const chooseLabel = document.getElementById("chooseLabel");
const clearBtn = document.getElementById("clearBtn");

const mangaTab = document.getElementById("mangaTab");
const manhwaTab = document.getElementById("manhwaTab");

const thumbSizeSelect = document.getElementById("thumbSize");

const gallery = document.getElementById("gallery");

const maxWidthSelect = document.getElementById("modalMaxWidthSelect");
const mainBody = document.getElementById("mainBody");

// Theme Toggle Logic
const themeToggleBtn = document.getElementById("themeToggleBtn");
const htmlElement = document.documentElement;

const savedTheme = localStorage.getItem("theme") || "dark";
if (savedTheme === "light") {
  htmlElement.setAttribute("data-theme", "light");
}
updateThemeIcon(savedTheme);

function updateThemeIcon(theme) {
  if (themeToggleBtn) {
    const icon = themeToggleBtn.querySelector(".icon");
    // If light mode is active, icon should be Moon (to switch back to dark)
    // If dark mode is active, icon should be Sun (to switch to light)
    icon.textContent = theme === "light" ? "🌙" : "☀️";
  }
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const currentTheme =
      htmlElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const newTheme = currentTheme === "light" ? "dark" : "light";

    if (newTheme === "light") {
      htmlElement.setAttribute("data-theme", "light");
    } else {
      htmlElement.removeAttribute("data-theme");
    }

    localStorage.setItem("theme", newTheme);
    updateThemeIcon(newTheme);
  });
}

let maxWidthVW = 30; // default for manhwa

const BATCH_SIZE = 20;
const INITIAL_EAGER_COUNT = 10;

// Virtual scrolling and performance optimization
const imageDimensionsCache = new Map(); // Cache image dimensions {name: {width, height}}
const renderedImages = new Set(); // Track which images are currently in DOM
const objectURLs = new Set(); // Track Object URLs for memory cleanup

// modal elements (for Manga)
const modal = document.getElementById("modal");
const modalContent = document.getElementById("modalContent");
const modalImage = document.getElementById("modalImage");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const resetZoomBtn = document.getElementById("resetZoomBtn");
const closeModalBtn = document.getElementById("closeModalBtn");

let mode = "manhwa"; // 'manga' or 'manhwa'
let fileObjects = []; // Array of File objects directly
let currentIndex = 0; // index for batch loading
let isBatchLoading = false; // Prevent concurrent loading
let currentRAF = null; // Track current RAF to cancel on reset

// Unload Observer for Virtual Scrolling / DOM Cleanup
let unloadObserver = null;
let unloadDebounceTimer = null;
function initUnloadObserver() {
  if (unloadObserver) {
    unloadObserver.disconnect();
  }
  // Pending unloads: debounce to avoid unloading items the user might scroll back to
  const pendingUnloads = new Map();
  const UNLOAD_DELAY = 8000; // 8s delay before actually unloading

  unloadObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const wrapper = entry.target;
      if (!entry.isIntersecting) {
        // Schedule deferred unload — don't unload immediately
        if (!wrapper.classList.contains('is-unloaded') && wrapper._file) {
          if (!pendingUnloads.has(wrapper)) {
            const timerId = setTimeout(() => {
              pendingUnloads.delete(wrapper);
              // Double-check it's still offscreen before unloading
              if (wrapper.classList.contains('is-unloaded') || !wrapper._file) return;
              const rect = wrapper.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                wrapper.style.width = `${rect.width}px`;
                wrapper.style.height = `${rect.height}px`;
              }
              const img = wrapper.querySelector('img');
              if (img && img.src && img.src.startsWith('blob:')) {
                // For Manhwa: move to cache instead of revoking (smoothness priority)
                if (mode === "manhwa" && wrapper._file) {
                  if (!manhwaImageCache.has(wrapper._file.name)) {
                    cacheManhwaURL(wrapper._file, img.src);
                  }
                  // Keep the blob alive in cache; do not revoke here
                  objectURLs.delete(img.src); // still remove from bulk tracking
                } else {
                  __imgDebug.recordRevoke(img.src);
                  URL.revokeObjectURL(img.src);
                  objectURLs.delete(img.src);
                }
              }
              wrapper.innerHTML = '';
              wrapper.classList.add('is-unloaded');
              renderedImages.delete(wrapper);
              __imgDebug.recordUnload();
            }, UNLOAD_DELAY);
            pendingUnloads.set(wrapper, timerId);
          }
        }
      } else {
        // Cancel any pending unload if scrolled back into view
        if (pendingUnloads.has(wrapper)) {
          clearTimeout(pendingUnloads.get(wrapper));
          pendingUnloads.delete(wrapper);
        }
        // Scrolled back into view: Reload if was unloaded
        if (wrapper.classList.contains('is-unloaded') && wrapper._file) {
          wrapper.classList.remove('is-unloaded');
          const inner = createInnerElement(wrapper._file);
          wrapper.appendChild(inner);
          if (mode === "manhwa" && manhwaLoadObserver) {
            manhwaLoadObserver.observe(wrapper);
          }
          // Immediately try to load (will hit cache for fast back-scroll)
          if (mode === "manhwa") {
            ensureManhwaImageLoaded(wrapper);
          }
          __imgDebug.recordReload(!!(wrapper._file && manhwaImageCache.has(wrapper._file.name)));
        }
      }
    });
  }, {
    root: mainBody,
    rootMargin: "5000px" // Larger buffer: only unload items very far offscreen
  });
}

// Dedicated loader for Manhwa images (replaces lazysizes for this path)
// Uses IntersectionObserver with generous margin for pre-loading → better back-scroll smoothness
let manhwaLoadObserver = null;

function initManhwaLoadObserver() {
  if (manhwaLoadObserver) {
    manhwaLoadObserver.disconnect();
  }

  manhwaLoadObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const wrapper = entry.target;
        ensureManhwaImageLoaded(wrapper);
      }
    });
  }, {
    root: mainBody,
    rootMargin: "1200px 0px", // Preload well ahead for smooth scrolling
    threshold: 0.01
  });
}

function ensureManhwaImageLoaded(wrapper) {
  if (!wrapper || mode !== "manhwa" || !wrapper._file) return;

  let img = wrapper.querySelector("img");

  // If unloaded or no img, recreate the skeleton placeholder
  if (!img || wrapper.classList.contains("is-unloaded")) {
    if (wrapper.classList.contains("is-unloaded")) {
      wrapper.classList.remove("is-unloaded");
    }
    img = createInnerElement(wrapper._file);
    wrapper.innerHTML = "";
    wrapper.appendChild(img);
  }

  // If we still have the file reference (we clear _file after loading the real image), load it now
  if (img && img._file) {
    let url = getCachedManhwaURL(img._file);

    if (!url) {
      // Cache miss → create new
      url = URL.createObjectURL(img._file);
      objectURLs.add(url);
      __imgDebug.recordCreate(url, true);
      cacheManhwaURL(img._file, url);
    } else {
      // Re-use cached URL (no new decode)
      // Still track in objectURLs for bulk cleanup on clear
      if (!objectURLs.has(url)) objectURLs.add(url);
    }

    img.src = url;
    img._file = null; // Release reference

    // Handle visual state immediately on cache hit (load event may not fire for cached blobs)
    if (img.complete) {
      img.classList.remove("skeleton-loading");
      img.classList.add("lazyloaded");
      if (img.parentElement) img.parentElement.style.height = '';
    }
    // Otherwise the "load" listener will catch it
  }
}

// modal state
let currentModalIndex = -1;
let currentFullResUrl = null; // Track current blob URL to revoke
let zoomed = false;
let scale = 1;
let translateX = 0;
let translateY = 0;
let originX = 50;
let originY = 50;

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

// === New continuous zoom system (Manga modal) ===
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
  const aNums = (aStr.match(/\d+/g) || []).map(n => parseInt(n, 10));
  const bNums = (bStr.match(/\d+/g) || []).map(n => parseInt(n, 10));

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
  const na = x && x.name ? x.name : (typeof x === "string" ? x : "");
  const nb = y && y.name ? y.name : (typeof y === "string" ? y : "");
  if (explorerSortMode === "natural") {
    return naturalCompare(na, nb);
  }
  return na.localeCompare(nb);
}

const sidebar = document.getElementById("sidebar");
let subfolders = []; // [{name, handle}]
let currentFolderHandle = null;
let currentSubfolder = null;
let explorerSortMode = localStorage.getItem("explorerSortMode") === "natural" ? "natural" : "string";

// Sidebar Trigger Logic
const sidebarTrigger = document.querySelector(".sidebar-trigger"); // Select via class since it has no ID
if (sidebarTrigger) {
  sidebarTrigger.addEventListener("click", (e) => {
    e.stopPropagation(); // Prevent document click from closing it immediately
    sidebar.classList.toggle("open");
  });
}

// Close sidebar when clicking outside (if not pinned)
document.addEventListener("click", (e) => {
  if (
    sidebar.classList.contains("open") &&
    !sidebar.contains(e.target) &&
    !sidebarTrigger.contains(e.target)
  ) {
    sidebar.classList.remove("open");
  }
});

// Context Menu elements (declared in outer scope so they're accessible everywhere)
const contextMenu = document.getElementById("contextMenu");
const ctxOpen = document.getElementById("ctxOpen");
const ctxSetRoot = document.getElementById("ctxSetRoot");
let activeCtxNode = null;

// Global hide context menu
document.addEventListener("click", () => {
  if (contextMenu) contextMenu.style.display = "none";
});
document.addEventListener("scroll", () => {
  if (contextMenu) contextMenu.style.display = "none";
});

// Sidebar Resize Logic
const resizer = document.getElementById("sidebarResizer");
if (resizer) {
  let isResizing = false;

  // Restore saved width
  const savedWidth = localStorage.getItem("sidebarWidth");
  if (savedWidth) {
    document.documentElement.style.setProperty(
      "--sidebar-width",
      savedWidth + "px",
    );
  }

  resizer.addEventListener("mousedown", (e) => {
    isResizing = true;
    sidebar.classList.add("is-resizing");
    resizer.classList.add("is-resizing");
    document.body.classList.add("is-resizing");
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    e.preventDefault();
  });

  function handleMouseMove(e) {
    if (!isResizing) return;
    const offset = sidebar.classList.contains("pinned") ? 0 : 10;
    let newWidth = e.clientX - offset;

    // Bounds
    if (newWidth < 250) newWidth = 250;
    if (newWidth > 600) newWidth = 600;

    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${newWidth}px`,
    );
  }

  function stopResizing() {
    isResizing = false;
    sidebar.classList.remove("is-resizing");
    resizer.classList.remove("is-resizing");
    document.body.classList.remove("is-resizing");
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", stopResizing);

    // Save final width
    const currentWidth = getComputedStyle(
      document.documentElement,
    ).getPropertyValue("--sidebar-width");
    localStorage.setItem("sidebarWidth", parseInt(currentWidth));
  }
}

// Reload Folder Action
const sidebarReload = document.getElementById("sidebarReload");
if (sidebarReload) {
  sidebarReload.addEventListener("click", async () => {
    if (!currentFolderHandle) return;

    const svg = sidebarReload.querySelector("svg");
    if (svg) {
      svg.style.transition = "transform 0.5s ease";
      svg.style.transform = "rotate(360deg)";
      setTimeout(() => {
        svg.style.transition = "none";
        svg.style.transform = "rotate(0deg)";
      }, 500);
    }

    const savedSubfolder = currentSubfolder;
    await handleDirectoryHandle(currentFolderHandle);

    if (savedSubfolder) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const btns = Array.from(sidebar.querySelectorAll(".folder-btn"));
      const targetBtn = btns.find(b => b.textContent.trim() === savedSubfolder);
      if (targetBtn) {
        targetBtn.click();
      }
    }
  });
}

// Sidebar Sort Toggle (only affects folder tree in explorer — per user requirement)
function updateSortButtonUI(btn) {
  if (!btn) return;
  if (explorerSortMode === "natural") {
    btn.textContent = "🔢";
    btn.title = "Natural sort (by number in name) — click to use A-Z string sort";
  } else {
    btn.textContent = "🔤";
    btn.title = "A-Z string sort — click to use natural sort by number";
  }
}

const sidebarSort = document.getElementById("sidebarSort");
if (sidebarSort) {
  sidebarSort.addEventListener("click", async () => {
    explorerSortMode = explorerSortMode === "string" ? "natural" : "string";
    localStorage.setItem("explorerSortMode", explorerSortMode);
    updateSortButtonUI(sidebarSort);

    if (currentFolderHandle) {
      const savedSubfolder = currentSubfolder;
      await renderSidebarTree();

      if (savedSubfolder) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const btns = Array.from(sidebar.querySelectorAll(".folder-btn"));
        const targetBtn = btns.find((b) => b.textContent.trim() === savedSubfolder);
        if (targetBtn) {
          targetBtn.click();
        }
      }
    }
  });

  updateSortButtonUI(sidebarSort);
}

// Context Menu Actions
if (ctxOpen) {
  ctxOpen.onclick = () => {
    if (activeCtxNode) {
      const btn = Array.from(sidebar.querySelectorAll(".folder-btn")).find(
        (b) => b.textContent.trim() === activeCtxNode.name,
      );
      if (btn) btn.click();
    }
  };
}

if (ctxSetRoot) {
  ctxSetRoot.onclick = async () => {
    if (activeCtxNode && activeCtxNode.handle) {
      currentFolderHandle = activeCtxNode.handle;
      currentSubfolder = null;
      resetAndLoad();
      await renderSidebarTree();
    }
  };
}

// Hàm duyệt folder, lấy file ảnh ở root và danh sách folder con
async function handleDirectoryHandle(dirHandle) {
  // Cleanup old URLs
  if (currentFullResUrl) {
    __imgDebug.recordRevoke(currentFullResUrl);
    URL.revokeObjectURL(currentFullResUrl);
    currentFullResUrl = null;
  }

  fileObjects = [];
  subfolders = [];
  currentFolderHandle = dirHandle;
  currentSubfolder = null;

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && isImageName(name)) {
      try {
        const file = await handle.getFile();
        // Store FILE object directly, NOT URL
        fileObjects.push(file);
      } catch (err) {
        console.warn("Cannot read file", name, err);
      }
    } else if (handle.kind === "directory") {
      subfolders.push({ name, handle });
    }
  }
  // Sort by name (files stay string sort; folders use explorer mode)
  fileObjects.sort((a, b) => a.name.localeCompare(b.name));
  subfolders.sort((a, b) => compareFolderNames(a, b));

  await renderSidebarTree();
  resetAndLoad();
  sidebar.classList.add("open");
}

// Khi chọn folder con, duyệt sâu vào folder đó
async function handleSubfolderHandle(dirHandle) {
  if (currentFullResUrl) {
    __imgDebug.recordRevoke(currentFullResUrl);
    URL.revokeObjectURL(currentFullResUrl);
    currentFullResUrl = null;
  }

  fileObjects = [];
  // KHÔNG cập nhật lại sidebar tree, chỉ cập nhật ảnh
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && isImageName(name)) {
      try {
        const file = await handle.getFile();
        fileObjects.push(file);
      } catch (err) {
        console.warn("Cannot read file", name, err);
      }
    }
  }
  fileObjects.sort((a, b) => a.name.localeCompare(b.name));
  // KHÔNG gọi await renderSidebarTree();
  resetAndLoad();
}

// Helper: Get immediate subfolders only (Non-recursive)
async function getSubfolders(dirHandle) {
  const folders = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      folders.push({ name, handle, children: [] }); // children empty initially
    }
  }
  folders.sort((a, b) => compareFolderNames(a, b));
  return folders;
}

function showContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();
  activeCtxNode = node;

  contextMenu.style.display = "block";
  contextMenu.style.left = e.clientX + "px";
  contextMenu.style.top = e.clientY + "px";

  // Adjust if overflow
  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenu.style.left = e.clientX - rect.width + "px";
  }
  if (rect.bottom > window.innerHeight) {
    contextMenu.style.top = e.clientY - rect.height + "px";
  }
}

// Render tree folder trên sidebar
async function renderSidebarTree() {
  const sidebarContent = sidebar.querySelector(".sidebar-content");
  sidebarContent.innerHTML = "";

  if (!currentFolderHandle) {
    return;
  }

  // Create Root Wrapper
  const rootWrapper = document.createElement("div");
  rootWrapper.className = "folder-node";

  // Nút cho folder gốc
  const rootBtn = document.createElement("button");
  const rootSpan = document.createElement("span");
  rootSpan.textContent = currentFolderHandle.name || "Root Folder";
  rootSpan.className = "folder-name";
  rootBtn.appendChild(rootSpan);
  rootBtn._folderHandle = currentFolderHandle;
  rootBtn.className =
    "folder-btn" + (currentSubfolder === null ? " active" : "");

  rootBtn.onclick = async () => {
    const allFolderButtons = sidebar.querySelectorAll(".folder-btn");
    allFolderButtons.forEach((b) => b.classList.remove("active"));
    currentSubfolder = null;
    rootBtn.classList.add("active");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await handleDirectoryHandle(currentFolderHandle);
  };

  rootBtn.oncontextmenu = (e) =>
    showContextMenu(e, { name: currentFolderHandle.name || "Root Folder", handle: currentFolderHandle });

  rootWrapper.appendChild(rootBtn);

  // Lấy immediate subfolders và render vào container thụt lề
  const folders = await getSubfolders(currentFolderHandle);
  if (folders.length > 0) {
    const treeContainer = document.createElement("div");
    treeContainer.className = "folder-tree-children";
    treeContainer.style.display = "block"; // Always show root children
    renderTreeNodes(folders, treeContainer);
    rootWrapper.appendChild(treeContainer);
  }

  sidebarContent.appendChild(rootWrapper);
}

// Render node với lazy loading
function renderTreeNodes(nodes, container) {
  nodes.forEach((node) => {
    const wrapper = document.createElement("div");
    wrapper.className = "folder-node";

    const btn = document.createElement("button");
    const span = document.createElement("span");
    span.textContent = node.name;
    span.className = "folder-name";
    btn.appendChild(span);
    btn._folderHandle = node.handle;
    btn.className = "folder-btn";

    // Container cho children (ẩn mặc định)
    const childContainer = document.createElement("div");
    childContainer.className = "folder-tree-children";
    childContainer.style.display = "none"; // Ẩn ban đầu

    let loaded = false;

    btn.onclick = async (e) => {
      e.stopPropagation();

      // 1. Load images của folder này
      currentSubfolder = node.name;
      const allFolderButtons = sidebar.querySelectorAll(".folder-btn");
      allFolderButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await handleSubfolderHandle(node.handle);

      // 2. Lazy load subfolders nếu chưa load
      if (!loaded) {
        const children = await getSubfolders(node.handle);
        if (children.length > 0) {
          renderTreeNodes(children, childContainer);
          childContainer.style.display = "block";
        }
        loaded = true;
      } else {
        // Toggle visibility nếu đã load
        childContainer.style.display =
          childContainer.style.display === "none" ? "block" : "none";
      }
    };

    btn.oncontextmenu = (e) => showContextMenu(e, node);

    wrapper.appendChild(btn);
    wrapper.appendChild(childContainer);
    container.appendChild(wrapper);
  });
}

let isPicking = false; // Thêm biến cờ

async function openDirectoryPicker() {
  if (isPicking) return; // Nếu đang chọn thì không làm gì
  isPicking = true;
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker();
      await handleDirectoryHandle(dir);
    } catch (err) {
      // Nếu bị hủy, không làm gì
    }
    isPicking = false;
  } else {
    chooseInput.click();
    isPicking = false;
  }
}

chooseLabel.addEventListener("click", (e) => {
  e.preventDefault(); // Ngăn hành vi mặc định
  openDirectoryPicker();
});

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
chooseInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  
  const rootHandle = buildVirtualFileSystem(files);
  await handleDirectoryHandle(rootHandle);
});

// Secondary folder input for drop zone button
// Initial Browse Button (in empty state)
const initialBrowseBtn = document.getElementById("browseFolderBtn");
if (initialBrowseBtn) {
  initialBrowseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    openDirectoryPicker();
  });
}

/* ---------- Drag and Drop functionality ---------- */
let dropZone = document.getElementById("dropZone");
const emptyState = document.getElementById("emptyState");

// Prevent default drag behaviors on the entire document
["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
  document.body.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

// Highlight drop zone when item is dragged over it
["dragenter", "dragover"].forEach((eventName) => {
  if (dropZone) {
    dropZone.addEventListener(eventName, highlight, false);
  }
});

["dragleave", "drop"].forEach((eventName) => {
  if (dropZone) {
    dropZone.addEventListener(eventName, unhighlight, false);
  }
});

function highlight(e) {
  const target = e.currentTarget || document.getElementById("dropZone");
  if (target) {
    target.classList.add("drag-over");
  }
}

function unhighlight(e) {
  const target = e.currentTarget || document.getElementById("dropZone");
  if (target) {
    target.classList.remove("drag-over");
  }
}

// Handle dropped files
if (dropZone) {
  dropZone.addEventListener("drop", handleDrop, false);
}

async function handleDrop(e) {
  const dt = e.dataTransfer;
  const items = dt.items;

  if (!items || items.length === 0) return;

  // 1. Try modern File System Access API (FileSystemHandle)
  if (items[0].getAsFileSystemHandle) {
    try {
      const handle = await items[0].getAsFileSystemHandle();
      if (handle && handle.kind === "directory") {
        await handleDirectoryHandle(handle);
        return;
      }
    } catch (err) {
      console.warn("getAsFileSystemHandle failed, falling back:", err);
    }
  }

  // 2. Try Webkit API (FileSystemEntry)
  if (items[0].webkitGetAsEntry) {
    const entry = items[0].webkitGetAsEntry();
    if (entry && entry.isDirectory) {
      // Use FileSystem API to read directory
      await readDirectoryEntry(entry);
      return;
    }
  }

  // 3. Fallback: handle as files
  const files = Array.from(dt.files || []);

  if (files.length > 0) {
    handleDroppedFiles(files);
  }
}

// Read all entries from a directory entry reader (handles batched reads)
async function readAllEntriesFromReader(reader) {
  const entries = [];
  let continueReading = true;
  while (continueReading) {
    await new Promise((resolve, reject) => {
      reader.readEntries(
        (results) => {
          if (results.length === 0) {
            continueReading = false;
          } else {
            entries.push(...results);
          }
          resolve();
        },
        (err) => {
          console.error("Error reading entries", err);
          reject(err);
        },
      );
    });
  }
  return entries;
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

// Read directory using FileSystem API (webkit) — lazily builds tree then delegates
async function readDirectoryEntry(dirEntry) {
  console.log("Reading directory entry:", dirEntry.name);
  try {
    const virtualRoot = new FileSystemEntryDirHandle(dirEntry);
    await handleDirectoryHandle(virtualRoot);
  } catch (err) {
    console.warn("Error processing directory:", err);
  }
}

// Handle dropped files (fallback)
function handleDroppedFiles(files) {
  fileObjects = files.filter((f) => isImageName(f.name));
  fileObjects.sort((a, b) => a.name.localeCompare(b.name));
  resetAndLoad();
  sidebar.classList.add("open");
}

/* ---------- Tab switching ---------- */
mangaTab.addEventListener("click", () => {
  if (mode === "manga") return;
  mode = "manga";
  mangaTab.classList.add("active");
  manhwaTab.classList.remove("active");
  mangaTab.setAttribute("aria-pressed", "true");
  manhwaTab.setAttribute("aria-pressed", "false");

  // reset gallery and load from start
  resetAndLoad();
});
manhwaTab.addEventListener("click", () => {
  if (mode === "manhwa") return;
  mode = "manhwa";
  manhwaTab.classList.add("active");
  mangaTab.classList.remove("active");
  manhwaTab.setAttribute("aria-pressed", "true");
  mangaTab.setAttribute("aria-pressed", "false");

  maxWidthSelect.value = "30";
  maxWidthVW = 30;

  // Cập nhật lại width cho ảnh manhwa nếu đã có
  updateManhwaImagesWidth();
  // reset gallery and load from start
  resetAndLoad();
});

/* ---------- Thumb size control ---------- */
thumbSizeSelect.addEventListener("change", (e) => {
  const v = e.target.value;
  gallery.classList.remove("layout-small", "layout-medium", "layout-large");
  if (v === "small") gallery.classList.add("layout-small");
  else if (v === "large") gallery.classList.add("layout-large");
  else gallery.classList.add("layout-medium");
  // no need to reload images; items are CSS-driven to adjust size
});

/* ---------- Reset and load ---------- */
function resetAndLoad() {
  // Stop any ongoing continuous loading
  stopContinuousLoading();

  if (currentRAF) {
    cancelAnimationFrame(currentRAF);
    currentRAF = null;
  }
  isBatchLoading = false;

  // Initialize virtual unload observer
  initUnloadObserver();

  // Initialize dedicated Manhwa image loader (custom, no lazysizes)
  if (mode === "manhwa") {
    initManhwaLoadObserver();
  } else if (manhwaLoadObserver) {
    manhwaLoadObserver.disconnect();
    manhwaLoadObserver = null;
  }

  // Revoke all Object URLs to free memory
  objectURLs.forEach((url) => {
    __imgDebug.recordRevoke(url);
    URL.revokeObjectURL(url);
  });
  objectURLs.clear();

  // Also clear Manhwa decoded cache on full reset
  clearManhwaCache();

  renderedImages.clear();

  gallery.innerHTML = "";
  currentIndex = 0;
  if (mode === "manhwa") {
    gallery.classList.remove("gallery");
    gallery.classList.add("manhwa-list");
  } else {
    gallery.classList.remove("manhwa-list");
    gallery.classList.add("gallery");
    if (
      !gallery.classList.contains("layout-small") &&
      !gallery.classList.contains("layout-medium") &&
      !gallery.classList.contains("layout-large")
    ) {
      gallery.classList.add("layout-medium");
    }
  }
  // Load initial batch
  if (fileObjects.length === 0) {
    showEmptyState();
  } else {
    loadInitialImages();
  }
}

function showEmptyState() {
  gallery.innerHTML = `
    <div class="empty-state" id="emptyState">
      <div class="drop-zone" id="dropZone">
        <div class="drop-zone-content">
          <div class="empty-icon">📂</div>
          <h2>Drop Folder Here</h2>
          <p>Drag and drop a folder to view your images</p>
          <div class="drop-zone-divider">
            <span>or</span>
          </div>
          <button class="drop-zone-btn" id="browseFolderBtn">
            <span class="icon">📂</span> Browse Folder
          </button>
        </div>
        <div class="drop-zone-overlay">
          <div class="drop-zone-overlay-content">
            <div class="drop-icon">📥</div>
            <p>Drop folder to open</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // Re-attach event listeners for dynamically created elements
  const newDropZone = document.getElementById("dropZone");
  const browseBtn = document.getElementById("browseFolderBtn");

  if (newDropZone) {
    // Highlight drop zone when item is dragged over it
    ["dragenter", "dragover"].forEach((eventName) => {
      newDropZone.addEventListener(eventName, highlight, false);
    });

    ["dragleave", "drop"].forEach((eventName) => {
      newDropZone.addEventListener(eventName, unhighlight, false);
    });

    // Handle dropped files
    newDropZone.addEventListener("drop", handleDrop, false);
  }

  if (browseBtn) {
    browseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openDirectoryPicker();
    });
  }
}

/* ---------- Loading logic (batches) ---------- */

// Helper: Generate thumbnail using createImageBitmap and render to Canvas
async function renderThumbnailToCanvas(file, canvas) {
  try {
    // Resize to reasonable thumbnail width (e.g. 400px) to save memory
    // This is the KEY optimization: browser decodes to a smaller bitmap
    // Lower resolution = faster decoding + less memory = better performance
    const bitmap = await createImageBitmap(file, { resizeWidth: 400 });

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    // Bitmap is no longer needed after drawing to canvas
    bitmap.close();

    canvas.classList.remove("skeleton-loading");
    canvas.classList.add("loaded");

    // Cache dimensions
    if (!imageDimensionsCache.has(file.name)) {
      imageDimensionsCache.set(file.name, {
        width: canvas.width,
        height: canvas.height,
      });
    }
  } catch (err) {
    console.error("Error generating thumbnail for", file.name, err);
    canvas.classList.remove("skeleton-loading");
    // Show error state visually if needed
  } finally {
    // Note: actual decode happens here via createImageBitmap
  }
}

// Helper: Create inner element (canvas/img) attached via unload observer
function createInnerElement(file) {
  if (mode === "manhwa") {
    const img = document.createElement("img");
    img.alt = file.name;
    img.loading = "lazy";
    img.decoding = "async";
    img.classList.add("skeleton-loading"); // No longer using lazysizes for Manhwa
    // Start with a tiny placeholder (prevents broken image icon)
    img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    img._file = file;

    // Native load handler (replaces lazyloaded event from lazysizes)
    img.addEventListener("load", () => {
      // Ignore the initial 1x1 placeholder load
      if (img.src.startsWith('data:')) return;
      img.classList.remove("skeleton-loading");
      // Remove temporary wrapper height once loaded
      if (img.parentElement) {
        img.parentElement.style.height = '';
      }
      // Mark as loaded for potential CSS hooks
      img.classList.add("lazyloaded");
    });

    // Error recovery: if blob URL was revoked or failed, recreate from file
    img.addEventListener("error", () => {
      // Only retry for blob URLs (not the initial placeholder)
      if (!img.src || !img.src.startsWith('blob:')) return;
      const wrapper = img.parentElement;
      const sourceFile = wrapper && wrapper._file;
      if (!sourceFile) return;

      __imgDebug.log('Image error — retrying', sourceFile.name);

      // Remove broken URL from cache and tracking
      const brokenURL = img.src;
      if (manhwaImageCache.has(sourceFile.name)) {
        manhwaImageCache.delete(sourceFile.name);
      }
      objectURLs.delete(brokenURL);

      // Create a fresh blob URL from the original file
      const freshURL = URL.createObjectURL(sourceFile);
      objectURLs.add(freshURL);
      __imgDebug.recordCreate(freshURL, true);
      cacheManhwaURL(sourceFile, freshURL);
      img.src = freshURL;
    });

    const targetWidth = `${window.innerWidth * (maxWidthVW / 100)}px`;
    img.style.width = targetWidth;
    img.style.height = "auto";
    return img;
  } else {
    const canvas = document.createElement("canvas");
    canvas.classList.add("lazyload", "skeleton-loading");
    canvas.file = file;

    if (imageDimensionsCache.has(file.name)) {
      const dims = imageDimensionsCache.get(file.name);
      canvas.width = dims.width;
      canvas.height = dims.height;
    } else {
      canvas.width = 200;
      canvas.height = 280;
    }
    return canvas;
  }
}

// Helper: Create item element (Canvas for Manga, Img for Manhwa)
function createItemElement(file, onClick = null) {
  const wrapper = document.createElement("div");
  wrapper.className = mode === "manhwa" ? "manhwa-item" : "gallery-item";
  wrapper._file = file; // Store reference for unloader

  if (onClick) {
    wrapper.addEventListener("click", onClick);
  }

  const inner = createInnerElement(file);
  wrapper.appendChild(inner);

  if (unloadObserver) {
    unloadObserver.observe(wrapper);
  }

  // For Manhwa: also observe with dedicated load observer for controlled unveiling
  if (mode === "manhwa" && manhwaLoadObserver) {
    manhwaLoadObserver.observe(wrapper);
    // Ensure items that are already intersecting (or within rootMargin) actually load.
    // IntersectionObserver callback is not guaranteed to fire for elements that
    // are already intersecting at the moment .observe() is called.
    ensureManhwaImageLoaded(wrapper);
  }

  renderedImages.add(wrapper);
  return wrapper;
}

// Lazysizes hook for canvas AND deferred Object URL creation for img
document.addEventListener("lazybeforeunveil", function (e) {
  var target = e.target;
  if (target.tagName === "CANVAS" && target.file) {
    renderThumbnailToCanvas(target.file, target);
  } else if (target.tagName === "IMG" && target._file) {
    // Create Object URL just-in-time when lazysizes is about to unveil
    var url = URL.createObjectURL(target._file);
    objectURLs.add(url);
    __imgDebug.recordCreate(url, true); // Manhwa full-res image
    target.dataset.src = url;
    target._file = null; // Release File reference
  }
});

// Load initial batch of images when screen initializes
// Progressive loading in small chunks to prevent UI freeze
function loadInitialImages() {
  if (fileObjects.length === 0) return;

  const CHUNK_SIZE = 5; // Small chunks for responsive UI
  const initialCount = Math.min(BATCH_SIZE, fileObjects.length);
  let chunkStart = 0;

  function loadChunk() {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, initialCount);

    if (chunkStart >= initialCount) {
      currentIndex = initialCount;
      // Start continuous time-based loading for remaining images
      if (currentIndex < fileObjects.length) {
        startContinuousLoading();
      }
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = chunkStart; i < chunkEnd; i++) {
      const file = fileObjects[i];
      if (!file) continue; // Defensive check
      const item = createItemElement(file, () => openModalWithItem(file));
      fragment.appendChild(item);
    }

    gallery.appendChild(fragment);
    chunkStart = chunkEnd;

    // Schedule next chunk
    if (chunkStart < initialCount) {
      currentRAF = requestAnimationFrame(loadChunk);
    } else {
      currentIndex = initialCount;
      // Start continuous time-based loading for remaining images
      if (currentIndex < fileObjects.length) {
        startContinuousLoading();
      }
    }
  }

  // Start loading
  currentRAF = requestAnimationFrame(loadChunk);
}

// Load more images for infinite scroll
// Use chunked loading for smooth scrolling
function loadMoreImages() {
  if (isBatchLoading || currentIndex >= fileObjects.length) return;
  isBatchLoading = true;

  const batchEnd = Math.min(currentIndex + BATCH_SIZE, fileObjects.length);
  const CHUNK_SIZE = 5;
  let chunkStart = currentIndex;

  function loadChunk() {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, batchEnd);

    if (chunkStart >= batchEnd) {
      currentIndex = batchEnd;
      isBatchLoading = false;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = chunkStart; i < chunkEnd; i++) {
      const file = fileObjects[i];
      if (!file) continue; // Defensive check
      const item = createItemElement(file, () => openModalWithItem(file));
      fragment.appendChild(item);
    }

    gallery.appendChild(fragment);
    chunkStart = chunkEnd;

    if (chunkStart < batchEnd) {
      currentRAF = requestAnimationFrame(loadChunk);
    } else {
      currentIndex = batchEnd;
      isBatchLoading = false;
    }
  }

  currentRAF = requestAnimationFrame(loadChunk);
}

/* Time-based auto-loading + scroll-triggered loading */
let sentinelObserver = null;
let autoLoadTimer = null;
const AUTO_LOAD_INTERVAL = 500; // ms between auto-load batches

function startContinuousLoading() {
  // Stop any existing loaders
  stopContinuousLoading();

  // 1. Time-based auto-loading: load batches at intervals regardless of scroll
  autoLoadTimer = setInterval(() => {
    if (!isBatchLoading && currentIndex < fileObjects.length) {
      loadMoreImages();
    }
    // Stop timer when all images are loaded
    if (currentIndex >= fileObjects.length) {
      clearInterval(autoLoadTimer);
      autoLoadTimer = null;
    }
  }, AUTO_LOAD_INTERVAL);

  // 2. Scroll-triggered loading: also load immediately when user scrolls near bottom
  const sentinel = document.getElementById("sentinel");
  if (!sentinel) return;

  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && !isBatchLoading && currentIndex < fileObjects.length) {
        loadMoreImages();
      }
    },
    {
      root: document.getElementById("mainBody"),
      rootMargin: "600px",
    },
  );
  sentinelObserver.observe(sentinel);
}

function stopContinuousLoading() {
  if (autoLoadTimer) {
    clearInterval(autoLoadTimer);
    autoLoadTimer = null;
  }
  if (sentinelObserver) {
    sentinelObserver.disconnect();
    sentinelObserver = null;
  }
  // Note: Do NOT touch manhwaLoadObserver here.
  // It is managed exclusively in resetAndLoad() / initManhwaLoadObserver().
  // Killing it here broke loading for images added via continuous loading.
}

/* ---------- Clear ---------- */
clearBtn.addEventListener("click", () => {
  // Stop continuous loading
  stopContinuousLoading();

  if (currentFullResUrl) {
    __imgDebug.recordRevoke(currentFullResUrl);
    URL.revokeObjectURL(currentFullResUrl);
    currentFullResUrl = null;
  }
  fileObjects = [];

  // Reset folder state
  currentFolderHandle = null;
  currentSubfolder = null;

  // Clear sidebar
  renderSidebarTree();

  gallery.innerHTML = "";
  currentIndex = 0;

  clearManhwaCache();
  showEmptyState();
});

/* ---------- Modal logic (Manga only) ---------- */

function openModalWithItem(file) {
  if (mode !== "manga") return;

  // Find index
  currentModalIndex = fileObjects.indexOf(file);
  if (currentModalIndex === -1) currentModalIndex = 0;

  loadModalImage(file);

  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
}

function loadModalImage(file) {
  // Revoke previous URL to save memory
  if (currentFullResUrl) {
    __imgDebug.recordRevoke(currentFullResUrl);
    URL.revokeObjectURL(currentFullResUrl);
  }

  resetZoomState();

  // Create new URL for full res
  currentFullResUrl = URL.createObjectURL(file);
  __imgDebug.recordCreate(currentFullResUrl, false); // Modal full-res
  modalImage.src = currentFullResUrl;

  modalImage.onload = () => {
    fitImageToView();
  };
}

function updateManhwaImagesWidth() {
  const items = document.querySelectorAll(".manhwa-item img");
  const vw = window.innerWidth * (maxWidthVW / 100);
  items.forEach((img) => {
    img.style.width = `${vw}px`;
    img.style.height = "auto"; // giữ tỉ lệ
  });
}

maxWidthSelect.addEventListener("change", (e) => {
  maxWidthVW = parseInt(e.target.value) || 30;

  if (mode === "manhwa") {
    updateManhwaImagesWidth();
  }
});

function resetZoomState() {
  zoomed = false;
  scale = 1;
  translateX = 0;
  translateY = 0;
  originX = 50;
  originY = 50;
  modalImage.style.transition = "transform 0.1s linear";
  modalImage.style.transformOrigin = "50% 50%";
  modalImage.style.transform = "translate(0px, 0px) scale(1)";
  modalImage.style.cursor = "zoom-in";
  hideZoomIndicator();
}

function fitImageToView() {
  if (!modalImage) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const imgW = modalImage.naturalWidth || 1;
  const imgH = modalImage.naturalHeight || 1;
  const aspect = imgH / imgW;

  let displayW = vw * 0.85;
  let displayH = displayW * aspect;
  const maxH = vh * 0.85;
  if (displayH > maxH) {
    displayH = maxH;
    displayW = displayH / aspect;
  }

  modalImage.style.width = `${displayW}px`;
  modalImage.style.height = `${displayH}px`;
  modalImage.style.objectFit = "contain";
  resetZoomState();
}

function clampPan() {
  if (!modalImage) return;
  const rect = modalImage.getBoundingClientRect();
  const container = modalImage.parentElement;
  if (!container) return;
  const cRect = container.getBoundingClientRect();
  const imgW = rect.width;
  const imgH = rect.height;
  const contW = cRect.width;
  const contH = cRect.height;
  const maxX = Math.max(0, (imgW - contW) / 2);
  const maxY = Math.max(0, (imgH - contH) / 2);
  translateX = Math.max(-maxX, Math.min(maxX, translateX));
  translateY = Math.max(-maxY, Math.min(maxY, translateY));
  modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

function zoomTo(target, clientX = null, clientY = null, animate = false) {
  const rect = modalImage.getBoundingClientRect();
  const imgW = rect.width;
  const imgH = rect.height;

  // Current visual center in image space (accounting for current transform)
  const prevScale = scale;

  let newScale;
  if (target > 0) {
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target));
  } else {
    // relative zoom (target is negative multiplier like -1.15)
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prevScale * Math.abs(target)));
  }

  if (newScale === prevScale) return;

  // Determine pivot point in client coordinates
  let pivotClientX = clientX;
  let pivotClientY = clientY;
  if (pivotClientX == null || pivotClientY == null) {
    // default to center of image
    pivotClientX = rect.left + imgW / 2;
    pivotClientY = rect.top + imgH / 2;
  }

  // Convert pivot to image-relative percentages (before new scale)
  const offsetX = pivotClientX - rect.left;
  const offsetY = pivotClientY - rect.top;

  // How much the point moves due to scale change
  const scaleRatio = newScale / prevScale;

  // New translate so that the point under the cursor stays under the cursor
  translateX = (translateX + offsetX) * scaleRatio - offsetX;
  translateY = (translateY + offsetY) * scaleRatio - offsetY;

  scale = newScale;
  zoomed = scale > 1.001;

  // Update origin for visual correctness (we still use translate+scale, origin stays center)
  modalImage.style.transformOrigin = "50% 50%";

  if (animate) {
    modalImage.style.transition = "transform 0.15s cubic-bezier(0.25, 0.1, 0.25, 1)";
  } else {
    modalImage.style.transition = "none";
  }

  modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  modalImage.style.cursor = zoomed ? "grab" : "zoom-in";

  showZoomIndicator(Math.round(scale * 100));
  clampPan();

  if (animate) {
    setTimeout(() => {
      if (modalImage) modalImage.style.transition = "none";
    }, 160);
  }
}

// click outside to close
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.classList.contains("modal-backdrop"))
    closeModal();
});
if (closeModalBtn) {
  closeModalBtn.addEventListener("click", closeModal);
}
function closeModal() {
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  resetZoomState();
  // Optionally revoke URL here too if we want to clear memory immediately
  // But keeping it might be faster if user re-opens same image?
  // Let's keep it until next navigation or clear.
}

// Double-click: toggle between fit (reset) and 100% natural size at click point
modalImage.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (scale > 1.05) {
    fitImageToView();
  } else {
    zoomTo(scale * ZOOM_DBLCLICK_FACTOR, e.clientX, e.clientY, true);
  }
});

// Wheel = zoom (cursor-centered). Always active. Shift not needed anymore.
modalImage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();

    // Use exponential zoom for natural feel (like Photoshop / Viewer.js)
    const delta = -e.deltaY; // positive = zoom in
    const factor = Math.exp(delta * ZOOM_WHEEL_FACTOR);
    zoomTo(scale * factor, e.clientX, e.clientY, false);
  },
  { passive: false },
);

// zoom buttons — now use central helper with smooth animation
zoomInBtn.addEventListener("click", () => {
  zoomTo(scale * ZOOM_BUTTON_FACTOR, null, null, true);
});
zoomOutBtn.addEventListener("click", () => {
  zoomTo(scale / ZOOM_BUTTON_FACTOR, null, null, true);
});
resetZoomBtn.addEventListener("click", () => {
  fitImageToView();
});

// Drag to pan (works whenever we are zoomed beyond fit)
modalImage.addEventListener("mousedown", (e) => {
  if (scale <= 1.01) return; // only pan when actually zoomed
  e.preventDefault();
  isDragging = true;
  dragStartX = e.clientX - translateX;
  dragStartY = e.clientY - translateY;
  modalImage.style.cursor = "grabbing";

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  window.addEventListener("mouseup", onMouseUp);
});

function onMouseMove(e) {
  if (!isDragging) return;
  translateX = e.clientX - dragStartX;
  translateY = e.clientY - dragStartY;
  modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  clampPan();
}

function onMouseUp() {
  isDragging = false;
  modalImage.style.cursor = scale > 1.01 ? "grab" : "zoom-in";
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
}

/* ========== Pinch-to-zoom (touch + pointer unified) ========== */
let pointers = new Map();

function getPinchDistance() {
  const pts = Array.from(pointers.values());
  if (pts.length < 2) return 0;
  const dx = pts[0].x - pts[1].x;
  const dy = pts[0].y - pts[1].y;
  return Math.hypot(dx, dy);
}

function getPinchCenter() {
  const pts = Array.from(pointers.values());
  if (pts.length < 2) return null;
  return {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
  };
}

modalImage.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // entering pinch
    modalImage.setPointerCapture(e.pointerId);
  }
});

modalImage.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    const dist = getPinchDistance();
    if (!modalImage._lastPinchDist) {
      modalImage._lastPinchDist = dist;
      return;
    }
    const center = getPinchCenter();
    const ratio = dist / modalImage._lastPinchDist;
    modalImage._lastPinchDist = dist;

    // Apply relative zoom toward pinch center
    zoomTo(scale * ratio, center.x, center.y, false);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  modalImage._lastPinchDist = 0;
  if (pointers.size < 2) {
    // back to single pointer or none — let normal drag take over if needed
  }
}
modalImage.addEventListener("pointerup", endPointer);
modalImage.addEventListener("pointercancel", endPointer);
modalImage.addEventListener("pointerleave", endPointer);

// prev/next buttons
prevBtn.addEventListener("click", () => navigateModal(-1));
nextBtn.addEventListener("click", () => navigateModal(1));

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

/* Zoom indicator helpers */
let zoomIndicatorTimeout = null;
const zoomIndicator = document.getElementById("zoomIndicator");

function showZoomIndicator(percent) {
  if (!zoomIndicator) return;
  zoomIndicator.textContent = `${percent}%`;
  zoomIndicator.classList.add("visible");
  zoomIndicator.setAttribute("aria-hidden", "false");

  clearTimeout(zoomIndicatorTimeout);
  zoomIndicatorTimeout = setTimeout(() => {
    hideZoomIndicator();
  }, 8000);
}

if (zoomIndicator) {
  zoomIndicator.style.pointerEvents = "auto";
  zoomIndicator.style.cursor = "pointer";
  zoomIndicator.addEventListener("click", () => {
    fitImageToView();
  });
}

function hideZoomIndicator() {
  if (!zoomIndicator) return;
  zoomIndicator.classList.remove("visible");
  zoomIndicator.setAttribute("aria-hidden", "true");
}

window.addEventListener("keydown", (e) => {
  // Skip if focused on input elements
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;

  if (modal.classList.contains("active")) {
    // Modal navigation + zoom
    if (e.key === "ArrowRight") navigateModal(1);
    else if (e.key === "ArrowLeft") navigateModal(-1);
    else if (e.key === "Escape") closeModal();
    else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomTo(scale * ZOOM_KEYBOARD_STEP, null, null, true);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomTo(scale / ZOOM_KEYBOARD_STEP, null, null, true);
    } else if (e.key === "0") {
      e.preventDefault();
      fitImageToView();
    } else if (e.key === "1") {
      e.preventDefault();
      const rect = modalImage.getBoundingClientRect();
      const target = (modalImage.naturalWidth || rect.width) / rect.width;
      zoomTo(Math.min(ZOOM_MAX, target), null, null, true);
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && scale > 1.05) {
      // Pan with arrows when zoomed
      e.preventDefault();
      const panStep = 80;
      if (e.key === "ArrowUp") translateY += panStep;
      if (e.key === "ArrowDown") translateY -= panStep;
      if (e.key === "ArrowLeft") translateX += panStep;
      if (e.key === "ArrowRight") translateX -= panStep;
      modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      clampPan();
    }
  } else {
    // Folder navigation (when modal is not open)
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateToSiblingFolder(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateToSiblingFolder(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (e.repeat) {
        arrowScrollVelocity = -ARROW_SCROLL_SPEED;
        if (!arrowScrollRAF) arrowContinuousScroll();
      } else {
        mainBody.scrollBy({ top: -400, behavior: "smooth" });
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (e.repeat) {
        arrowScrollVelocity = ARROW_SCROLL_SPEED;
        if (!arrowScrollRAF) arrowContinuousScroll();
      } else {
        mainBody.scrollBy({ top: 400, behavior: "smooth" });
      }
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
    const siblings = Array.from(
      container.querySelectorAll(":scope > .folder-node"),
    );
    const currentIndex = siblings.indexOf(folderNode);

    // Search siblings in the given direction
    let nextIndex = currentIndex + direction;
    while (nextIndex >= 0 && nextIndex < siblings.length) {
      const candidateNode = siblings[nextIndex];
      const candidateBtn = candidateNode.querySelector(":scope > .folder-btn");
      if (candidateBtn && candidateBtn._folderHandle) {
        const hasImages = await folderHasImages(candidateBtn._folderHandle);
        if (hasImages) {
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

function navigateModal(delta) {
  if (fileObjects.length === 0) return;
  currentModalIndex =
    (currentModalIndex + delta + fileObjects.length) % fileObjects.length;

  loadModalImage(fileObjects[currentModalIndex]);
}

/* ---------- Resize handling: when viewport changes while modal open, refit if not zoomed ---------- */
let resizeTimeout;
window.addEventListener("resize", () => {
  if (modal.classList.contains("active") && !zoomed) {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      fitImageToView();
    }, 100);
  }
});

/* ---------- helper to build initial state ---------- */
// ensure initial classes
gallery.classList.add("gallery", "layout-medium");

/* ---------- hide header when scroll down ---------- */
let lastScrollY = mainBody.scrollTop;
let header = document.querySelector(".header");
let ticking = false;
let scrollTimeout;

function handleScroll() {
  // Performance: Add is-scrolling class to disable hover effects
  document.body.classList.add("is-scrolling");
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    document.body.classList.remove("is-scrolling");
  }, 150);

  lastScrollY = mainBody.scrollTop;
  ticking = false;
}

function requestScrollTick(e) {
  if (!ticking) {
    window.requestAnimationFrame(handleScroll);
    ticking = true;
  }
}

mainBody.addEventListener("scroll", requestScrollTick, { passive: true });

// Pre-activate scroll optimizations on wheel event BEFORE the scroll actually fires.
// This prevents the first-frame stutter after idle because:
// 1. backdrop-filter is disabled before the scroll layout/paint
// 2. pointer-events are disabled before hover recalc
// The wheel event fires before the scroll event, giving us a head start.
mainBody.addEventListener("wheel", () => {
  if (!document.body.classList.contains("is-scrolling")) {
    document.body.classList.add("is-scrolling");
  }
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    document.body.classList.remove("is-scrolling");
  }, 150);
}, { passive: true });

// Scroll buttons
const scrollTopBtn = document.getElementById("scrollTopBtn");
const scrollBottomBtn = document.getElementById("scrollBottomBtn");
const scrollButtonsContainer = document.querySelector(".scroll-buttons");

// Check if page has vertical scrollbar and toggle button visibility
function updateScrollButtonsVisibility() {
  const hasScroll = mainBody.scrollHeight > mainBody.clientHeight;
  if (hasScroll) {
    scrollButtonsContainer.classList.add("visible");
  } else {
    scrollButtonsContainer.classList.remove("visible");
  }
}

// Check on load, resize, and when content changes
updateScrollButtonsVisibility();
window.addEventListener("resize", updateScrollButtonsVisibility);

// Create a MutationObserver to watch for content changes in gallery
const galleryObserver = new MutationObserver(updateScrollButtonsVisibility);
galleryObserver.observe(gallery, { childList: true, subtree: true });

scrollTopBtn.addEventListener("click", () => {
  mainBody.scrollTo({ top: 0, behavior: "smooth" });
});
scrollBottomBtn.addEventListener("click", () => {
  mainBody.scrollTo({ top: mainBody.scrollHeight, behavior: "smooth" });
});

const sidebarPin = document.getElementById("sidebarPin");
let sidebarPinned = false;

// Load pinned state from localStorage
const savedPinState = localStorage.getItem("sidebarPinned");
if (savedPinState === "true") {
  sidebarPinned = true;
  sidebar.classList.add("pinned");
  sidebarPin.classList.add("pinned");
  sidebarPin.title = "Unpin Sidebar";
  document.body.classList.add("sidebar-pinned");
}

sidebarPin.addEventListener("click", () => {
  sidebarPinned = !sidebarPinned;

  if (sidebarPinned) {
    sidebar.classList.add("pinned");
    sidebarPin.classList.add("pinned");
    sidebarPin.title = "Unpin Sidebar";
  } else {
    sidebar.classList.remove("pinned");
    sidebarPin.classList.remove("pinned");
    sidebarPin.title = "Pin Sidebar";
  }

  document.body.classList.toggle("sidebar-pinned", sidebarPinned);
  localStorage.setItem("sidebarPinned", sidebarPinned);
});


// Set current year in footer
const yearSpan = document.getElementById("copyrightYear");
if (yearSpan) {
  yearSpan.textContent = new Date().getFullYear();
}
