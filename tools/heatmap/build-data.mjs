#!/usr/bin/env node
// Сборка данных тепловой карты путешествий из исходного проекта (Next.js-версия).
//
// Схема данных v2 — СЕТКА вместо треков: в бандл не попадает ни одной GPS-точки,
// только ячейки «посещено» с флагами (вид спорта, повторность ≥2 треков).
// Приватность: скачивать и анализировать траектории нечего.
//
// Вход (аргумент 1 — каталог public исходного проекта, по умолчанию /tmp/travel-heatmap/public):
//   data/tracks-bundle.json   — исходный бандл треков (точности достаточно, децимация не важна)
//   geo/countries-50m.json    — контуры всех стран (Natural Earth; 50m + микрогосударства 10m)
//   geo/russia-regions.json   — контуры субъектов РФ
//
// Выход (в репо лендинга):
//   heatmap/data/tracks-bundle.json       — сетка + статы + страны/регионы (v2)
//   heatmap/geo/countries-visited.json    — контуры посещённых стран (+ РФ для PIP-классификации)
//   heatmap/geo/russia-regions-visited.json — контуры посещённых регионов
//   heatmap/geo/full/*                    — полная геометрия (догружается при импорте своих треков)
//
// Запуск: node tools/heatmap/build-data.mjs [src-public-dir]

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(process.argv[2] ?? '/tmp/travel-heatmap/public');
const OUT = join(REPO, 'heatmap');
const RU_ISO = 'RU';

// Уровни сетки (°): подбираются под зум карты (maxZoom 12).
// от 1° (обзор мира) до 0.0005° ≈ 55×28 м (~1 px на максимальном зуме 12).
// максимум сетки = то, что реально видно на MAX_ZOOM=12 (0.0025° = 7 px);
// более мелкие уровни не рендерятся никогда — не храним их вовсе
// самый мелкий уровень ~1.8px на z13; для него ячейки рисуются блоком 3x3 (плавные линии)
const GRID_LEVELS = [1, 0.25, 0.06, 0.015, 0.006, 0.00375];
// уровни мельче этого порога рисуются блоком 2x2
const DILATE_BELOW = 0.0005;
// уровни, которые при текущем MAX_ZOOM всё равно никогда не видны, — не храним
const MAX_ZOOM = 11;
const MIN_PX = 2.6; // порог выбора уровня в клиенте (pickGridLevel)
const VISIBLE = GRID_LEVELS.filter((c) => (256 * Math.pow(2, MAX_ZOOM) / 360) * c >= MIN_PX);
const SPORTS = ['run', 'hike', 'ride', 'other']; // бит0..3

// ---------- геодезия ----------
const EARTH_R = 6371000;
function haversineM(a, b) {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- PIP (порт src/lib/heatmap/geo-pip.ts) ----------
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
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

// ---------- сборка ----------
const t0 = Date.now();

const srcBundle = JSON.parse(await readFile(join(SRC, 'data/tracks-bundle.json'), 'utf8'));
const countriesFC = JSON.parse(await readFile(join(SRC, 'geo/countries-50m.json'), 'utf8'));
const regionsFC = JSON.parse(await readFile(join(SRC, 'geo/russia-regions.json'), 'utf8'));

const sportBit = Object.fromEntries(SPORTS.map((s, i) => [s, 1 << i]));

// 1) статы по видам спорта (из исходного бандла — без изменений)
const bySport = Object.fromEntries(SPORTS.map((s) => [s, { tracks: 0, km: 0 }]));
let totalKm = 0;
for (const t of srcBundle.tracks) {
  const s = t.sport ?? 'other';
  bySport[s].tracks++;
  bySport[s].km += t.distanceKm;
  totalKm += t.distanceKm;
}
for (const s of SPORTS) bySport[s].km = Math.round(bySport[s].km);
totalKm = Math.round(totalKm);

// 2) сетки посещённых ячеек: на уровень — [latIdx, lonIdx, flags]
//    flags: бит0..3 — виды спорта, бит4 — «посещено ≥2 разными треками»
const grids = VISIBLE.map((cell) => {
  const acc = new Map(); // 'la;lo' -> { mask, tracks:Set }
  const dilate = cell < DILATE_BELOW;
  const mark = (la, lo, bit, ti) => {
    const paint = (a, b) => {
      const k = a + ';' + b;
      let e = acc.get(k);
      if (!e) acc.set(k, (e = { la: a, lo: b, mask: 0, tracks: new Set() }));
      e.mask |= bit;
      e.tracks.add(ti);
    };
    if (!dilate) return paint(la, lo);
    // блок 2x2: плавная линия без лишнего веса
    for (let da = 0; da <= 1; da++) for (let db = 0; db <= 1; db++) paint(la + da, lo + db);
  };
  for (let ti = 0; ti < srcBundle.tracks.length; ti++) {
    const t = srcBundle.tracks[ti];
    const bit = sportBit[t.sport ?? 'other'];
    for (const part of t.parts) {
      let prev = null;
      for (let i = 0; i < part.length; i += 2) {
        const la = Math.floor(part[i] / cell);
        const lo = Math.floor(part[i + 1] / cell);
        mark(la, lo, bit, ti);
        // промежуточные ячейки сегмента: маршрут становится сплошной линией
        if (prev) {
          const dla = la - prev.la;
          const dlo = lo - prev.lo;
          const steps = Math.max(Math.abs(dla), Math.abs(dlo));
          for (let s = 1; s < steps; s++) {
            mark(Math.round(prev.la + (dla * s) / steps), Math.round(prev.lo + (dlo * s) / steps), bit, ti);
          }
        }
        prev = { la, lo };
      }
    }
  }
  // дельта-кодирование: ячейки отсортированы (la, lo); dla >= 0, dlo зигзаг-знак
  const zigzag = (v) => v >= 0 ? v * 2 : -v * 2 - 1;
  const flat = [];
  let prevLa = 0, prevLo = 0;
  for (const e of [...acc.values()].sort((a, b) => a.la - b.la || a.lo - b.lo)) {
    const n = e.tracks.size;
    const bucket = n >= 16 ? 2 : n >= 4 ? 1 : 0;
    flat.push(e.la - prevLa, zigzag(e.lo - prevLo), e.mask | (bucket << 4));
    prevLa = e.la;
    prevLo = e.lo;
  }
  return { cell, cells: flat };
});
const gridCells = grids.map((g) => g.cells.length / 3);

// 3) посещённые страны/регионы: [число треков, маска видов спорта] — для
//    клиентского пересчёта при фильтрации; PIP на клиенте не нужен
const cIdx = createPipIndex(countriesFC.features, (p) => p.iso);
const rIdx = createPipIndex(regionsFC.features, (p) => p.code);
const cAt = cellResolver((lat, lon) => cIdx.at(lat, lon));
const rAt = cellResolver((lat, lon) => rIdx.at(lat, lon));
const visitedCountries = new Map(); // iso -> { tracks:Set, mask }
const visitedRegions = new Map();
for (const t of srcBundle.tracks) {
  const bit = sportBit[t.sport ?? 'other'];
  const cSeen = new Set();
  const rSeen = new Set();
  for (const part of t.parts) {
    for (let i = 0; i < part.length; i += 2) {
      const ck = cAt(part[i], part[i + 1]);
      if (!ck) continue;
      cSeen.add(ck);
      if (ck === RU_ISO) {
        const rk = rAt(part[i], part[i + 1]);
        if (rk) rSeen.add(rk);
      }
    }
  }
  for (const iso of cSeen) {
    let e = visitedCountries.get(iso);
    if (!e) visitedCountries.set(iso, (e = { tracks: new Set(), mask: 0 }));
    e.tracks.add(t);
    e.mask |= bit;
  }
  for (const code of rSeen) {
    let e = visitedRegions.get(code);
    if (!e) visitedRegions.set(code, (e = { tracks: new Set(), mask: 0 }));
    e.tracks.add(t);
    e.mask |= bit;
  }
}

// 4) контуры: посещённые страны (+ РФ в компактный набор — она нужна клиентскому
//    PIP для классификации пользовательских треков, но не подсвечивается)
const countriesVisitedFC = {
  type: 'FeatureCollection',
  features: countriesFC.features.filter(
    (f) => visitedCountries.has(f.properties.iso) || f.properties.iso === RU_ISO,
  ),
};
const regionsVisitedFC = {
  type: 'FeatureCollection',
  features: regionsFC.features.filter((f) => visitedRegions.has(f.properties.code)),
};

// 5) запись
await mkdir(join(OUT, 'data'), { recursive: true });
await mkdir(join(OUT, 'geo/full'), { recursive: true });

const outBundle = {
  version: 2,
  generated: new Date().toISOString(),
  totals: { tracks: srcBundle.tracks.length, km: totalKm, bySport },
  grids,
  countries: Object.fromEntries(
    [...visitedCountries].map(([iso, e]) => [iso, [e.tracks.size, e.mask]]),
  ),
  regions: Object.fromEntries(
    [...visitedRegions].map(([code, e]) => [code, [e.tracks.size, e.mask]]),
  ),
};
await writeFile(join(OUT, 'data/tracks-bundle.json'), JSON.stringify(outBundle));
await writeFile(join(OUT, 'geo/countries-visited.json'), JSON.stringify(countriesVisitedFC));
await writeFile(join(OUT, 'geo/russia-regions-visited.json'), JSON.stringify(regionsVisitedFC));
await cp(join(SRC, 'geo/countries-50m.json'), join(OUT, 'geo/full/countries-50m.json'));
await cp(join(SRC, 'geo/russia-regions.json'), join(OUT, 'geo/full/russia-regions.json'));
// v2 не использует устаревший файл тегов — убираем, чтобы не валялся в проде
await (async () => { try { await (await import('node:fs/promises')).rm(join(OUT, 'data/track-geo-tags.json')); } catch {} })();

// 6) отчёт
const gz = async (p) => {
  const { gzipSync } = await import('node:zlib');
  return gzipSync(await readFile(p)).length;
};
const row = async (p) => {
  const raw = (await readFile(p)).length;
  const g = await gz(join(REPO, p));
  return `  ${p.replace(REPO + '/', '')}: ${(raw / 1024).toFixed(0)} КБ raw / ${(g / 1024).toFixed(0)} КБ gzip`;
};

console.log(`треков: ${srcBundle.tracks.length}, км: ${totalKm}`);
console.log(`по видам: ${SPORTS.map((s) => `${s}=${bySport[s].tracks}`).join(', ')}`);
console.log(`стран: ${visitedCountries.size}, регионов РФ: ${visitedRegions.size}`);
console.log(`сетки: ${grids.map((g, i) => `${g.cell}°=${gridCells[i]} яч.`).join(', ')}`);
console.log('выходные файлы:');
for (const p of [
  'heatmap/data/tracks-bundle.json',
  'heatmap/geo/countries-visited.json',
  'heatmap/geo/russia-regions-visited.json',
  'heatmap/geo/full/countries-50m.json',
  'heatmap/geo/full/russia-regions.json',
]) console.log(await row(p));
console.log(`время: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
