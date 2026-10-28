#!/usr/bin/env node
// Сборка данных тепловой карты путешествий из исходного проекта (Next.js-версия).
//
// Вход (аргумент 1 — каталог public исходного проекта, по умолчанию /tmp/travel-heatmap/public):
//   data/tracks-bundle.json   — бандл треков (децимация 60 м)
//   geo/countries-50m.json    — контуры всех стран (Natural Earth 50m)
//   geo/russia-regions.json   — контуры субъектов РФ
//
// Выход (в репо лендинга):
//   heatmap/data/tracks-bundle.json       — бандл с укрупнённой децимацией (DECIM_M)
//   heatmap/data/track-geo-tags.json      — на трек: список стран/регионов (предвычисленный PIP)
//   heatmap/geo/countries-visited.json    — контуры только посещённых стран (без РФ)
//   heatmap/geo/russia-regions-visited.json — контуры только посещённых регионов
//   heatmap/geo/full/countries-50m.json   — полная геометрия (догружается при импорте своих треков)
//   heatmap/geo/full/russia-regions.json
//
// Запуск: node tools/heatmap/build-data.mjs [src-public-dir]

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(process.argv[2] ?? '/tmp/travel-heatmap/public');
const OUT = join(REPO, 'heatmap');

// Децимация: шаг между хранимыми точками. Исходный бандл собран с 60 м;
// для тепловой карты 110 м визуально неотличимо, точек ~на треть меньше.
const DECIM_M = 110;
const RU_ISO = 'RU';

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

// ---------- децимация (как в исходном scripts/build-bundle.ts, но шаг больше) ----------
function decimPart(flat) {
  const out = [];
  let last = null; // [lat, lon] последней сохранённой точки
  const lastPt = [flat[flat.length - 2], flat[flat.length - 1]];
  for (let i = 0; i < flat.length; i += 2) {
    const p = [flat[i], flat[i + 1]];
    if (!last || haversineM(last, p) >= DECIM_M) {
      const la = Math.round(p[0] * 1e4) / 1e4;
      const lo = Math.round(p[1] * 1e4) / 1e4;
      const n = out.length;
      if (n >= 2 && out[n - 2] === la && out[n - 1] === lo) { last = [la, lo]; continue; }
      out.push(la, lo);
      last = [la, lo];
    }
  }
  // последняя точка части — всегда (замыкает хвост)
  const n = out.length;
  const la = Math.round(lastPt[0] * 1e4) / 1e4;
  const lo = Math.round(lastPt[1] * 1e4) / 1e4;
  if (n < 2 || out[n - 2] !== la || out[n - 1] !== lo) out.push(la, lo);
  return out;
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
  const latlngCache = new Map();
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
  function at(lat, lon) {
    for (const p of polys) {
      const [minLon, minLat, maxLon, maxLat] = p.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      if (!inRing(lat, lon, p.rings[0])) continue;
      let inHole = false;
      for (let h = 1; h < p.rings.length; h++) if (inRing(lat, lon, p.rings[h])) inHole = true;
      if (!inHole) return p.key;
    }
    return null;
  }
  function latlngs(key) {
    if (latlngCache.has(key)) return latlngCache.get(key);
    const out = [];
    const seen = new Set();
    for (const p of polys) {
      if (p.key !== key || seen.has(p.key + '#' + p.rings[0][0])) continue;
      out.push(p.rings.map((r) => r.map(([lon, lat]) => [lat, lon])));
    }
    const res = out.length ? out : null;
    latlngCache.set(key, res);
    return res;
  }
  return { at, propertyOf: (k) => props.get(k), latlngs, keys: () => props.keys() };
}

// Кэш по ячейкам сетки: точки в одной ячейке дают одинаковый результат PIP.
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

const bundle = JSON.parse(await readFile(join(SRC, 'data/tracks-bundle.json'), 'utf8'));
const countriesFC = JSON.parse(await readFile(join(SRC, 'geo/countries-50m.json'), 'utf8'));
const regionsFC = JSON.parse(await readFile(join(SRC, 'geo/russia-regions.json'), 'utf8'));

// 1) децимация бандла
let ptsBefore = 0, ptsAfter = 0;
const tracks = bundle.tracks.map((t) => {
  const parts = t.parts.map((flat) => {
    ptsBefore += flat.length / 2;
    const out = decimPart(flat);
    ptsAfter += out.length / 2;
    return out;
  });
  return { parts, distanceKm: t.distanceKm, sport: t.sport ?? 'other' };
});
const totalKm = Math.round(tracks.reduce((s, t) => s + t.distanceKm, 0));

// 2) предвычисление geo-тегов: на трек — какие страны/регионы он касается
const cIdx = createPipIndex(countriesFC.features, (p) => p.iso);
const rIdx = createPipIndex(regionsFC.features, (p) => p.code);
const cAt = cellResolver((lat, lon) => cIdx.at(lat, lon));
const rAt = cellResolver((lat, lon) => rIdx.at(lat, lon));

const tags = tracks.map((t) => {
  const c = new Set();
  const r = new Set();
  for (const part of t.parts) {
    for (let i = 0; i < part.length; i += 2) {
      const lat = part[i], lon = part[i + 1];
      const ck = cAt(lat, lon);
      if (ck) c.add(ck);
      if (ck === RU_ISO) {
        const rk = rAt(lat, lon);
        if (rk) r.add(rk);
      }
    }
  }
  return { c: [...c], r: [...r] };
});

// 3) множества посещённых (для вырезания контуров)
const visitedCountries = new Map(); // iso -> число треков (без РФ — она «дом», подсвечиваются регионы)
const visitedRegions = new Map();
for (const t of tags) {
  for (const iso of t.c) {
    if (iso === RU_ISO) continue;
    visitedCountries.set(iso, (visitedCountries.get(iso) ?? 0) + 1);
  }
  for (const code of t.r) visitedRegions.set(code, (visitedRegions.get(code) ?? 0) + 1);
}

// РФ кладём в компактный набор не для подсветки (она исключается, как в исходном
// EXCLUDED_COUNTRIES), а чтобы PIP на клиенте классифицировал российские точки
// пользовательских треков без догрузки полной геометрии.
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

// 4) запись
await mkdir(join(OUT, 'data'), { recursive: true });
await mkdir(join(OUT, 'geo/full'), { recursive: true });

const outBundle = {
  generated: new Date().toISOString(),
  count: tracks.length,
  totalKm,
  tracks,
};
await writeFile(join(OUT, 'data/tracks-bundle.json'), JSON.stringify(outBundle));
await writeFile(
  join(OUT, 'data/track-geo-tags.json'),
  JSON.stringify({ generated: outBundle.generated, tracks: tags }),
);
await writeFile(join(OUT, 'geo/countries-visited.json'), JSON.stringify(countriesVisitedFC));
await writeFile(join(OUT, 'geo/russia-regions-visited.json'), JSON.stringify(regionsVisitedFC));
await cp(join(SRC, 'geo/countries-50m.json'), join(OUT, 'geo/full/countries-50m.json'));
await cp(join(SRC, 'geo/russia-regions.json'), join(OUT, 'geo/full/russia-regions.json'));

// 5) отчёт
const gz = async (p) => {
  const { gzipSync } = await import('node:zlib');
  return gzipSync(await readFile(p)).length;
};
const row = async (p) => {
  const raw = (await readFile(p)).length;
  return `  ${p.replace(REPO + '/', '')}: ${(raw / 1024).toFixed(0)} КБ raw / ${(await gz(join(REPO, p))).toFixed(0) / 1024 > 1024 ? ((await gz(join(REPO, p))) / 1048576).toFixed(2) + ' МБ' : ((await gz(join(REPO, p))) / 1024).toFixed(0) + ' КБ'} gzip`;
};

console.log(`треков: ${tracks.length}, км: ${totalKm}`);
console.log(`точек: ${ptsBefore} → ${ptsAfter} (−${Math.round((1 - ptsAfter / ptsBefore) * 100)}%, децимация ${DECIM_M} м)`);
console.log(`стран посещено (без РФ): ${visitedCountries.size}, регионов РФ: ${visitedRegions.size}`);
console.log('выходные файлы:');
for (const p of [
  'heatmap/data/tracks-bundle.json',
  'heatmap/data/track-geo-tags.json',
  'heatmap/geo/countries-visited.json',
  'heatmap/geo/russia-regions-visited.json',
  'heatmap/geo/full/countries-50m.json',
  'heatmap/geo/full/russia-regions.json',
]) console.log(await row(p));
console.log(`время: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
