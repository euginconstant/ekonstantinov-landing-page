# Landing Page Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code/files and micro-optimize the static landing page with zero behavior change.

**Architecture:** In-place edits to 3 vanilla files (index.html, styles.css, main.js) + file deletion. No build tooling introduced.

**Tech Stack:** Plain HTML/CSS/JS, Google Fonts, git.

**Spec:** `docs/superpowers/specs/2026-09-01-cleanup-optimization-design.md`

## Global Constraints

- No build tools, bundlers, or new dependencies.
- No content or visual behavior changes (work/life modes must behave identically).
- Site language: ru (preserve all copy verbatim).
- Commits only with user's explicit approval (ask before first commit).
- Work in repo: `/Users/ekonstantinov/github/ekonstantinov-landing-page`

---

### Task 1: Remove Perplexity inline-edit script from index.html

**Files:**
- Modify: `index.html:441-770`

**Interfaces:** none (pure deletion).

- [ ] **Step 1: Delete the script block**

Replace (from `<script src="main.js"></script>` to end of file):

```html
<script src="main.js"></script>
<script data-pplx-inline-edit>
(function () {
...entire block through...
})();

&nbsp;
</script></body>
</html>
```

with:

```html
<script src="main.js"></script>
</body>
</html>
```

Practical method: delete everything from the line containing `<script data-pplx-inline-edit>` through the line `</script></body>`, then ensure the file ends with `</body>\n</html>`.

- [ ] **Step 2: Verify deletion**

Run: `grep -c "pplx\|INLINE_EDIT" index.html; wc -c index.html`
Expected: `0` matches; size drops from ~37964 bytes to ~23000 bytes.

---

### Task 2: Head cleanups in index.html

**Files:**
- Modify: `index.html` (head) and lines 135-136 (`data-draft`)

**Interfaces:** Produces `meta[name="theme-color"]` (consumed by Task 4's setMode update).

- [ ] **Step 1: Trim Handjet font weights**

Replace:
```html
<link href="https://fonts.googleapis.com/css2?family=Handjet:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```
with:
```html
<link href="https://fonts.googleapis.com/css2?family=Handjet:wght@700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

(Verified: every `--pixel` / Handjet usage in styles.css sets `font-weight:700`.)

- [ ] **Step 2: Add theme-color and og tags**

After the viewport meta line, insert:
```html
<meta name="theme-color" content="#0b0b0b">
<meta property="og:type" content="website">
<meta property="og:title" content="Евгений Константинов — work | life">
<meta property="og:description" content="Один сайт, два режима: work — Go, архитектура и adtech в Авито; life — дороги, Fujifilm и маленькие истории.">
```

- [ ] **Step 3: Remove data-draft attributes**

Replace:
```html
<dd data-draft>бег и велосипед</dd>
```
with:
```html
<dd>бег и велосипед</dd>
```
Replace:
```html
<dd data-draft>поддержание формы</dd>
```
with:
```html
<dd>поддержание формы</dd>
```

- [ ] **Step 4: Verify**

Run: `grep -c "Handjet:wght@700" index.html && grep -c "data-draft" index.html && grep -c "theme-color" index.html`
Expected: `1`, `0`, `1`.

---

### Task 3: styles.css dead rules + image-rendering order

**Files:**
- Modify: `styles.css`

**Interfaces:** none.

- [ ] **Step 1: Fix image-rendering order**

Replace:
```css
img{max-width:100%;height:auto;display:block;image-rendering:pixelated;image-rendering:crisp-edges}
```
with:
```css
img{max-width:100%;height:auto;display:block;image-rendering:crisp-edges;image-rendering:pixelated}
```

- [ ] **Step 2: Remove .h3 rule**

Delete the line:
```css
.h3{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:500;opacity:.85;margin-bottom:calc(var(--u)*3)}
```

- [ ] **Step 3: Remove .now block**

Delete the four lines:
```css
.now{border:var(--edge) solid currentColor;padding:calc(var(--u)*4);max-width:620px;box-shadow:8px 8px 0 0 var(--fg);background:var(--bg);position:relative;z-index:1}
.now__list{display:grid;gap:var(--u);font-size:15px}
.now__list li::before{content:'▸ ';opacity:.4}
.now__upd{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.4;margin-top:calc(var(--u)*3)}
```

- [ ] **Step 4: Remove .chan__meta rule**

Delete the line:
```css
.chan__meta{font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-top:var(--u)}
```

- [ ] **Step 5: Remove leftover empty section header**

Delete the two lines:
```css
/* ── режим заглушек ─────────────────────── */

```
(keep the following `/* ── появление при скролле ──────── */` header).

- [ ] **Step 6: Verify**

Run: `grep -c "\.h3{\|\.now{\|\.now__\|\.chan__meta\|режим заглушек" styles.css`
Expected: `0`.
Run: `grep -o "image-rendering:[a-z-]*" styles.css | head -2`
Expected: `image-rendering:crisp-edges` then `image-rendering:pixelated`.

---

### Task 4: main.js cleanup and reorder

**Files:**
- Modify: `main.js`

**Interfaces:**
- Consumes: `meta[name="theme-color"]` from Task 2.
- Produces: unchanged global `window.drawRoute` (used by setMode).

- [ ] **Step 1: Cache DOM lookups**

After line 9 (`const switchBtns = ...`), add:
```js
const langEl = document.getElementById('lang');
const uptimeEl = document.getElementById('uptime');
const themeColor = document.querySelector('meta[name="theme-color"]');
```

Rewrite `renderSpecial` to use cached elements:
```js
function renderSpecial(mode) {
  if (langEl) langEl.textContent = LANG[mode];
  if (uptimeEl) {
    uptimeEl.textContent = uptimeText(START[mode]);
    uptimeEl.setAttribute('title', mode === 'work'
      ? 'с 4 июля 2016 — начало работы в Авито'
      : 'с 7 сентября 1992');
  }
}
```

- [ ] **Step 2: Update theme-color in setMode**

Inside `setMode`, after `document.title = ...` line, add:
```js
if (themeColor) themeColor.setAttribute('content', mode === 'work' ? '#0b0b0b' : '#f3f1ec');
```

- [ ] **Step 3: Move drawRoute block above initial setMode**

Cut the entire block starting at `/* ── появление блоков ────────────────── */` header's **route part**:

```js
const routeWrap = document.querySelector('.routewrap');
const routeSvg = document.getElementById('routePath');
const routePathEl = routeSvg && routeSvg.querySelector('path');

function drawRoute() { ... unchanged body ... }
window.drawRoute = drawRoute;

if (routeWrap) {
  drawRoute();
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawRoute, 120); });
  if ('ResizeObserver' in window) new ResizeObserver(() => drawRoute()).observe(routeWrap);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawRoute);
}
```

and paste it before the `/* стартовый режим */` comment (before `let initial = 'work';`), with the debounced resize listener removed:

```js
if (routeWrap) {
  drawRoute();
  if ('ResizeObserver' in window) new ResizeObserver(() => drawRoute()).observe(routeWrap);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawRoute);
}
```

- [ ] **Step 4: Remove .now from reveal targets**

Replace:
```js
const targets = document.querySelectorAll('.log__item, .cards li, .route__stop, .now, .prose p, .facts, .lead, .chan__main, .chan__other');
```
with:
```js
const targets = document.querySelectorAll('.log__item, .cards li, .route__stop, .prose p, .facts, .lead, .chan__main, .chan__other');
```

- [ ] **Step 5: Fix onScroll indentation**

Replace:
```js
  let raf = null;
  const onScroll = () => {
  if (!fill || raf) return;

  raf = requestAnimationFrame(() => {
    raf = null;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
    fill.style.width = `${Math.round(p * 40) / 40 * 100}%`;
  });
};
```
with:
```js
  let raf = null;
  const onScroll = () => {
    if (!fill || raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      fill.style.width = `${Math.round(p * 40) / 40 * 100}%`;
    });
  };
```

- [ ] **Step 6: Verify syntax**

Run: `node --check main.js`
Expected: no output (exit 0).
Run: `grep -c "\.now" main.js; grep -c "setTimeout(drawRoute" main.js`
Expected: `0`, `0`.

---

### Task 5: File and asset cleanup

**Files:**
- Create: `.gitignore`
- Delete: `index.html.txt`, `main.js.txt`, `.DS_Store`, `assets/band-black.png`, `assets/band-white.png`, `assets/portrait-dark-sm.png`, `assets/portrait-light-sm.png`

**Interfaces:** none.

- [ ] **Step 1: Delete untracked clutter**

```bash
rm -f index.html.txt main.js.txt .DS_Store
```

- [ ] **Step 2: git rm unused assets**

```bash
git rm assets/band-black.png assets/band-white.png assets/portrait-dark-sm.png assets/portrait-light-sm.png
```

- [ ] **Step 3: Add .gitignore**

Create `.gitignore`:
```
.DS_Store
```

- [ ] **Step 4: Verify no dangling references**

Run: `grep -rn "band-\|-sm\.png" index.html main.js styles.css`
Expected: no matches. Exit code 1.

---

### Task 6: Final verification

**Files:** none modified (checks only).

- [ ] **Step 1: Syntax + size checks**

Run: `node --check main.js && wc -c index.html styles.css main.js`
Expected: sizes ≈ 23000 / ~19700 / ~8200 bytes.

- [ ] **Step 2: Serve locally**

Run: `python3 -m http.server 8765` in repo root; `curl -s localhost:8765 | head -20` returns the page.

- [ ] **Step 3: Manual smoke test (user or browser)**

Check in browser at `http://localhost:8765`:
- Default work mode renders; portrait, boot animation, progress bar visible.
- Switch to life via button, `L` key, `→` key: flash sweep, palette inverts, portrait swaps, route section draws dashed line through pins.
- `#life` in URL loads life mode directly.
- Scroll: reveal animations fire once; nav highlight follows sections.
- Footer kbd hint W/L works.

- [ ] **Step 4: git status review**

Run: `git status --short`
Expected: modifications to index.html/styles.css/main.js, deletions of 4 assets, new .gitignore, docs/ untracked. Review with user; ask about committing.
