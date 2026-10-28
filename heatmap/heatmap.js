// Travel Heatmap — ванильный порт Next.js-компонента (src/components/heatmap/travel-heatmap.tsx
// исходного проекта). Логика отрисовки, санитизации и PIP перенесена 1:1, изменения:
// - данные v2 — СЕТКА вместо треков: в бандле нет GPS-точек, только ячейки
//   «посещено» с флагами (вид спорта, повторность) на трёх уровнях детализации;
//   рендер выбирает уровень по зуму, интенсивность — один визит vs несколько;
// - контуры грузятся только посещённых стран (+ РФ для PIP-классификации) и регионов;
// - при импорте пользовательских треков: теги считаются компактным PIP-индексом;
//   промах по стране/региону → разовая догрузка полной геометрии (geo/full/*);
//   вид спорта определяется на лету (FIT sessions sport / GPX <type>), иначе «Другое»;
//   свои треки рендерятся точно (они не покидают браузер);
// - кнопка «Сбросить треки» возвращает исходную сетку;
// - по умолчанию включены страны, регионы и тёмная база.

import * as L from './vendor/leaflet.js';

const SHIFTS = [-720, -360, 0, 360, 720]; // копии мира для антимеридиана
const MAX_ZOOM = 11; // максимум зума карты
const TILE_URLS = {
  light:
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  dark:
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
}; // Esri Gray Canvas: единственный серый стиль, свободно отдающий тайлы без ключа
const TILE_ATTR = 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ';
const MARGIN = 256; // запас канвы за краями вьюпорта (px)
const RU_ISO = 'RU'; // домашняя страна: в PIP-индексе есть, но не подсвечивается

const SPORTS = [
  { key: 'run', label: 'Бег' },
  { key: 'hike', label: 'Пешие' },
  { key: 'ride', label: 'Вело' },
  { key: 'other', label: 'Другое' },
];
const SPORT_BIT = { run: 1, hike: 2, ride: 4, other: 8 };
const BUCKET_T = [0.5, 0.65, 0.8]; // градации яркости: 1 / ≥4 / ≥16 визитов

// Inferno LUT (256), интерполяция по опорным точкам matplotlib
const INFERNO_STOPS = [
  [0.0, 1, 0, 4], [0.1, 22, 11, 56], [0.2, 59, 13, 85], [0.3, 97, 17, 93],
  [0.4, 135, 25, 88], [0.5, 169, 40, 72], [0.6, 201, 63, 48], [0.7, 225, 98, 17],
  [0.8, 242, 142, 7], [0.9, 252, 193, 54], [1.0, 252, 255, 164],
];
const LUT = (() => {
  const out = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = INFERNO_STOPS[0];
    let b = INFERNO_STOPS[INFERNO_STOPS.length - 1];
    for (let s = 0; s < INFERNO_STOPS.length - 1; s++) {
      if (t >= INFERNO_STOPS[s][0] && t <= INFERNO_STOPS[s + 1][0]) {
        a = INFERNO_STOPS[s];
        b = INFERNO_STOPS[s + 1];
        break;
      }
    }
    const f = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
    out.push([
      Math.round(a[1] + f * (b[1] - a[1])),
      Math.round(a[2] + f * (b[2] - a[2])),
      Math.round(a[3] + f * (b[3] - a[3])),
    ]);
  }
  return out;
})();

// ---------- состояние ----------
let map = null;
let tileLayer = null;
let countriesLayer = null;
let regionsLayer = null;
let heatCanvas = null;
let binCanvas = null;
let rafId = 0;

/**
 * Бандл v2 — сетка, без GPS-точек:
 * { totals: {tracks, km, bySport}, grids: [{cell, cells: [la, lo, flags, …]}],
 *   countries: {iso: [кол-во треков, маска спорта]}, regions: {code: […]} }
 */
let bundle = null;
let bundleActive = true; // «Сброс» прячет сетку; «Вернуть мои треки» — возвращает
let userTracks = []; // импортированные пользователем (точные, локальные)
let sportCounts = { run: 0, hike: 0, ride: 0, other: 0 };
const sportsOn = new Set(SPORTS.map((s) => s.key));

let showCountries = true;
let showRegions = true;
let theme = 'dark'; // тумблер «Тёмная база» включён по умолчанию

let visitedCountries = new Map(); // iso -> число треков
let visitedRegions = new Map(); // code -> число треков

// геометрия: компактные наборы (посещённое) + полные (догружаются при промахе)
let countriesIdx = null; // PIP: посещённые страны + РФ
let regionsIdx = null; // PIP: посещённые регионы РФ
const countriesFeatures = new Map(); // iso -> GeoJSON-feature (контуры для отрисовки, без РФ)
const regionsFeatures = new Map(); // code -> feature
let fullCountriesIdx = null;
let fullCountriesFC = null;
let fullCountriesPromise = null;
let fullRegionsIdx = null;
let fullRegionsPromise = null;

const el = {};
const $ = (id) => document.getElementById(id);

// ---------- геодезия / санитизация (порт lib/heatmap/sanitize.ts) ----------
const EARTH_R = 6371000;
const SPIKE_M = 400;
const CUT_M = 1000;

function haversineM(a, b) {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validPoint(p) {
  if (!p) return false;
  const [lat, lon] = p;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function sanitizeTrack(raw) {
  const pts = [];
  for (const p of raw) if (validPoint(p)) pts.push(p);

  // срез спайков: точка далеко от обоих соседей, когда соседи рядом
  const kept = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = kept.length ? kept[kept.length - 1] : null;
    const next = pts[i + 1] ?? null;
    const cur = pts[i];
    if (prev && next) {
      const dPrev = haversineM(prev, cur);
      const dNext = haversineM(cur, next);
      const dSkip = haversineM(prev, next);
      if (dPrev > SPIKE_M && dNext > SPIKE_M && dSkip < SPIKE_M) continue;
    }
    kept.push(cur);
  }

  // разрывы по телепортам
  const parts = [];
  let part = [];
  for (let i = 0; i < kept.length; i++) {
    if (part.length === 0) {
      part.push(kept[i]);
      continue;
    }
    if (haversineM(part[part.length - 1], kept[i]) > CUT_M) {
      if (part.length >= 2) parts.push(part);
      part = [];
    }
    part.push(kept[i]);
  }
  if (part.length >= 2) parts.push(part);

  let distanceKm = 0;
  for (const p of parts) {
    for (let i = 1; i < p.length; i++) distanceKm += haversineM(p[i - 1], p[i]);
  }
  return { parts, distanceKm: Math.round((distanceKm / 1000) * 100) / 100 };
}

// ---------- PIP (порт lib/heatmap/geo-pip.ts) ----------
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function createPipIndex(features, keyOf) {
  const polys = [];
  const props = new Map();
  for (const f of features) {
    const key = keyOf(f.properties);
    props.set(key, f.properties);
    const polysOf = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const rings of polysOf) {
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      for (const [lon, lat] of rings[0]) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
      polys.push({ key, rings, bbox: [minLon, minLat, maxLon, maxLat] });
    }
  }
  return {
    at(lat, lon) {
      for (const p of polys) {
        const [minLon, minLat, maxLon, maxLat] = p.bbox;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        if (!inRing(lat, lon, p.rings[0])) continue;
        let inHole = false;
        for (let h = 1; h < p.rings.length; h++) if (inRing(lat, lon, p.rings[h])) inHole = true;
        if (!inHole) return p.key;
      }
      return null;
    },
    propertyOf: (k) => props.get(k),
  };
}

// кэш по ячейкам: точки в одной ячейке сетки дают одинаковый результат PIP
function cellResolver(resolve, cellDeg = 0.0025) {
  const cache = new Map();
  return (lat, lon) => {
    const k = Math.round(lat / cellDeg) * 100000 + Math.round(lon / cellDeg);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const v = resolve(lat, lon);
    cache.set(k, v);
    return v;
  };
}

function tracksPlural(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} трека`;
  return `${n} треков`;
}

// Классификация вида спорта на лету (порт normalizeSport из build-bundle.ts:
// FIT sessions sport / GPX <type> → run|walk|hike|cycl…)
function normalizeSport(raw) {
  const s = (raw ?? '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('run') || s === 'treadmill') return 'run';
  if (s.includes('walk') || s.includes('hik')) return 'hike';
  if (s.includes('cycl') || s.includes('bik')) return 'ride';
  return 'other';
}

// ---------- тепловая канва ----------
function activeTracks() {
  return (bundleActive ? [] : []).concat(userTracks); // сетка рендерится отдельно, см. redrawHeat
}

/** Уровень сетки под текущий зум: самая мелкая ячейка не мельче ~8 px. */
function pickGridLevel() {
  if (!bundle) return null;
  const pxPerDeg = (256 * Math.pow(2, map.getZoom())) / 360;
  let best = null;
  for (const g of bundle.grids) {
    const px = pxPerDeg * g.cell;
    if (px >= 2.6) best = g; // запоминаем самую мелкую подходящую (×2 крупнее)
  }
  return best ?? bundle.grids[0]; // при сильном отдалении — самый грубый уровень
}

/** Проход по сетке: цветные ячейки на отдельной канве (тот же размер, что тепловая). */
let gridLayerCanvas = null;
function drawGridLayer() {
  const grid = pickGridLevel();
  if (!grid) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const dark = theme === 'dark';
  const enabledMask = SPORTS.reduce((m, s) => m + (sportsOn.has(s.key) ? SPORT_BIT[s.key] : 0), 0);
  if (enabledMask === 0) return null;

  if (!gridLayerCanvas) gridLayerCanvas = document.createElement('canvas');
  const gc = gridLayerCanvas;
  const bw = heatCanvas.width;
  const bh = heatCanvas.height;
  if (gc.width !== bw || gc.height !== bh) {
    gc.width = bw;
    gc.height = bh;
  }
  const gctx = gc.getContext('2d');
  gctx.clearRect(0, 0, bw, bh);

  const cell = grid.cell;
  const bounds = map.getBounds();
  const pad = cell;
  const laMin = Math.floor((bounds.getSouth() - pad) / cell);
  const laMax = Math.ceil((bounds.getNorth() + pad) / cell);
  const loMin = Math.floor((bounds.getWest() - pad) / cell);
  const loMax = Math.ceil((bounds.getEast() + pad) / cell);

  const cells = grid.cells;
  for (let i = 0; i < cells.length; i += 3) {
    const la = cells[i];
    const lo = cells[i + 1];
    const flags = cells[i + 2];
    if ((flags & enabledMask) === 0) continue;
    if (la < laMin || la > laMax || lo < loMin || lo > loMax) continue;
    const t = BUCKET_T[(flags >> 4) & 3];
    const [r, g, b] = LUT[Math.round(t * 255)];
    const a = Math.min(1, (dark ? 0.35 : 0.3) + t * 0.55);
    const nw = map.latLngToContainerPoint([la * cell, lo * cell]);
    const se = map.latLngToContainerPoint([(la + 1) * cell, (lo + 1) * cell]);
    gctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    gctx.fillRect(
      Math.round((nw.x + MARGIN) * dpr),
      Math.round((nw.y + MARGIN) * dpr),
      Math.round((se.x - nw.x) * dpr) + 1,
      Math.round((se.y - nw.y) * dpr) + 1,
    );
  }
  return { canvas: gc, blurPx: gridBlurPx(grid, dpr) };
}

function gridBlurPx(grid, dpr) {
  const pxPerDeg = (256 * Math.pow(2, map.getZoom())) / 360;
  const px = pxPerDeg * grid.cell * dpr;
  return Math.max(1.5, Math.min(14, px * 0.7));
}

function redrawHeat() {
  if (!map || !heatCanvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const size = map.getSize();
  const w = size.x;
  const h = size.y;
  if (w === 0 || h === 0) return;

  // 1) вернуть канву в позицию вьюпорта (снимает масштаб зум-анимации)
  L.DomUtil.setPosition(heatCanvas, map.containerPointToLayerPoint([-MARGIN, -MARGIN]));
  const cw = w + MARGIN * 2;
  const ch = h + MARGIN * 2;
  const bw = Math.round(cw * dpr);
  const bh = Math.round(ch * dpr);
  if (heatCanvas.width !== bw || heatCanvas.height !== bh) {
    heatCanvas.width = bw;
    heatCanvas.height = bh;
    heatCanvas.style.width = `${cw}px`;
    heatCanvas.style.height = `${ch}px`;
  }
  const ctx = heatCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, heatCanvas.width, heatCanvas.height);
  const dark = theme === 'dark';

  // 2а) сетка бандла (без GPS-точек): цветные ячейки + размытие
  const gridLayer = bundleActive ? drawGridLayer() : null;
  if (gridLayer) {
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.filter = `blur(${gridLayer.blurPx}px)`;
    ctx.drawImage(gridLayer.canvas, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  // 2б) пользовательские треки — точный конвейер (как в оригинале)
  const userVisible = activeTracks();
  let drewPoints = false;
  if (userVisible.length > 0) {
    const CELL = 8;
    const gw = Math.ceil(cw / CELL) + 1;
    const gh = Math.ceil(ch / CELL) + 1;
    binCanvas.width = gw;
    binCanvas.height = gh;
    const bctx = binCanvas.getContext('2d');
    if (!bctx) return;
    const gridArr = new Float32Array(gw * gh);

    const zoom = map.getZoom();
    const pxPerDeg = (256 * Math.pow(2, zoom)) / 360;
    const padLon = MARGIN / pxPerDeg + 1;
    const bounds = map.getBounds();
    const west = bounds.getWest() - padLon;
    const east = bounds.getEast() + padLon;

    let maxCell = 0;
    for (const track of userVisible) {
      if (!sportsOn.has(track.sport)) continue;
      for (const flat of track.parts) {
        for (let i = 0; i < flat.length; i += 2) {
          const lat = flat[i];
          const lon = flat[i + 1];
          let hit = false;
          for (const shift of SHIFTS) {
            const l = lon + shift;
            if (l >= west && l <= east) {
              hit = true;
              break;
            }
          }
          if (!hit) continue;
          const p = map.latLngToContainerPoint([lat, lon]);
          const gx = Math.floor((p.x + MARGIN) / CELL);
          const gy = Math.floor((p.y + MARGIN) / CELL);
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const idx = gy * gw + gx;
          gridArr[idx] += 1;
          if (gridArr[idx] > maxCell) maxCell = gridArr[idx];
        }
      }
    }
    if (maxCell > 0) {
      const img = bctx.createImageData(gw, gh);
      const data = img.data;
      const logMax = Math.log(1 + maxCell);
      const gamma = dark ? 0.62 : 0.8;
      const aFloor = dark ? 0.4 : 0.3;
      for (let i = 0; i < gridArr.length; i++) {
        const v = gridArr[i];
        if (v === 0) continue;
        const t = Math.pow(Math.log(1 + v) / logMax, gamma);
        const li = Math.min(255, Math.max(0, Math.round(t * 255)));
        const [r, g, b] = LUT[li];
        const o = i * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = Math.round(255 * Math.min(1, aFloor + t * 0.8));
      }
      bctx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      ctx.filter = `blur(${Math.round(CELL / 2.5)}px)`;
      ctx.drawImage(binCanvas, 0, 0, gw, gh, 0, 0, gw * CELL * dpr, gh * CELL * dpr);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      drewPoints = true;
    }
  }
}

// ---------- полная геометрия (лениво, только при промахе компактного PIP) ----------
function ensureFullCountries() {
  if (fullCountriesIdx) return Promise.resolve();
  if (!fullCountriesPromise) {
    fullCountriesPromise = fetch('geo/full/countries-50m.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((fc) => {
        fullCountriesFC = fc;
        fullCountriesIdx = createPipIndex(fc.features, (p) => p.iso);
      })
      .catch(() => {
        fullCountriesPromise = null; // сеть подвела — остаёмся на компактном наборе
      });
  }
  return fullCountriesPromise;
}

function ensureFullRegions() {
  if (fullRegionsIdx) return Promise.resolve();
  if (!fullRegionsPromise) {
    fullRegionsPromise = fetch('geo/full/russia-regions.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((fc) => {
        fullRegionsIdx = createPipIndex(fc.features, (p) => p.code);
      })
      .catch(() => {
        fullRegionsPromise = null;
      });
  }
  return fullRegionsPromise;
}

/** Контур страны для отрисовки: из компактного набора, при необходимости из полного. */
function countryFeature(iso) {
  let f = countriesFeatures.get(iso);
  if (!f && fullCountriesFC) {
    f = fullCountriesFC.features.find((x) => x.properties.iso === iso) ?? null;
    if (f) countriesFeatures.set(iso, f);
  }
  return f;
}

/**
 * Гео-теги пользовательского трека (страны/регионы, дедуп «раз на трек»).
 * Фаза 1 — компактные индексы; фаза 2 — при промахе полная геометрия и перегон.
 */
async function computeUserTags(parts) {
  const c = new Set();
  const r = new Set();
  let missC = false;
  let missR = false;

  const resolveC = cellResolver((lat, lon) => countriesIdx.at(lat, lon));
  const resolveR = cellResolver((lat, lon) => regionsIdx.at(lat, lon));
  for (const part of parts) {
    for (const [lat, lon] of part) {
      const ck = resolveC(lat, lon);
      if (ck) {
        c.add(ck);
        if (ck === RU_ISO) {
          const rk = resolveR(lat, lon);
          if (rk) r.add(rk);
          else missR = true; // регион вне посещённых (например, Тыва)
        }
      } else {
        missC = true; // страна вне посещённых (или океан)
      }
    }
  }

  if (missC || missR) {
    if (missC) await ensureFullCountries();
    if (missR) await ensureFullRegions();
    const idxC = fullCountriesIdx ?? countriesIdx;
    const idxR = fullRegionsIdx ?? regionsIdx;
    const fc2 = cellResolver((lat, lon) => idxC.at(lat, lon));
    const fr2 = cellResolver((lat, lon) => idxR.at(lat, lon));
    c.clear();
    r.clear();
    for (const part of parts) {
      for (const [lat, lon] of part) {
        const ck = fc2(lat, lon);
        if (!ck) continue;
        if (ck === RU_ISO) {
          const rk = fr2(lat, lon);
          if (rk) r.add(rk);
        } else {
          c.add(ck);
        }
      }
    }
  }
  return { c, r };
}

// ---------- статистика / слои ----------
function recompute() {
  // стата бандла: статические тоталы по включённым видам спорта (сетка не хранит треки)
  let n = 0;
  let km = 0;
  if (bundle && bundleActive) {
    for (const s of SPORTS) {
      if (!sportsOn.has(s.key)) continue;
      n += bundle.totals.bySport[s.key].tracks;
      km += bundle.totals.bySport[s.key].km;
    }
  }
  // пользовательские треки — точные
  const vc = new Map();
  const vr = new Map();
  let un = 0;
  let ukm = 0;
  for (const t of userTracks) {
    if (!sportsOn.has(t.sport)) continue;
    un++;
    ukm += t.distanceKm;
    for (const iso of t.tags.c) {
      if (iso === RU_ISO) continue;
      vc.set(iso, (vc.get(iso) ?? 0) + 1);
    }
    for (const code of t.tags.r) vr.set(code, (vr.get(code) ?? 0) + 1);
  }
  n += un;
  km += ukm;

  // посещённые страны/регионы бандла: маска спорта пересекается с включёнными
  const enabledMask = SPORTS.reduce((m, s) => m + (sportsOn.has(s.key) ? SPORT_BIT[s.key] : 0), 0);
  if (bundle && bundleActive) {
    for (const [iso, [count, mask]] of Object.entries(bundle.countries)) {
      if (iso === RU_ISO || (mask & enabledMask) === 0) continue;
      vc.set(iso, count);
    }
    for (const [code, [count, mask]] of Object.entries(bundle.regions)) {
      if ((mask & enabledMask) === 0) continue;
      vr.set(code, count);
    }
  }
  visitedCountries = vc;
  visitedRegions = vr;

  el.stTracks.textContent = n;
  el.stKm.textContent = Math.round(km).toLocaleString('ru-RU');
  el.stCountries.textContent = vc.size;
  el.stRegions.textContent = vr.size;

  renderCountries();
  renderRegions();
  redrawHeat();
}

function addShiftedPolys(layer, feature, label, style) {
  const polys =
    feature.geometry.type === 'MultiPolygon'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
  for (const rings of polys) {
    for (const shift of SHIFTS) {
      const latlngs = rings.map((ring) => ring.map(([lon, lat]) => [lat, lon + shift]));
      L.polygon(latlngs, { ...style, interactive: true })
        .bindTooltip(label, { sticky: true })
        .addTo(layer);
    }
  }
}

function renderCountries() {
  if (!countriesLayer) return;
  countriesLayer.clearLayers();
  if (!showCountries) return;
  const style = {
    color: '#7C3AED',
    weight: 1,
    opacity: 0.9,
    fillColor: '#A78BFA',
    fillOpacity: 0.25,
  };
  for (const [iso, n] of visitedCountries) {
    const f = countryFeature(iso);
    if (!f) continue;
    addShiftedPolys(countriesLayer, f, `${f.properties.name ?? iso} · ${tracksPlural(n)}`, style);
  }
}

function renderRegions() {
  if (!regionsLayer) return;
  regionsLayer.clearLayers();
  if (!showRegions) return;
  const style = {
    color: '#2563EB',
    weight: 1,
    opacity: 0.9,
    fillColor: '#93C5FD',
    fillOpacity: 0.3,
  };
  for (const [code, n] of visitedRegions) {
    const f = regionsFeatures.get(code);
    if (!f) continue;
    addShiftedPolys(regionsLayer, f, `${f.properties.ru ?? code} · ${tracksPlural(n)}`, style);
  }
}

// ---------- данные ----------
async function loadData() {
  setStatus('Загружаю данные...');
  try {
    const [bundleRes, cRes, rRes] = await Promise.all([
      fetch('data/tracks-bundle.json'),
      fetch('geo/countries-visited.json'),
      fetch('geo/russia-regions-visited.json'),
    ]);
    if (!bundleRes.ok) throw new Error(String(bundleRes.status));
    const b = await bundleRes.json();
    if (b.version !== 2) throw new Error('unsupported bundle version');
    // раскодировка дельт (ячейки отсортированы по la, lo)
    const unzigzag = (v) => v % 2 === 0 ? v / 2 : -(v + 1) / 2;
    for (const g of b.grids) {
      let la = 0, lo = 0;
      const c = g.cells;
      for (let i = 0; i < c.length; i += 3) {
        la += c[i];
        lo += unzigzag(c[i + 1]);
        c[i] = la;
        c[i + 1] = lo;
      }
    }
    bundle = b;
    const cFC = cRes.ok ? await cRes.json() : { features: [] };
    const rFC = rRes.ok ? await rRes.json() : { features: [] };

    // компактные PIP-индексы — только для классификации пользовательских треков
    countriesIdx = createPipIndex(cFC.features, (p) => p.iso);
    regionsIdx = createPipIndex(rFC.features, (p) => p.code);
    for (const f of cFC.features) {
      if (f.properties.iso !== RU_ISO) countriesFeatures.set(f.properties.iso, f);
    }
    for (const f of rFC.features) regionsFeatures.set(f.properties.code, f);

    setStatus(null);
    recountChips();
    recompute();
  } catch {
    setStatus('Данные не найдены — загрузите GPX/FIT вручную ниже.');
  }
}

// ---------- импорт файлов ----------
async function onFiles(files) {
  if (!files || files.length === 0) return;
  setUploading(true);
  setMsg(null);
  let added = 0;
  let failed = 0;
  for (const file of Array.from(files)) {
    try {
      const name = file.name.toLowerCase();
      let raw = [];
      let sport = 'other';
      if (name.endsWith('.gpx')) {
        const text = await file.text();
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        for (const p of doc.getElementsByTagName('trkpt')) {
          const lat = parseFloat(p.getAttribute('lat'));
          const lon = parseFloat(p.getAttribute('lon'));
          if (Number.isFinite(lat) && Number.isFinite(lon)) raw.push([lat, lon]);
        }
        // вид спорта из <trk><type> (Garmin: running/cycling/hiking…), если заполнен
        const typeEl = doc.querySelector('trk > type');
        if (typeEl) sport = normalizeSport(typeEl.textContent);
      } else if (name.endsWith('.fit.gz') || name.endsWith('.fit')) {
        let buf = await file.arrayBuffer();
        if (name.endsWith('.gz')) {
          buf = await new Response(
            new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).arrayBuffer();
        }
        const mod = await import('./vendor/fit-parser.js'); // лениво: только при FIT
        const parser = new mod.default({ force: true, mode: 'list' });
        await new Promise((resolve, reject) => {
          parser.parse(buf, (err, data) => {
            if (err) return reject(err);
            for (const rec of data.records ?? []) {
              if (typeof rec.position_lat === 'number' && typeof rec.position_long === 'number') {
                raw.push([rec.position_lat, rec.position_long]);
              }
            }
            sport = normalizeSport(data.sessions?.[0]?.sport ?? data.sports?.[0]?.sport);
            resolve();
          });
        });
      }
      if (raw.length >= 2) {
        const t = sanitizeTrack(raw);
        if (t.parts.length > 0) {
          userTracks.push({
            parts: t.parts.map((part) => {
              const flat = [];
              for (const [la, lo] of part) flat.push(la, lo);
              return flat;
            }),
            distanceKm: t.distanceKm,
            sport,
            tags: await computeUserTags(t.parts),
          });
          added++;
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  setMsg(
    added || failed
      ? `Добавлено треков: ${added}${failed ? `, пропущено: ${failed}` : ''}`
      : 'Треки не найдены',
  );
  recountChips();
  setUploading(false);
  recompute();
}

function resetTracks() {
  if (bundleActive) {
    bundleActive = false;
    userTracks = [];
    el.resetLabel.textContent = 'Вернуть мои треки';
    setMsg(`Карта пуста — загрузите GPX/FIT или верните исходную карту`);
  } else {
    bundleActive = true;
    el.resetLabel.textContent = 'Сбросить треки';
    setMsg(null);
  }
  recountChips();
  recompute();
}

// ---------- UI ----------
function setStatus(text) {
  if (text) {
    el.status.textContent = text;
    el.status.hidden = false;
  } else {
    el.status.hidden = true;
  }
}

function setMsg(text) {
  if (text) {
    el.msg.textContent = text;
    el.msg.hidden = false;
  } else {
    el.msg.hidden = true;
  }
}

function setUploading(b) {
  el.file.disabled = b;
  el.uploadText.textContent = b ? 'Обрабатываю...' : 'Загрузить GPX / FIT';
}

function recountChips() {
  sportCounts = { run: 0, hike: 0, ride: 0, other: 0 };
  if (bundle && bundleActive) {
    for (const s of SPORTS) sportCounts[s.key] = bundle.totals.bySport[s.key].tracks;
  }
  for (const t of userTracks) sportCounts[t.sport]++;
  updateChips();
}

function updateChips() {
  for (const chip of el.chips) {
    const key = chip.dataset.sport;
    chip.setAttribute('aria-pressed', sportsOn.has(key) ? 'true' : 'false');
    chip.querySelector('i').textContent = sportCounts[key];
  }
}

function bindUI() {
  for (const chip of el.chips) {
    chip.addEventListener('click', () => {
      const key = chip.dataset.sport;
      if (sportsOn.has(key)) sportsOn.delete(key);
      else sportsOn.add(key);
      updateChips();
      recompute();
    });
  }
  el.togCountries.addEventListener('change', () => {
    showCountries = el.togCountries.checked;
    renderCountries();
  });
  el.togRegions.addEventListener('change', () => {
    showRegions = el.togRegions.checked;
    renderRegions();
  });
  el.togDark.addEventListener('change', () => {
    theme = el.togDark.checked ? 'dark' : 'light';
    if (tileLayer) tileLayer.setUrl(TILE_URLS[theme]);
    redrawHeat(); // яркость/композит хитмапы зависят от базы
  });
  el.file.addEventListener('change', () => {
    void onFiles(el.file.files);
    el.file.value = ''; // тот же файл можно выбрать повторно
  });
  el.reset.addEventListener('click', resetTracks);
}

// ---------- инициализация ----------
function initMap() {
  map = L.map('map', {
    center: [55, 37],
    zoom: 3,
    minZoom: 2,
    maxZoom: MAX_ZOOM,
    worldCopyJump: false,
    preferCanvas: true,
  });
  tileLayer = L.tileLayer(TILE_URLS[theme], {
    attribution: TILE_ATTR,
    maxZoom: MAX_ZOOM,
  }).addTo(map);

  // пейн под тепловой канвас: между тайлами (200) и векторами (400+)
  map.createPane('heatPane');
  const pane = map.getPane('heatPane');
  pane.style.zIndex = '450';
  pane.style.pointerEvents = 'none';
  heatCanvas = document.createElement('canvas');
  heatCanvas.style.position = 'absolute';
  heatCanvas.style.left = '0';
  heatCanvas.style.top = '0';
  heatCanvas.classList.add('leaflet-zoom-animated'); // плавное следование за зум-анимацией
  heatCanvas.style.transformOrigin = '0 0';
  pane.appendChild(heatCanvas);
  binCanvas = document.createElement('canvas');

  countriesLayer = L.layerGroup().addTo(map);
  regionsLayer = L.layerGroup().addTo(map);

  const scheduleRedraw = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      redrawHeat();
    });
  };
  // канва едет вместе с картой, сетка перестраивается по завершении движения
  map.on('moveend zoomend viewreset resize', scheduleRedraw);
  // во время зум-анимации канва следует за картой масштабированием (как у L.Renderer)
  map.on('zoomanim', (e) => {
    if (!heatCanvas) return;
    const scale = map.getZoomScale(e.zoom);
    const nw = map.getBounds().getNorthWest();
    const t = map._latLngToNewLayerPoint(nw, e.zoom, e.center);
    L.DomUtil.setTransform(heatCanvas, L.point(t.x - MARGIN * scale, t.y - MARGIN * scale), scale);
  });
  scheduleRedraw();
}

function init() {
  el.status = $('status');
  el.msg = $('msg');
  el.stTracks = $('st-tracks');
  el.stKm = $('st-km');
  el.stCountries = $('st-countries');
  el.stRegions = $('st-regions');
  el.chips = [...document.querySelectorAll('#sports .chip')];
  el.togCountries = $('tog-countries');
  el.togRegions = $('tog-regions');
  el.togDark = $('tog-dark');
  el.file = $('file');
  el.uploadText = $('upload-text');
  el.reset = $('reset');
  el.resetLabel = $('reset-label');

  initMap();
  bindUI();
  updateChips();
  void loadData();
}

init();
