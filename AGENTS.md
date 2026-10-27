# AGENTS.md

Pure static vanilla HTML/CSS/JS single-page image viewer (manga/manhwa reader). No framework, no build system, no packages, no dependencies.

## How to run
- Open `index.html` directly in a browser (Chrome/Edge preferred for full File System Access API support).
- Works over `file://` or any static server. No install, build, or commands required.
- Checks: `node tests/<name>.test.js` (plain `node:assert`, no framework). Pure helpers live in `explorer-tree.js`, `image-size-controls.js`, `modal-zoom.js` (browser globals + CommonJS export).

## Core architecture (non-obvious)
- **Two distinct modes** (tab-switched, state in `mode` variable):
  - Manga: Grid thumbnails + `<dialog>` viewer with zoom/pan/pinch (math in `modal-zoom.js`).
  - Manhwa: Vertical continuous strip (30vw default, 100% on phones; width is the `--manhwa-width` CSS variable).
- Folder loading: Prefers `showDirectoryPicker()` (File System Access API) with `webkitdirectory` input and drag-and-drop fallbacks (virtual handles). Only the selected folder's images are shown; subfolders are read on demand in the Explorer tree.
- Files sort in reading order (`compareFileNames`, numeric collation). The A–Z / 1–9 toggle only sorts folders.
- Gallery loading (`resetGallery`): every file gets a cheap placeholder up front (scrollbar and jumps cover the whole folder). `loadObserver` (`LOAD_MARGIN`) queues items nearest-first; at most `MAX_ACTIVE_LOADS` decode at once and queued items scrolled past are skipped. `unloadObserver` releases items `UNLOAD_DELAY` (8s) after they leave `UNLOAD_MARGIN` (5000px).
- Manhwa pages decode with `img.decode()` before insertion; each item keeps its natural aspect ratio (`imageDimensionsCache`, `--manhwa-ratio` estimate for undecoded pages) so nothing jumps.
- Manga thumbnails: `createImageBitmap(file, {resizeWidth: cell × DPR})` → `bitmaprenderer` canvas; `<img>` fallback for formats it can't decode (SVG).
- Object URLs: one per File in the `objectURLs` Map, created on first use (`getObjectURL`), revoked together in `showFolderImages` when another folder opens.
- Layout: `.workspace` row = sidebar + `#mainBody` (the scroll container and IntersectionObserver root). Floating sidebar is absolutely positioned; pinned (desktop only) it takes layout space.
- Sidebar: Resizable (`#sidebarResizer`, pointer events), pinnable (`#sidebarPin`), folder tree with context menu, reload button (keeps the current folder).
- Theme: Toggle persists in `localStorage.theme`, applied as `data-theme="light"` on `<html>` by the inline script in `<head>` (no flash).

## Performance patterns to preserve
- Never create blob Object URLs eagerly — only when an image is actually decoded or opened.
- Unload images after 8s offscreen (not immediately) to avoid scroll stutter on quick back-scrolls.
- Pre-activate scroll optimizations on first wheel event (`markScrolling`).
- Only items being decoded animate (`.is-loading`); never put infinite animations on every item.
- Gallery items use `contain: strict`; their size must come from CSS/aspect-ratio, never from content.
- Clear `imageDimensionsCache` and revoke `objectURLs` when the folder changes; keep them across mode switches.

## Critical: Ignore existing agent rules
- `.agent/rules/global.md` and `.agent/skills/react-best-practices*` contain Vercel React/Next.js guidelines.
- **These have zero relevance here.** Do not apply RSC, React cache, SWR, memoization rules, barrel import advice, or any React patterns to `script.js`, `index.html`, or `style.css`.

## What does not exist (do not hallucinate)
- No `package.json`, npm/pnpm/yarn, build, lint, typecheck, or codegen.
- No `.github/workflows`, no CI, no monorepo, no generated files.
- Never run or suggest commands like `npm run`, `lint`, `build`.

## LocalStorage keys (state)
- `theme`
- `sidebarWidth`
- `sidebarPinned`
- `explorerSortMode`

## When editing
- Test with large folders (100+ images) after scroll/unload changes.
- Maintain compatibility with both modern picker and legacy file input.
- All image data is client-side blobs — watch for leaks and quota errors.
