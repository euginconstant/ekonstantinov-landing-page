// Кодек «поделиться картой»: упаковка набора посещённых стран/территорий мира
// и регионов РФ в короткую СС64-строку для URL. Схема задана спецификацией
// (docs/heatmap-share-codes.md) и неизменна в пределах версии w1 / r1.
//
// Правила:
// - алфавит СС64 (НЕ стандартный Base64), индексы 0–63;
// - один объект — один бит, шесть последовательных объектов — один символ;
// - вес объекта с индексом i внутри кластера: 1 << (i % 6), символ кластера —
//   побитовое OR весов отмеченных объектов; первый объект — младший бит
//   ПЕРВОГО символа (обычное целочисленное преобразование не подходит);
// - кластеры кодируются независимо и склеиваются через '-'; хвостовые
//   символы '0' внутри кластера срезаются, пустой кластер — '0', хвостовые
//   пустые кластеры удаляются, полностью пустой набор — '0';
// - при декодировании отсутствующие хвостовые кластеры/символы означают
//   нулевые биты, лишние хвостовые нули допускаются; неизвестные символы,
//   лишние кластеры, превышение длины кластера и ненулевые резервные биты —
//   ошибка (ShareCodeError);
// - идентификаторы стабильны и отделены от названий: мир — ISO 3166-1
//   alpha-2 из geo-данных; для сущностей без кода — пользовательский диапазон
//   XA–XZ (не пересекается с реальными ISO-кодами); регионы РФ — code из
//   geo/full/russia-regions.json (Крым = UA-43, Севастополь = UA-40).

export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~';

const VALUE_OF = new Map([...ALPHABET].map((ch, i) => [ch, i]));

// ── мир, версия 1: кластеры Европа-Азия-Африка-Америка-Океания, 205 объектов ──
// Строки внутри кластера — последовательные символы (по 6 объектов, по
// возрастанию веса); в последней неполной строке остаток — резерв (нули).
export const WORLD_SCHEME = {
  id: 'w1',
  clusters: [
    // Европа — 46
    [
      'RU', 'BY', 'IT', 'ES', 'FR', 'DE',
      'GR', 'CZ', 'FI', 'GB', 'EE', 'LV',
      'LT', 'PL', 'ME', 'AT', 'NL', 'CH',
      'HU', 'PT', 'RS', 'HR', 'BG', 'BE',
      'SE', 'NO', 'DK', 'UA', 'RO', 'SI',
      'SK', 'MT', 'IS', 'IE', 'MD', 'AL',
      'BA', 'MK', 'LU', 'MC', 'AD', 'SM',
      'VA', 'LI', 'XK', 'XN', // XN — Приднестровье (пользовательский код)
    ],
    // Азия — 54
    [
      'TR', 'AE', 'TH', 'GE', 'CN', 'AM',
      'KZ', 'VN', 'AZ', 'ID', 'IN', 'LK',
      'MV', 'CY', 'UZ', 'IL', 'JP', 'KR',
      'MY', 'SG', 'KG', 'QA', 'JO', 'NP',
      'KH', 'OM', 'SA', 'BH', 'IR', 'TJ',
      'MN', 'LA', 'PH', 'LB', 'MM', 'KW',
      'BD', 'PK', 'BT', 'BN', 'TM', 'PS',
      'IQ', 'SY', 'KP', 'TL', 'AF', 'YE',
      'XA', 'XO', 'XC', 'TW', 'HK', 'MO', // XA — Абхазия, XO — Юж. Осетия, XC — Сев. Кипр
    ],
    // Африка — 56
    [
      'EG', 'TN', 'MA', 'TZ', 'SC', 'MU',
      'ZA', 'KE', 'ET', 'NA', 'MG', 'UG',
      'ZM', 'ZW', 'BW', 'DZ', 'CV', 'SN',
      'RW', 'MZ', 'GH', 'NG', 'CM', 'CI',
      'GM', 'AO', 'MW', 'SZ', 'LS', 'DJ',
      'SD', 'MR', 'BJ', 'TG', 'GA', 'CG',
      'CD', 'KM', 'ST', 'GQ', 'SL', 'LR',
      'GN', 'GW', 'BI', 'BF', 'ML', 'NE',
      'TD', 'CF', 'LY', 'ER', 'SO', 'SS',
      'EH', 'XS', // XS — Сомалиленд (пользовательский код)
    ],
    // Америка — 35
    [
      'US', 'CU', 'DO', 'MX', 'BR', 'CA',
      'AR', 'PE', 'CL', 'VE', 'CO', 'CR',
      'PA', 'EC', 'UY', 'BO', 'JM', 'BS',
      'GT', 'PY', 'BZ', 'BB', 'AG', 'LC',
      'GD', 'TT', 'HN', 'NI', 'SV', 'DM',
      'KN', 'VC', 'GY', 'SR', 'HT',
    ],
    // Океания — 14
    [
      'AU', 'NZ', 'FJ', 'PW', 'VU', 'PG',
      'WS', 'TO', 'FM', 'MH', 'SB', 'KI',
      'TV', 'NR',
    ],
  ],
};

// ── регионы РФ, версия 1: кластеры Запад-Восток, 85 объектов ──
export const RF_SCHEME = {
  id: 'r1',
  clusters: [
    // Запад — 58
    [
      'RU-MOS', 'RU-MOW', 'RU-KDA', 'RU-SPE', 'UA-43', 'RU-NIZ',
      'RU-TA', 'RU-SAM', 'RU-STA', 'RU-BA', 'RU-LEN', 'RU-KGD',
      'RU-PER', 'RU-ROS', 'RU-YAR', 'RU-SAR', 'RU-TVE', 'RU-VOR',
      'RU-TUL', 'RU-KR', 'RU-DA', 'RU-VLA', 'RU-VLG', 'RU-PSK',
      'RU-NGR', 'RU-KLU', 'RU-RYA', 'RU-KOS', 'RU-VGG', 'RU-MUR',
      'RU-AST', 'RU-AD', 'RU-KB', 'RU-KC', 'RU-SE', 'UA-40',
      'RU-ULY', 'RU-PNZ', 'RU-UD', 'RU-CU', 'RU-ORE', 'RU-SMO',
      'RU-IVA', 'RU-LIP', 'RU-BEL', 'RU-KRS', 'RU-ORL', 'RU-BRY',
      'RU-TAM', 'RU-ME', 'RU-MO', 'RU-KIR', 'RU-ARK', 'RU-KO',
      'RU-KL', 'RU-CE', 'RU-IN', 'RU-NEN',
    ],
    // Восток — 27
    [
      'RU-PRI', 'RU-ALT', 'RU-NVS', 'RU-TYU', 'RU-SVE', 'RU-CHE',
      'RU-KYA', 'RU-IRK', 'RU-KEM', 'RU-AL', 'RU-BU', 'RU-OMS',
      'RU-TOM', 'RU-KHA', 'RU-KHM', 'RU-YAN', 'RU-KAM', 'RU-SAK',
      'RU-KK', 'RU-ZAB', 'RU-SA', 'RU-AMU', 'RU-KGN', 'RU-TY',
      'RU-MAG', 'RU-YEV', 'RU-CHU',
    ],
  ],
};

export class ShareCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShareCodeError';
  }
}

/**
 * Каноническое кодирование: scheme.clusters × selected (Set id) → 'a-b-…'.
 * Идентификаторы вне справочника пропускаются (коды захардкожены, лишним
 * там не место), пустой набор → '0'.
 */
export function encodeCode(scheme, selected) {
  const parts = [];
  for (const ids of scheme.clusters) {
    const nSym = Math.ceil(ids.length / 6);
    const values = new Array(nSym).fill(0);
    for (let i = 0; i < ids.length; i++) {
      if (selected.has(ids[i])) values[Math.floor(i / 6)] |= 1 << (i % 6);
    }
    let str = '';
    for (const v of values) str += ALPHABET[v];
    parts.push(str.replace(/0+$/, '') || '0');
  }
  while (parts.length && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('-') || '0';
}

/**
 * Декодирование: код → Set идентификаторов. Лояльно к хвостовым нулям
 * (символам и целым кластерам), строго ко всему остальному.
 */
export function decodeCode(scheme, code) {
  const segments = code.split('-');
  if (segments.length > scheme.clusters.length) {
    throw new ShareCodeError(`лишние кластеры: ${segments.length} > ${scheme.clusters.length}`);
  }
  const selected = new Set();
  for (let c = 0; c < segments.length; c++) {
    const str = segments[c];
    const ids = scheme.clusters[c];
    const nSym = Math.ceil(ids.length / 6);
    if (str.length === 0) throw new ShareCodeError('пустой кластер');
    if (str.length > nSym) {
      throw new ShareCodeError(`кластер ${c} длиннее максимума: ${str.length} > ${nSym}`);
    }
    for (let s = 0; s < str.length; s++) {
      const v = VALUE_OF.get(str[s]);
      if (v === undefined) {
        throw new ShareCodeError(`неизвестный символ ${JSON.stringify(str[s])}`);
      }
      for (let b = 0; b < 6; b++) {
        const i = s * 6 + b;
        if (i >= ids.length) {
          // все биты за пределами справочника — резерв, обязаны быть нулями;
          // continue (не break): нулевой резерв не отменяет проверку старших битов
          if (v & (1 << b)) throw new ShareCodeError(`ненулевой резервный бит в кластере ${c}`);
          continue;
        }
        if (v & (1 << b)) selected.add(ids[i]);
      }
    }
  }
  return selected;
}
