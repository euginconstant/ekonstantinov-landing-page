(() => {
  'use strict';

  const html = document.documentElement;
  const fill = document.getElementById('progressFill');
  const portrait = document.getElementById('portrait');
  const navLinks = [...document.querySelectorAll('.bar__nav a')];
  const modeBtns = [...document.querySelectorAll('[data-mode-btn]')];
  const switchBtns = [...document.querySelectorAll('[data-switch]')];

  /* ── даты отсчёта uptime ─────────────── */
  const START = {
    work: new Date(2016, 6, 4),  // 4 июля 2016 — начало в Авито
    life: new Date(1992, 8, 7),  // 7 сентября 1992
  };
  const LANG = { work: 'GO', life: 'RU' };

  /* ── склонение ───────────────────────── */
  const plural = (n, forms) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  };

  function uptimeText(from) {
    const now = new Date();
    let years = now.getFullYear() - from.getFullYear();
    const anniv = new Date(from);
    anniv.setFullYear(from.getFullYear() + years);
    if (anniv > now) { years -= 1; anniv.setFullYear(anniv.getFullYear() - 1); }
    const days = Math.floor((now - anniv) / 86400000);
    const y = `${years} ${plural(years, ['год', 'года', 'лет'])}`;
    const d = `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
    return `${y} ${d}`;
  }

  function renderSpecial(mode) {
    const lang = document.getElementById('lang');
    const up = document.getElementById('uptime');
    if (lang) lang.textContent = LANG[mode];
    if (up) {
      up.textContent = uptimeText(START[mode]);
      up.setAttribute('title', mode === 'work'
        ? 'с 4 июля 2016 — начало работы в Авито'
        : 'с 7 сентября 1992');
    }
  }

  /* ── смена режима ────────────────────── */
  function setMode(mode, opts = {}) {
    if (mode !== 'work' && mode !== 'life') mode = 'work';
    const changed = html.dataset.mode !== mode;
    html.dataset.mode = mode;

    modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modeBtn === mode)));
    document.querySelectorAll('.bar__host, .foot__host, .h2__mode').forEach(el => { el.textContent = mode; });
    document.title = `ekonstantinov — ${mode}`;

    if (portrait) {
      const want = mode === 'work' ? 'assets/portrait-light.png' : 'assets/portrait-dark.png';
      const currentSrc = portrait.getAttribute('src') || '';
      if (!currentSrc.endsWith(want)) {
        portrait.setAttribute('src', want);
      }
    }

    const chan = document.getElementById('chanMain');
    if (chan) chan.setAttribute('href', mode === 'work' ? 'https://t.me/work_is_ok' : 'https://t.me/home_is_better');

    renderSpecial(mode);
    if (typeof window.drawRoute === 'function') requestAnimationFrame(() => window.drawRoute());

    try { history.replaceState(null, '', '#' + mode); } catch (e) { /* iframe без history */ }

    if (changed && !opts.silent) {
      document.body.classList.remove('switching');
      void document.body.offsetWidth;
      document.body.classList.add('switching');
      setTimeout(() => document.body.classList.remove('switching'), 320);
    }
  }

  const otherMode = () => (html.dataset.mode === 'work' ? 'life' : 'work');

  modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.modeBtn)));
  switchBtns.forEach(b => b.addEventListener('click', () => setMode(otherMode())));

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'ц') setMode('work');
    else if (k === 'l' || k === 'д') setMode('life');
    else if (k === 'arrowleft') setMode('work');
    else if (k === 'arrowright') setMode('life');
  });

  /* стартовый режим: из адреса (#work / #life), иначе work */
  let initial = 'work';
  const hash = (location.hash || '').replace('#', '');
  if (hash === 'work' || hash === 'life') initial = hash;
  setMode(initial, { silent: true });
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace('#', '');
    if (h === 'work' || h === 'life') setMode(h);
  });
  setInterval(() => renderSpecial(html.dataset.mode), 60000);

  /* ── прогресс чтения ─────────────────── */
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
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  /* ── появление блоков ────────────────── */
  const routeWrap = document.querySelector('.routewrap');
  const routeSvg = document.getElementById('routePath');
  const routePathEl = routeSvg && routeSvg.querySelector('path');

  function drawRoute() {
    if (!routeWrap || !routePathEl) return;
    const box = routeWrap.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    routeSvg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);

    const pts = [...routeWrap.querySelectorAll('.route__pin')].map(pin => {
      const r = pin.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    });
    if (pts.length < 2) return;

    let d = 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const bend = Math.max(18, (b.y - a.y) * 0.45);
      d += ' C ' + a.x.toFixed(1) + ' ' + (a.y + bend).toFixed(1)
        + ', ' + b.x.toFixed(1) + ' ' + (b.y - bend).toFixed(1)
        + ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
    }
    routePathEl.setAttribute('d', d);
  }
  window.drawRoute = drawRoute;

  if (routeWrap) {
    drawRoute();
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawRoute, 120); });
    if ('ResizeObserver' in window) new ResizeObserver(() => drawRoute()).observe(routeWrap);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawRoute);
  }

  const targets = document.querySelectorAll('.log__item, .cards li, .route__stop, .now, .prose p, .facts, .lead, .chan__main, .chan__other');
  targets.forEach(t => t.classList.add('reveal'));
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
  targets.forEach(t => io.observe(t));

  /* ── проявление портрета ─────────────── */
  const frame = document.querySelector('.frame');
  if (frame) {
    const pio = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); obs.disconnect(); } });
    }, { threshold: 0.15 });
    pio.observe(frame);
  }

  /* ── активный раздел в панели ────────── */
  const sections = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const nio = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const link = navLinks.find(a => a.getAttribute('href') === '#' + e.target.id);
      if (!link) return;
      if (e.isIntersecting) {
        navLinks.forEach(a => a.removeAttribute('aria-current'));
        link.setAttribute('aria-current', 'true');
      }
    });
  }, { rootMargin: '-25% 0px -60% 0px' });
  sections.forEach(s => nio.observe(s));

})();
