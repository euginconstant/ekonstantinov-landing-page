# Cleanup & optimization: ekonstantinov-landing-page

Date: 2026-09-01
Status: approved by user (design + scope)

## Context

Static landing page (vanilla HTML/CSS/JS, no build system, 3 tracked files + assets).
Goal: remove dead weight and non-optimal code without changing site behavior.

## 1. Deletions

### index.html
- Remove Perplexity inline-edit script (lines ~442–770, ~15 KB). It only runs
  inside Perplexity's iframe editor and is dead weight for every visitor.
  It gets re-injected by Perplexity automatically when editing there again.
- Remove `data-draft` attributes (no CSS/JS hooks them).

### Files
- Delete local (untracked) clutter: `index.html.txt`, `main.js.txt`, `.DS_Store`.
- `git rm` unused assets: `assets/band-black.png`, `assets/band-white.png`,
  `assets/portrait-dark-sm.png`, `assets/portrait-light-sm.png`
  (verified: zero references in HTML/CSS/JS).
- Add `.gitignore` with `.DS_Store`.

### styles.css
- Remove dead rules: `.h3`, `.now`, `.now__list`, `.now__upd`, `.chan__meta`,
  and the leftover empty section header `/* режим заглушек */`.

### main.js
- Remove `.now` from the IntersectionObserver `targets` selector.
- Remove the debounced `resize` listener for route redraw (line ~160);
  `ResizeObserver` on `.routewrap` already covers all size changes.

## 2. Optimizations

### Fonts (index.html)
- Google Fonts URL: load Handjet at weight 700 only (400/500 unused);
  JetBrains Mono keeps 400;500;700.

### styles.css
- Fix `image-rendering` order on `img`: declare `crisp-edges` first,
  `pixelated` last, so pixelated wins where supported.

### main.js
- Cache `#lang` / `#uptime` lookups once instead of per `renderSpecial` call.
- Fix broken indentation of the `onScroll` progress function.
- Move the `drawRoute` block above the initial `setMode()` call so the
  rAF-redirected `window.drawRoute` from `setMode` actually works at init.

### index.html head
- Add `<meta name="theme-color">`; update its value in `setMode`
  (work: `#0b0b0b`, life: `#f3f1ec`).
- Add `og:title`, `og:description` for nice Telegram sharing previews.

## 3. Verification

- Serve locally, check both modes: mode switch (buttons, W/L keys, arrows),
  flash animation, route line drawing, progress bar, scroll reveal,
  keyboard shortcuts, active nav highlighting.
- Expected: `index.html` ~38 KB -> ~23 KB; no behavioral change.
- `git status` clean of untracked clutter afterwards.

## Out of scope

- No build tooling, no bundler, no refactoring into modules.
- No content changes.
