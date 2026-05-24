# AGENTS.md

Pure static vanilla HTML/CSS/JS single-page image viewer (manga/manhwa reader). No framework, no build system, no tests, no packages.

## How to run
- Open `index.html` directly in a browser (Chrome/Edge preferred for full File System Access API support).
- Works over `file://` or any static server. No install, build, or commands required.

## Core architecture (non-obvious)
- **Two distinct modes** (tab-switched, state in `mode` variable):
  - Manga: Grid thumbnails + modal viewer with zoom/pan/drag.
  - Manhwa: Vertical continuous scroll (wider default ~70vw, no modal).
- Folder loading: Prefers `showDirectoryPicker()` (File System Access API) with `webkitdirectory` input fallback. Only root-level images (non-recursive).
- Virtual scrolling + memory: `IntersectionObserver` on `#sentinel`, `BATCH_SIZE=20`, RAF batching. Critical: 8-second deferred unload of offscreen images (see `initUnloadObserver`, `UNLOAD_DELAY`, `pendingUnloads`). Object URLs tracked in `objectURLs` Set and revoked on unload.
- Thumbnails: `createImageBitmap` + canvas for fast uniform sizing.
- Sidebar: Resizable (via `#sidebarResizer`), pinnable (`#sidebarPin`), folder tree with context menu, reload button.
- Theme: Toggle persists in `localStorage.theme`, applied as `data-theme="light"` on `<html>`.

## Performance patterns to preserve
- Never create blob Object URLs eagerly — defer to unveil time.
- Unload images after 8s offscreen (not immediately) to avoid scroll stutter on idle.
- Pre-activate scroll optimizations on first wheel event.
- Keep `renderedImages` Set and `imageDimensionsCache` Map in sync on load/unload/reset.

## Critical: Ignore existing agent rules
- `.agent/rules/global.md` and `.agent/skills/react-best-practices*` contain Vercel React/Next.js guidelines.
- **These have zero relevance here.** Do not apply RSC, React cache, SWR, memoization rules, barrel import advice, or any React patterns to `script.js`, `index.html`, or `style.css`.

## What does not exist (do not hallucinate)
- No `package.json`, npm/pnpm/yarn, build, lint, test, typecheck, or codegen.
- No `.github/workflows`, no CI, no monorepo, no generated files.
- Never run or suggest commands like `npm run`, `lint`, `test`, `build`.

## LocalStorage keys (state)
- `theme`
- `sidebarWidth`
- `sidebarPinned`

## When editing
- Test with large folders (100+ images) after scroll/unload changes.
- Maintain compatibility with both modern picker and legacy file input.
- All image data is client-side blobs — watch for leaks and quota errors.
