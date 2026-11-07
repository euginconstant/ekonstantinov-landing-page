// Тесты кодека СС64 (heatmap/share-codes.js): контрольные примеры спецификации,
// каноничность, лояльность к хвостовым нулям, ошибки декодирования, round-trip
// на случайных наборах и сверка справочников с geo-файлами.
// Запуск: node tools/heatmap/test-share-codes.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ALPHABET,
  WORLD_SCHEME,
  RF_SCHEME,
  encodeCode,
  decodeCode,
  ShareCodeError,
} from '../../heatmap/share-codes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertThrows(fn, what) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof ShareCodeError, `${what}: ожидали ShareCodeError, получили ${e.constructor.name}: ${e.message}`);
    return;
  }
  throw new Error(`${what}: ошибка не выброшена`);
}

const set = (...ids) => new Set(ids);

// ── алфавит и справочники ────────────────────────────────────────────────
check('алфавит СС64 — 64 символа, без повторов', () => {
  assert(ALPHABET.length === 64, `длина ${ALPHABET.length}`);
  assert(new Set(ALPHABET).size === 64, 'есть повторы');
});

check('размеры кластеров мира: 46+54+56+35+14 = 205', () => {
  const [eu, as, af, am, oc] = WORLD_SCHEME.clusters.map((c) => c.length);
  assert(eu === 46 && as === 54 && af === 56 && am === 35 && oc === 14, `${eu}/${as}/${af}/${am}/${oc}`);
  assert(WORLD_SCHEME.clusters.flat().length === 205, 'всего не 205');
  assert(new Set(WORLD_SCHEME.clusters.flat()).size === 205, 'есть дубли id');
});

check('размеры кластеров РФ: 58+27 = 85', () => {
  const [w, e] = RF_SCHEME.clusters.map((c) => c.length);
  assert(w === 58 && e === 27, `${w}/${e}`);
  assert(new Set(RF_SCHEME.clusters.flat()).size === 85, 'всего/дубли');
});

check('максимальные длины кластеров: 8/9/10/6/3 и 10/5 символов', () => {
  const lens = WORLD_SCHEME.clusters.map((c) => Math.ceil(c.length / 6));
  assert(String(lens) === '8,9,10,6,3', `${lens}`);
  const lensRF = RF_SCHEME.clusters.map((c) => Math.ceil(c.length / 6));
  assert(String(lensRF) === '10,5', `${lensRF}`);
});

// ── контрольные примеры спецификации ─────────────────────────────────────
check('мир: пусто → "0"', () => {
  assert(encodeCode(WORLD_SCHEME, set()) === '0', encodeCode(WORLD_SCHEME, set()));
});

check('мир: Россия+Италия+Германия → "B"', () => {
  const code = encodeCode(WORLD_SCHEME, set('RU', 'IT', 'DE'));
  assert(code === 'B', code);
  assert(decodeCode(WORLD_SCHEME, 'B').size === 3, 'обратно не 3');
});

check('мир: Россия+Австралия → "1-0-0-0-1"', () => {
  const code = encodeCode(WORLD_SCHEME, set('RU', 'AU'));
  assert(code === '1-0-0-0-1', code);
});

check('мир: Россия+Турция+Тайвань → "1-100000008"', () => {
  const code = encodeCode(WORLD_SCHEME, set('RU', 'TR', 'TW'));
  assert(code === '1-100000008', code);
});

check('РФ: пусто → "0"', () => {
  assert(encodeCode(RF_SCHEME, set()) === '0', encodeCode(RF_SCHEME, set()));
});

check('РФ: Москва+Краснодарский край+Санкт-Петербург → "d"', () => {
  const code = encodeCode(RF_SCHEME, set('RU-MOS', 'RU-KDA', 'RU-SPE'));
  assert(code === 'd', code);
});

check('РФ: Москва+Приморский край → "1-1"', () => {
  const code = encodeCode(RF_SCHEME, set('RU-MOS', 'RU-PRI'));
  assert(code === '1-1', code);
});

check('РФ: Москва+Иркутская обл. → "1-02"', () => {
  const code = encodeCode(RF_SCHEME, set('RU-MOS', 'RU-IRK'));
  assert(code === '1-02', code);
});

check('РФ: Москва+Чукотский АО → "1-00004"', () => {
  const code = encodeCode(RF_SCHEME, set('RU-MOS', 'RU-CHU'));
  assert(code === '1-00004', code);
});

// ── каноничность и хвостовые нули ────────────────────────────────────────
check('повторное кодирование канонизирует ("1-0-0-0-0" → "1")', () => {
  assert(encodeCode(WORLD_SCHEME, decodeCode(WORLD_SCHEME, '1-0-0-0-0')) === '1');
  assert(encodeCode(RF_SCHEME, decodeCode(RF_SCHEME, '1-0')) === '1');
  assert(encodeCode(RF_SCHEME, decodeCode(RF_SCHEME, 'd0')) === 'd');
  assert(encodeCode(RF_SCHEME, decodeCode(RF_SCHEME, '0-0')) === '0');
});

check('регистр значим ("b" ≠ "B")', () => {
  assert(String([...decodeCode(WORLD_SCHEME, 'b')]) === 'RU,BY,ES', `${[...decodeCode(WORLD_SCHEME, 'b')]}`);
  assert(String([...decodeCode(WORLD_SCHEME, 'B')]) === 'RU,IT,DE', `${[...decodeCode(WORLD_SCHEME, 'B')]}`);
});

check('ошибка: неизвестный символ', () => {
  assertThrows(() => decodeCode(WORLD_SCHEME, 'B+'), 'B+');
  assertThrows(() => decodeCode(RF_SCHEME, '1-2?'), '1-2?');
});

check('ошибка: лишние кластеры', () => {
  assertThrows(() => decodeCode(RF_SCHEME, '1-1-1'), '3 кластера при 2');
});

check('ошибка: превышение длины кластера', () => {
  assertThrows(() => decodeCode(WORLD_SCHEME, 'B'.repeat(9)), '9 символов в Европе (макс 8)');
  assertThrows(() => decodeCode(RF_SCHEME, '1-0'.concat('000000')), '7 символов на Востоке (макс 5)');
});

check('ошибка: ненулевые резервные биты', () => {
  // Европа: 46 объектов → 8-й символ хранит 4 бита, веса 16 и 32 — резерв
  assertThrows(() => decodeCode(WORLD_SCHEME, '0000000g'), 'вес 16 в резерве');
  assertThrows(() => decodeCode(WORLD_SCHEME, '0000000h'), 'вес 32 в резерве');
  // Океания: 14 объектов → 3-й символ 5-го кластера хранит 2 бита, веса 4–32 — резерв
  assertThrows(() => decodeCode(WORLD_SCHEME, '0-0-0-0-004'), 'вес 4 в резерве Океании');
  // Африка: 56 объектов → 10-й символ 3-го кластера хранит 2 бита
  assertThrows(() => decodeCode(WORLD_SCHEME, '0-0-0000000008'), 'вес 8 в резерве Африки');
});

check('резервные нули в последнем символе допустимы', () => {
  const s = decodeCode(WORLD_SCHEME, '0000000f'); // вес 1,2,4,8 → indices 42..45
  assert(String([...s].sort()) === 'LI,VA,XK,XN', `${[...s].sort()}`);
  const a = decodeCode(WORLD_SCHEME, '0-0-0000000003'); // Западная Сахара + Сомалиленд
  assert(a.size === 2 && a.has('EH') && a.has('XS'), `${[...a]}`);
});

check('пустой сегмент и пустая строка — ошибки', () => {
  assertThrows(() => decodeCode(RF_SCHEME, '1-'), 'хвостовой дефис');
  assertThrows(() => decodeCode(RF_SCHEME, ''), 'пустая строка');
});

// ── round-trip на случайных наборах ──────────────────────────────────────
check('round-trip: 300 случайных наборов мира и РФ', () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const scheme of [WORLD_SCHEME, RF_SCHEME]) {
    for (let iter = 0; iter < 300; iter++) {
      const all = scheme.clusters.flat();
      const sel = new Set();
      for (const id of all) if (rnd() < 0.2) sel.add(id);
      const code = encodeCode(scheme, sel);
      assert(code.length <= 40 + 4, `код длиннее спецификации: ${code}`);
      const back = decodeCode(scheme, code);
      assert(back.size === sel.size && [...sel].every((id) => back.has(id)), `round-trip ${code}`);
      assert(encodeCode(scheme, back) === code, `неканонично: ${code}`);
    }
  }
});

// ── сверка справочников с geo-файлами ────────────────────────────────────
check('все id мира есть в geo/full/countries-50m.json (или это синтетические X*)', () => {
  const fc = JSON.parse(readFileSync(join(root, 'heatmap/geo/full/countries-50m.json'), 'utf8'));
  const iso = new Set(fc.features.map((f) => f.properties.iso));
  const synthetic = new Set(['XN', 'XA', 'XO', 'XC', 'XS']); // нет в Natural Earth
  const missing = WORLD_SCHEME.clusters.flat().filter((id) => !iso.has(id) && !synthetic.has(id));
  assert(missing.length === 0, `нет в geo: ${missing.join(', ')}`);
});

check('все id РФ есть в geo/full/russia-regions.json', () => {
  const fc = JSON.parse(readFileSync(join(root, 'heatmap/geo/full/russia-regions.json'), 'utf8'));
  const codes = new Set(fc.features.map((f) => f.properties.code));
  const missing = RF_SCHEME.clusters.flat().filter((id) => !codes.has(id));
  assert(missing.length === 0, `нет в geo: ${missing.join(', ')}`);
});

console.log(failures ? `\n${failures} проверок провалено` : '\nвсе проверки прошли');
process.exit(failures ? 1 : 0);
