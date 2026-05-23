"use strict";
/* script.js
- Supports selecting a folder (showDirectoryPicker or fallback webkitdirectory)
- Non-recursive: only root folder images
- Two tabs: Manga (grid + modal) and Manhwa (vertical, 70vw, no modal)
- Gallery thumbnails uniform size via .gallery-item & object-fit: cover
- Infinite scroll with IntersectionObserver on #sentinel + requestAnimationFrame
- Batch size fixed = 20
- Performance Optimization: Uses createImageBitmap for thumbnails, Canvas for rendering
- Deferred Object URL creation: URLs created at unveil time, not at DOM insertion
*/

// Configure lazysizes for fast scrolling (must be before lazysizes loads)
window.lazySizesConfig = window.lazySizesConfig || {};
window.lazySizesConfig.expand = 300; // Preload 300px ahead (reduced from default 370)
window.lazySizesConfig.expFactor = 1.5; // Expansion factor during idle
window.lazySizesConfig.hFac = 0.8; // Height factor for horizontal scroll
window.lazySizesConfig.loadMode = 2; // Load images in view + nearby
window.lazySizesConfig.throttleDelay = 125; // Throttle scroll events

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

let modalMaxWidthVW = 30; // default
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
                URL.revokeObjectURL(img.src);
                objectURLs.delete(img.src);
              }
              wrapper.innerHTML = '';
              wrapper.classList.add('is-unloaded');
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
        }
      }
    });
  }, {
    root: mainBody,
    rootMargin: "5000px" // Larger buffer: only unload items very far offscreen
  });
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

// allowed extensions
const extRegex = /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i;

function isImageName(name) {
  return extRegex.test(name);
}

const sidebar = document.getElementById("sidebar");
let subfolders = []; // [{name, handle}]
let currentFolderHandle = null;
let currentSubfolder = null;

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
  // Sort by name
  fileObjects.sort((a, b) => a.name.localeCompare(b.name));
  subfolders.sort((a, b) => a.name.localeCompare(b.name));

  await renderSidebarTree();
  resetAndLoad();
  sidebar.classList.add("open");
}

// Khi chọn folder con, duyệt sâu vào folder đó
async function handleSubfolderHandle(dirHandle) {
  if (currentFullResUrl) {
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
  folders.sort((a, b) => a.name.localeCompare(b.name));
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

  // Tự động set modalMaxWidthSelect về 70 khi chuyển sang manga
  maxWidthSelect.value = "70";
  modalMaxWidthVW = 70;
  maxWidthVW = 70;
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

  // Tự động set modalMaxWidthSelect về 30 khi chuyển sang manhwa
  maxWidthSelect.value = "30";
  modalMaxWidthVW = 30;
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

  // Revoke all Object URLs to free memory
  objectURLs.forEach((url) => URL.revokeObjectURL(url));
  objectURLs.clear();

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
  }
}

// Helper: Create inner element (canvas/img) attached via unload observer
function createInnerElement(file) {
  if (mode === "manhwa") {
    const img = document.createElement("img");
    img.alt = file.name;
    img.loading = "lazy";
    img.decoding = "async";
    img.classList.add("lazyload", "skeleton-loading");
    img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    img._file = file;
    img.dataset.src = "about:blank";

    img.addEventListener("lazyloaded", () => {
      img.classList.remove("skeleton-loading");
      // Remove hardcoded wrapper height once loaded to allow natural resize
      if (img.parentElement) {
        img.parentElement.style.height = ''; 
      }
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
}

/* ---------- Clear ---------- */
clearBtn.addEventListener("click", () => {
  // Stop continuous loading
  stopContinuousLoading();

  if (currentFullResUrl) {
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
    URL.revokeObjectURL(currentFullResUrl);
  }

  resetZoomState();

  // Create new URL for full res
  currentFullResUrl = URL.createObjectURL(file);
  modalImage.src = currentFullResUrl;

  modalImage.onload = () => {
    fitImageToViewWidth();
  };
}

function fitImageToViewWidth() {
  const vw = window.innerWidth * (modalMaxWidthVW / 100);
  const imgW = modalImage.naturalWidth || modalImage.width;
  const imgH = modalImage.naturalHeight || modalImage.height;
  const aspect = imgH / imgW;

  let displayW = vw;
  let displayH = vw * aspect;

  // nếu vượt chiều cao viewport, giảm theo chiều cao
  const maxH = window.innerHeight * 0.9;
  if (displayH > maxH) {
    displayH = maxH;
    displayW = maxH / aspect;
  }

  modalImage.style.width = `${displayW}px`;
  modalImage.style.height = `${displayH}px`;
  modalImage.style.objectFit = "contain";

  resetZoomState();
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
  modalMaxWidthVW = parseInt(e.target.value) || 30;
  maxWidthVW = modalMaxWidthVW; // Đảm bảo đồng bộ cho manhwa

  // Refit modal nếu đang mở (Manga)
  if (mode === "manga" && modal.classList.contains("active") && !zoomed) {
    fitImageToViewWidth();
  }

  // Cập nhật lại Manhwa images
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
  modalImage.style.transformOrigin = "50% 50%";
  modalImage.style.transform = "translate(0px, 0px) scale(1)";
  modalImage.style.cursor = "zoom-in";
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

// click image to toggle zoom into clicked point
modalImage.addEventListener("click", (e) => {
  if (!zoomed) {
    // calculate click position relative to image element
    const rect = modalImage.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const percentX = (offsetX / rect.width) * 100;
    const percentY = (offsetY / rect.height) * 100;

    zoomed = true;
    scale = 2; // zoom multiplier (tweakable)
    originX = percentX;
    originY = percentY;
    modalImage.style.transformOrigin = `${originX}% ${originY}%`;
    modalImage.style.transform = `translate(0px, 0px) scale(${scale})`;
    modalImage.style.cursor = "grab";
    translateX = 0;
    translateY = 0;
  } // else {
  //   // return to fit 90vw
  //   fitImageToViewWidth();
  // }
});

// wheel to move when zoomed: vertical by default; Shift + wheel -> horizontal
modalImage.addEventListener(
  "wheel",
  (e) => {
    if (!zoomed) return;
    e.preventDefault();
    const speed = 40; // pixels per wheel delta step - tune as needed
    // deltaY > 0 means scroll down -> move image up -> translateY decreases
    if (e.shiftKey) {
      translateX -= e.deltaY > 0 ? speed : -speed;
    } else {
      translateY -= e.deltaY > 0 ? speed : -speed;
    }
    modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  },
  { passive: false },
);

// zoom buttons
zoomInBtn.addEventListener("click", () => {
  if (!zoomed) {
    zoomed = true;
    scale = 1;
  } // start zoom from current fit
  scale *= 1.2;
  modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  modalImage.style.cursor = "grab";
});
zoomOutBtn.addEventListener("click", () => {
  scale = Math.max(1, scale / 1.2);
  if (scale === 1) {
    // back to fit
    fitImageToViewWidth();
  } else {
    modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }
});
resetZoomBtn.addEventListener("click", () => {
  fitImageToViewWidth();
});

// bắt đầu drag
modalImage.addEventListener("mousedown", (e) => {
  if (!zoomed) return;
  e.preventDefault();
  isDragging = true;
  dragStartX = e.clientX - translateX;
  dragStartY = e.clientY - translateY;
  modalImage.style.cursor = "grabbing";

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  window.addEventListener("mouseup", onMouseUp);
});

// kéo
function onMouseMove(e) {
  if (!zoomed || !isDragging) return;
  translateX = e.clientX - dragStartX;
  translateY = e.clientY - dragStartY;
  modalImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

// kết thúc drag
function onMouseUp() {
  if (!zoomed) return;
  isDragging = false;
  modalImage.style.cursor = "grab";
  
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
}

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

window.addEventListener("keydown", (e) => {
  // Skip if focused on input elements
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;

  if (modal.classList.contains("active")) {
    // Modal navigation
    if (e.key === "ArrowRight") navigateModal(1);
    else if (e.key === "ArrowLeft") navigateModal(-1);
    else if (e.key === "Escape") closeModal();
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
      fitImageToViewWidth();
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

  // Save state to localStorage
  localStorage.setItem("sidebarPinned", sidebarPinned);
});

// Set current year in footer
const yearSpan = document.getElementById("copyrightYear");
if (yearSpan) {
  yearSpan.textContent = new Date().getFullYear();
}
