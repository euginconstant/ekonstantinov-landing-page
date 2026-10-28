#!/usr/bin/env node
// Полный пайплайн: FIT-файлы Garmin → парсинг → санитизация → децимация → сетка v2.
//
// Отличие от build-data.mjs: вход — оригинальные FIT (полная плотность ~1 сек),
// а не готовый бандл с децимацией 110 м. Пирамида уровней — равномерная ×2,
// «каждому зуму своя сетка». Приватность: в бандл не попадает ни точки, ни порядка.
//
// Запуск: node tools/heatmap/build-from-fit.mjs <dir-with-parts> [...]
//   каждый аргумент — каталог (обход рекурсивный), ищутся *.fit

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import FitParser from './vendor-fit-parser.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(REPO, 'heatmap');
const GEO_SRC = '/tmp/travel-heatmap/public/geo'; // countries-50m.json, russia-regions.json
const RU_ISO = 'RU';

// входная децимация точек (для сетки достаточно 30 м; меньше — только вес парсинга)
const DECIM_M = 30;
const SPIKE_M = 400;
const CUT_M = 1000;
const EARTH_R = 6371000;

// пирамида ×2 от 1°; видимость на z11 (px >= 1.3) фильтруется как в клиенте
const MAX_ZOOM = 11;
const MIN_PX = 2.6; // ×2 крупнее: уровень выбирается с ячейкой от 2.6px
const GRID_LEVELS = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625, 0.001953125, 0.0009765625];
const VISIBLE = GRID_LEVELS.filter((c) => (256 * Math.pow(2, MAX_ZOOM) / 360) * c >= MIN_PX);
const SPORTS = ['run', 'hike', 'ride', 'other'];
const sportBit = Object.fromEntries(SPORTS.map((s, i) => [s, 1 << i]));

// ---------- геодезия / санитизация (порт lib/heatmap/sanitize.ts) ----------
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
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}
function sanitizeTrack(raw) {
  const pts = [];
  for (const p of raw) if (validPoint(p)) pts.push(p);
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
  const parts = [];
  let part = [];
  for (const cur of kept) {
    if (part.length === 0) { part.push(cur); continue; }
    if (haversineM(part[part.length - 1], cur) > CUT_M) {
      if (part.length >= 2) parts.push(part);
      part = [];
    }
    part.push(cur);
  }
  if (part.length >= 2) parts.push(part);
  let km = 0;
  for (const p of parts) for (let i = 1; i < p.length; i++) km += haversineM(p[i - 1], p[i]);
  return { parts, distanceKm: Math.round((km / 1000) * 100) / 100 };
}
function decimate(parts, decimM) {
  const out = [];
  for (const part of parts) {
    const flat = [];
    let last = null;
    for (const p of part) {
      if (!last || haversineM(last, p) >= decimM) {
        flat.push(p[0], p[1]);
        last = p;
      }
    }
    const lastPt = part[part.length - 1];
    if (lastPt && (flat.length < 2 || flat[flat.length - 2] !== lastPt[0] || flat[flat.length - 1] !== lastPt[1])) {
      flat.push(lastPt[0], lastPt[1]);
    }
    if (flat.length >= 4) out.push(flat);
  }
  return out;
}
function normalizeSport(raw) {
  const s = (raw ?? '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('run') || s === 'treadmill') return 'run';
  if (s.includes('walk') || s.includes('hik')) return 'hike';
  if (s.includes('cycl') || s.includes('bik')) return 'ride';
  return 'other';
}

// ---------- FIT ----------
async function parseFitFile(path) {
  const buf = await readFile(path);
  const parser = new FitParser({ force: true, mode: 'list' });
  return new Promise((res) => {
    parser.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), (err, data) => {
      if (err) return res(null);
      const raw = [];
      for (const r of data.records ?? []) {
        if (typeof r.position_lat === 'number' && typeof r.position_long === 'number') {
          const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : null;
          raw.push([r.position_lat, r.position_long, ts]);
        }
      }
      const sport = normalizeSport(data.sessions?.[0]?.sport ?? data.sports?.[0]?.sport);
      // время СТАРА активности (не activity.timestamp — это время создания файла)
      const ts = data.sessions?.[0]?.start_time ?? data.records?.[0]?.timestamp ?? data.activity?.timestamp;
      res(raw.length >= 2 ? { raw, sport, start: data.sessions?.[0]?.start_time ?? data.records?.[0]?.timestamp } : null);
    });
  });
}

async function* walkFit(dirs) {
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* walkFit([p]);
      else if (e.name.toLowerCase().endsWith('.fit')) yield p;
    }
  }
}

// ---------- PIP (как в build-data.mjs) ----------
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
  for (const f of features) {
    const key = keyOf(f.properties);
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
        let hole = false;
        for (let h = 1; h < p.rings.length; h++) if (inRing(lat, lon, p.rings[h])) hole = true;
        if (!hole) return p.key;
      }
      return null;
    },
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

// ---------- main ----------
// фильтр удалённых И обрезанных: LIVE_ACTIVITIES_DIR — каталог с
// summarizedActivities.json (Garmin GDPR DI-Connect-Fitness).
// Экспорт Uploaded-Files содержит оригиналы FIT до кропа; summary живой
// активности задаёт текущее окно (begin..begin+elapsed) и bbox.
// Точки вне окна/bbox — следы кропа, выбрасываются; файл без живой summary —
// удалён из системы, пропускается целиком.
const liveActs = [];
const LIVE_DIR = process.env.LIVE_ACTIVITIES_DIR;
if (LIVE_DIR) {
  for (const f of await readdir(LIVE_DIR)) {
    if (!f.includes('summarizedActivities')) continue;
    const j = JSON.parse(await readFile(join(LIVE_DIR, f)));
    for (const ch of Array.isArray(j) ? j : [j]) {
      for (const a of ch.summarizedActivitiesExport ?? []) {
        if (typeof a.beginTimestamp === 'number') liveActs.push(a);
      }
    }
  }
  liveActs.sort((a, b) => a.beginTimestamp - b.beginTimestamp);
  console.log('живых активностей в системе:', liveActs.length);
}

const DAY = 86400000;
function matchLive(sessionStart) {
  if (!LIVE_DIR || !sessionStart) return null;
  if (sessionStart instanceof Date) sessionStart = sessionStart.getTime();
  if (typeof sessionStart !== 'number') return null;
  // ближайшая по времени старта живая активность (кропы/часы сдвигают время)
  let lo = 0, hi = liveActs.length - 1, best = null, bestD = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = Math.abs(liveActs[mid].beginTimestamp - sessionStart);
    if (d < bestD) { bestD = d; best = liveActs[mid]; }
    if (liveActs[mid].beginTimestamp < sessionStart) lo = mid + 1; else hi = mid - 1;
  }
  return bestD <= 3 * DAY ? best : null;
}

const t0 = Date.now();
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('использование: node build-from-fit.mjs <dir> [<dir>...]');
  process.exit(1);
}

console.log('парсинг FIT...');
const tracks = [];
let parsed = 0, failed = 0, deleted = 0, cropped = 0, scanned = 0;
for await (const path of walkFit(dirs)) {
  scanned++;
  const r = await parseFitFile(path);
  if (!r) { failed++; continue; }
  const act = matchLive(r.start);
  if (!act) { deleted++; continue; } // нет живой активности — файл удалён из системы
  // клиппинг кропа: окно времени + bbox живой summary
  const wEnd = act.beginTimestamp + (act.elapsedDuration ?? act.duration ?? Infinity) + 5000;
  const clipped = r.raw.filter(([lat, lon, ts]) => {
    if (ts !== null && (ts < act.beginTimestamp - 5000 || ts > wEnd)) return false;
    if (typeof act.minLatitude === 'number' && (lat < act.minLatitude - 0.001 || lat > act.maxLatitude + 0.001)) return false;
    if (typeof act.minLongitude === 'number' && (lon < act.minLongitude - 0.001 || lon > act.maxLongitude + 0.001)) return false;
    return true;
  });
  if (clipped.length !== r.raw.length) cropped++;
  if (clipped.length < 2) { deleted++; continue; }
  const t = sanitizeTrack(clipped.map(([lat, lon]) => [lat, lon]));
  if (t.parts.length === 0) { failed++; continue; }
  tracks.push({
    parts: decimate(t.parts, DECIM_M),
    distanceKm: t.distanceKm,
    sport: r.sport,
  });
  parsed++;
  if (parsed % 5000 === 0) {
    console.log(`  ${parsed} треков (${scanned} файлов, ${((Date.now() - t0) / 1000).toFixed(0)} с)`);
  }
}
console.log(`файлов: ${scanned}, треков: ${parsed}, удалено: ${deleted}, в ${cropped} файлах срезаны точки кропа, пропущено: ${failed}, время: ${((Date.now() - t0) / 1000).toFixed(0)} с`);
if (process.env.DUMP_TRACKS) {
  await writeFile(process.env.DUMP_TRACKS, JSON.stringify(tracks));
  console.log('дамп треков: ' + process.env.DUMP_TRACKS);
}

// статы
const bySport = Object.fromEntries(SPORTS.map((s) => [s, { tracks: 0, km: 0 }]));
let totalKm = 0;
for (const t of tracks) {
  bySport[t.sport].tracks++;
  bySport[t.sport].km += t.distanceKm;
  totalKm += t.distanceKm;
}
for (const s of SPORTS) bySport[s].km = Math.round(bySport[s].km);
totalKm = Math.round(totalKm);

// сетки ×2 с растеризацией сегментов
const grids = VISIBLE.map((cell) => {
  const acc = new Map();
  const mark = (la, lo, bit, ti) => {
    const k = la + ';' + lo;
    let e = acc.get(k);
    if (!e) acc.set(k, (e = { la, lo, mask: 0, tracks: new Set() }));
    e.mask |= bit;
    e.tracks.add(ti);
  };
  for (let ti = 0; ti < tracks.length; ti++) {
    const t = tracks[ti];
    const bit = sportBit[t.sport];
    for (const part of t.parts) {
      let prev = null;
      for (let i = 0; i < part.length; i += 2) {
        const la = Math.floor(part[i] / cell);
        const lo = Math.floor(part[i + 1] / cell);
        mark(la, lo, bit, ti);
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
  // сглаживание поля счётчиков ядром 3x3: убирает 'пятна' на границах порогов
  const smooth = new Map();
  for (const e of acc.values()) {
    let sum = 0, w = 0;
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const n = acc.get((e.la + da) + ';' + (e.lo + db))?.tracks.size ?? 0;
        sum += n;
        w++;
      }
    }
    smooth.set(e.la + ';' + e.lo, sum / w);
  }
  const zigzag = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
  const flat = [];
  let prevLa = 0, prevLo = 0;
  for (const e of [...acc.values()].sort((a, b) => a.la - b.la || a.lo - b.lo)) {
    const n = smooth.get(e.la + ';' + e.lo);
    const bucket = n >= 16 ? 2 : n >= 4 ? 1 : 0;
    flat.push(e.la - prevLa, zigzag(e.lo - prevLo), e.mask | (bucket << 4));
    prevLa = e.la;
    prevLo = e.lo;
  }
  return { cell, cells: flat };
});

// страны/регионы
const countriesFC = JSON.parse(await readFile(join(GEO_SRC, 'countries-50m.json'), 'utf8'));
const regionsFC = JSON.parse(await readFile(join(GEO_SRC, 'russia-regions.json'), 'utf8'));
const cIdx = createPipIndex(countriesFC.features, (p) => p.iso);
const rIdx = createPipIndex(regionsFC.features, (p) => p.code);
const cAt = cellResolver((lat, lon) => cIdx.at(lat, lon));
const rAt = cellResolver((lat, lon) => rIdx.at(lat, lon));
const visitedCountries = new Map();
const visitedRegions = new Map();
for (const t of tracks) {
  const bit = sportBit[t.sport];
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

// 'острова и куски на других континентах не подсвечиваются': из MultiPolygon
// остаются только части, внутри которых (с допуском ~200 м на растеризацию)
// есть точка хотя бы одного трека, посетившего этот регион/страну
function keepVisitedParts(feature, trackObjs) {
  if (!trackObjs || trackObjs.size === 0) return feature;
  const polys = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [feature.geometry.coordinates];
  const kept = [];
  for (const rings of polys) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of rings[0]) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const pad = 0.002; // ~200 м: ячейки растеризации у берега
    let visited = false;
    outer: for (const t of trackObjs) {
      for (const part of t.parts) {
        for (let i = 0; i < part.length; i += 2) {
          const lat = part[i], lon = part[i + 1];
          if (lat >= minLat - pad && lat <= maxLat + pad && lon >= minLon - pad && lon <= maxLon + pad) {
            if (inRing(lat, lon, rings[0])) { visited = true; break outer; }
          }
        }
      }
    }
    if (visited) kept.push(rings);
  }
  if (kept.length === 0) kept.push(polys[0]); // защита: не теряем фичу целиком
  return {
    ...feature,
    geometry: kept.length === polys.length
      ? feature.geometry
      : (kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept }),
  };
}

const countriesVisitedFC = {
  type: 'FeatureCollection',
  features: countriesFC.features
    .filter((f) => visitedCountries.has(f.properties.iso) || f.properties.iso === RU_ISO)
    .map((f) => (visitedCountries.has(f.properties.iso) && f.properties.iso !== RU_ISO
      ? keepVisitedParts(f, visitedCountries.get(f.properties.iso)?.tracks)
      : f)),
};
const regionsVisitedFC = {
  type: 'FeatureCollection',
  features: regionsFC.features
    .filter((f) => visitedRegions.has(f.properties.code))
    .map((f) => keepVisitedParts(f, visitedRegions.get(f.properties.code)?.tracks)),
};

const bundle = {
  version: 2,
  generated: new Date().toISOString(),
  totals: { tracks: tracks.length, km: totalKm, bySport },
  grids,
  countries: Object.fromEntries([...visitedCountries].map(([iso, e]) => [iso, [e.tracks.size, e.mask]])),
  regions: Object.fromEntries([...visitedRegions].map(([code, e]) => [code, [e.tracks.size, e.mask]])),
};
await mkdir(join(OUT, 'data'), { recursive: true });
await mkdir(join(OUT, 'geo/full'), { recursive: true });
await writeFile(join(OUT, 'data/tracks-bundle.json'), JSON.stringify(bundle));
await writeFile(join(OUT, 'geo/countries-visited.json'), JSON.stringify(countriesVisitedFC));
await writeFile(join(OUT, 'geo/russia-regions-visited.json'), JSON.stringify(regionsVisitedFC));
await rm(join(OUT, 'data/track-geo-tags.json'), { force: true });

const { gzipSync } = await import('node:zlib');
const gz = async (p) => gzipSync(await readFile(p)).length;
console.log(`сетки: ${grids.map((g) => `${g.cell}°=${g.cells.length / 3}`).join(', ')}`);
console.log(`стран: ${visitedCountries.size}, регионов РФ: ${visitedRegions.size}`);
console.log(`бандл: ${((await readFile(join(OUT, 'data/tracks-bundle.json'))).length / 1024) | 0} КБ raw / ${((await gz(join(OUT, 'data/tracks-bundle.json'))) / 1024) | 0} КБ gzip`);
console.log(`всего: ${((Date.now() - t0) / 1000).toFixed(0)} с`);
