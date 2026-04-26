(()=>{
  'use strict';

  const SYSTEM_CURRENCY_CODE = 'USD';
  const DEFAULT_COUNTERPART_CURRENCY_CODE = 'SYP';
  const DEFAULT_ACTIVE_BOOK_CODE = 'CASH';
  const STORAGE_KEY = 'taif-currency-management-module-v1';
  const LEGACY_ZERO_DROP_MODE = 'legacy-zero-drop';
  const LEGACY_ZERO_DROP_SHIFT = 2;

  const DEFAULT_CURRENCIES = Object.freeze([
    Object.freeze({ code:'USD', name:'الدولار الأمريكي', flag:'us', ratioBuy:1, ratioSell:1, method:'multiply', decimals:0 }),
    Object.freeze({ code:'EUR', name:'اليورو الأوروبي', flag:'eu', ratioBuy:1.15, ratioSell:1.16, method:'multiply', decimals:0 }),
    Object.freeze({ code:'SYP', name:'الليرة السورية', flag:'sy', ratioBuy:11000, ratioSell:11500, method:'divide', decimals:0 }),
    Object.freeze({ code:'TRY', name:'الليرة التركية', flag:'tr', ratioBuy:40, ratioSell:45, method:'divide', decimals:0 }),
    Object.freeze({ code:'SAR', name:'الريال السعودي', flag:'sa', ratioBuy:3.7, ratioSell:3.75, method:'divide', decimals:0 }),
    Object.freeze({ code:'AED', name:'الدرهم الإماراتي', flag:'ae', ratioBuy:3.7, ratioSell:3.75, method:'divide', decimals:0 }),
    Object.freeze({ code:'JOD', name:'الدينار الأردني', flag:'jo', ratioBuy:1.35, ratioSell:1.4, method:'multiply', decimals:0 })
  ]);

  const CURRENCY_FLAG_MAP = Object.freeze({
    USD:'us', EUR:'eu', GBP:'gb', CHF:'ch', SEK:'se', NOK:'no', DKK:'dk', CAD:'ca', AUD:'au', NZD:'nz',
    SYP:'sy', TRY:'tr', SAR:'sa', AED:'ae', JOD:'jo', KWD:'kw', QAR:'qa', BHD:'bh', OMR:'om', IQD:'iq',
    EGP:'eg', LBP:'lb', LYD:'ly', TND:'tn', MAD:'ma', DZD:'dz', SDG:'sd', YER:'ye', ILS:'ps',
    IRR:'ir', AFN:'af', PKR:'pk', INR:'in', BDT:'bd', LKR:'lk', NPR:'np', CNY:'cn', HKD:'hk', JPY:'jp',
    KRW:'kr', SGD:'sg', MYR:'my', THB:'th', VND:'vn', IDR:'id', PHP:'ph', KHR:'kh', LAK:'la', MMK:'mm',
    RUB:'ru', BYN:'by', UAH:'ua', PLN:'pl', CZK:'cz', HUF:'hu', RON:'ro', GEL:'ge', AMD:'am', AZN:'az', KZT:'kz',
    BRL:'br', MXN:'mx', ARS:'ar', CLP:'cl', COP:'co', PEN:'pe', CRC:'cr', GTQ:'gt', HNL:'hn', NIO:'ni', PAB:'pa',
    ZAR:'za', NGN:'ng', GHS:'gh', KES:'ke', TZS:'tz', UGX:'ug', RWF:'rw', ZMW:'zm', ZWL:'zw', XOF:'ci', XAF:'cm'
  });

  function clone(value){
    if(value == null || typeof value !== 'object') return value;
    try{ return JSON.parse(JSON.stringify(value)); }
    catch{ return Array.isArray(value) ? value.slice() : { ...value }; }
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function wrapControlTextMarkup(content, extraClass = ''){
    const className = ['taif-control-text', String(extraClass || '').trim()].filter(Boolean).join(' ');
    return `<span class="${className}">${content ?? ''}</span>`;
  }

  function normalizeLocalizedNumericText(value){
    return String(value ?? '')
      .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 0x06f0))
      .replace(/٫/g, '.')
      .replace(/٬/g, ',');
  }

  function sanitizeNumericText(value, { allowDecimal = true, allowNegative = true } = {}){
    const raw = normalizeLocalizedNumericText(value);
    let result = '';
    let seenDecimal = false;
    let seenSign = false;

    for(const char of raw){
      if(char >= '0' && char <= '9'){
        result += char;
        continue;
      }
      if(allowDecimal && char === '.' && !seenDecimal){
        result += '.';
        seenDecimal = true;
        continue;
      }
      if(allowNegative && char === '-' && !seenSign && !result){
        result += '-';
        seenSign = true;
      }
    }
    return result;
  }

  function normalizeStoredNumericText(value, options = {}){
    if(value === null || value === undefined) return '';
    const sanitized = sanitizeNumericText(value, options);
    return sanitized === '-' ? '' : sanitized;
  }

  function toNumber(value, fallback = 0){
    if(typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    const normalized = sanitizeNumericText(value, { allowDecimal:true, allowNegative:true });
    const number = Number(normalized);
    return Number.isFinite(number) ? number : fallback;
  }

  function getPositiveRate(value, fallback = 1){
    const number = toNumber(value, fallback);
    return Number.isFinite(number) && number > 0 ? number : Math.max(Number(fallback) || 1, 0.000001);
  }

  function clampDecimals(value){
    const parsed = parseInt(value, 10);
    if(!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(parsed, 6);
  }

  function normalizeCode(value){
    return String(value ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  }

  function normalizeFlagCode(value, fallbackCode = ''){
    const raw = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    if(raw) return raw;
    const code = normalizeCode(fallbackCode);
    return CURRENCY_FLAG_MAP[code] || code.slice(0, 2).toLowerCase() || 'xx';
  }

  function resolveCurrencyFlagAsset(rowOrCode, variant = 'circle'){
    const row = rowOrCode && typeof rowOrCode === 'object' ? rowOrCode : { code:rowOrCode };
    const code = normalizeCode(row.code);
    const flag = normalizeFlagCode(row.flag, code);
    return {
      src: `assets/flags/${variant}/${flag}.png`,
      countryCode: flag
    };
  }

  function pairId(baseCode, quoteCode){
    return `${normalizeCode(baseCode)}/${normalizeCode(quoteCode)}`;
  }

  function formatPairCode(baseCode, quoteCode, fallback = ''){
    const base = normalizeCode(baseCode);
    const quote = normalizeCode(quoteCode);
    return base && quote ? `${base}/${quote}` : String(fallback || '').trim();
  }

  function normalizeUsdConvention(value, fallbackMethod = 'multiply'){
    const raw = String(value ?? '').trim().toLowerCase();
    if(raw === 'usd-base' || raw === 'usdbase' || raw === 'usd_per_currency') return 'usd-base';
    if(raw === 'currency-base' || raw === 'currencybase' || raw === 'currency_per_usd') return 'currency-base';
    return String(fallbackMethod || '').trim() === 'divide' ? 'usd-base' : 'currency-base';
  }

  function conventionToLegacyMethod(convention){
    return normalizeUsdConvention(convention) === 'usd-base' ? 'divide' : 'multiply';
  }

  function normalizeBidAsk(rawBid, rawAsk, fallback = 1){
    const bid = getPositiveRate(rawBid, fallback);
    const ask = getPositiveRate(rawAsk, bid);
    return bid <= ask ? { bid, ask } : { bid:ask, ask:bid };
  }

  function invertQuote(quote){
    if(!quote) return null;
    return normalizeBidAsk(1 / getPositiveRate(quote.ask, 1), 1 / getPositiveRate(quote.bid, 1));
  }

  function multiplyQuotes(leftQuote, rightQuote){
    if(!leftQuote || !rightQuote) return null;
    return normalizeBidAsk(
      getPositiveRate(leftQuote.bid, 1) * getPositiveRate(rightQuote.bid, 1),
      getPositiveRate(leftQuote.ask, 1) * getPositiveRate(rightQuote.ask, 1),
      1
    );
  }

  function createStoredNumericText(value){
    const number = Number(value);
    if(!Number.isFinite(number) || !(number > 0)) return '';
    return normalizeStoredNumericText(String(number), { allowDecimal:true, allowNegative:false });
  }

  function getLegacyZeroDivisor(currency){
    const rawShift = Number(currency && currency.legacyZeroShift);
    const shift = Number.isFinite(rawShift) && rawShift > 0 ? Math.round(rawShift) : LEGACY_ZERO_DROP_SHIFT;
    return 10 ** Math.max(1, shift);
  }

  function resolveRateMode(currency){
    return String(currency && currency.rateMode || '').trim() === LEGACY_ZERO_DROP_MODE ? LEGACY_ZERO_DROP_MODE : 'manual';
  }

  function sanitizeCurrency(input, index = 0){
    const raw = input && typeof input === 'object' ? input : {};
    const fallback = DEFAULT_CURRENCIES.find((currency) => currency.code === normalizeCode(raw.code)) || DEFAULT_CURRENCIES[index] || {};
    const code = normalizeCode(raw.code || fallback.code || (index === 0 ? SYSTEM_CURRENCY_CODE : ''));
    if(!code) return null;
    const isUsd = code === SYSTEM_CURRENCY_CODE;
    const rawMethod = raw.method || fallback.method || 'multiply';
    const usdConvention = isUsd ? 'identity' : normalizeUsdConvention(raw.usdConvention, rawMethod);
    const normalizedQuote = isUsd
      ? { bid:1, ask:1 }
      : normalizeBidAsk(raw.ratioBuy ?? raw.buy ?? fallback.ratioBuy, raw.ratioSell ?? raw.sell ?? fallback.ratioSell, 1);
    const rateMode = isUsd ? 'manual' : resolveRateMode(raw);
    const rateEditedAt = Number(raw.rateEditedAt);

    return {
      ...raw,
      code,
      name: String(raw.name || fallback.name || code).trim() || code,
      flag: normalizeFlagCode(raw.flag || fallback.flag, code),
      ratioBuy: isUsd ? 1 : normalizedQuote.bid,
      ratioSell: isUsd ? 1 : normalizedQuote.ask,
      ratioBuyText: isUsd ? '' : normalizeStoredNumericText(raw.ratioBuyText ?? (typeof raw.ratioBuy === 'string' ? raw.ratioBuy : '')),
      ratioSellText: isUsd ? '' : normalizeStoredNumericText(raw.ratioSellText ?? (typeof raw.ratioSell === 'string' ? raw.ratioSell : '')),
      method: isUsd ? 'multiply' : conventionToLegacyMethod(usdConvention),
      usdConvention,
      decimals: clampDecimals(raw.decimals ?? fallback.decimals ?? 0),
      priceUpdateMode: raw.priceUpdateMode === 'internet' ? 'internet' : 'manual',
      rateMode,
      legacySourceCode: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE
        ? normalizeCode(raw.legacySourceCode || raw.sourceCurrencyCode || raw.linkedCurrencyCode || '')
        : '',
      legacyZeroShift: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE
        ? Math.max(1, Number(raw.legacyZeroShift) || LEGACY_ZERO_DROP_SHIFT)
        : 0,
      rateEditedAt: Number.isFinite(rateEditedAt) && rateEditedAt > 0 ? rateEditedAt : 0
    };
  }

  function scaleQuoteByDivisor(quote, divisor){
    const safeDivisor = Math.max(1, Number(divisor) || 1);
    return normalizeBidAsk(
      getPositiveRate(quote && quote.bid, 1) / safeDivisor,
      getPositiveRate(quote && quote.ask, 1) / safeDivisor,
      1 / safeDivisor
    );
  }

  function scaleQuoteByMultiplier(quote, multiplier){
    const safeMultiplier = Math.max(1, Number(multiplier) || 1);
    return normalizeBidAsk(
      getPositiveRate(quote && quote.bid, 1) * safeMultiplier,
      getPositiveRate(quote && quote.ask, 1) * safeMultiplier,
      safeMultiplier
    );
  }

  function syncLegacyZeroLinkedCurrencies(currenciesInput){
    const currencies = (Array.isArray(currenciesInput) ? currenciesInput : [])
      .map((currency) => currency && typeof currency === 'object' ? { ...currency } : null)
      .filter(Boolean);
    const currencyMap = new Map(currencies.map((currency) => [currency.code, currency]));
    const derivedBySource = new Map();

    currencies.forEach((currency) => {
      if(!currency || currency.code === SYSTEM_CURRENCY_CODE || currency.rateMode !== LEGACY_ZERO_DROP_MODE) return;
      const sourceCode = normalizeCode(currency.legacySourceCode);
      const sourceCurrency = currencyMap.get(sourceCode);
      if(!sourceCode || sourceCode === currency.code || !sourceCurrency || sourceCurrency.rateMode === LEGACY_ZERO_DROP_MODE) return;
      if(!derivedBySource.has(sourceCode)) derivedBySource.set(sourceCode, []);
      derivedBySource.get(sourceCode).push(currency);
    });

    derivedBySource.forEach((linkedCurrencies, sourceCode) => {
      const sourceCurrency = currencyMap.get(sourceCode);
      if(!sourceCurrency) return;
      const participants = [sourceCurrency, ...linkedCurrencies];
      let winnerCurrency = sourceCurrency;
      let winnerTimestamp = Number(sourceCurrency.rateEditedAt) || 0;

      participants.forEach((currency) => {
        const timestamp = Number(currency && currency.rateEditedAt) || 0;
        if(timestamp > winnerTimestamp){
          winnerTimestamp = timestamp;
          winnerCurrency = currency;
        }
      });

      const sourceConvention = normalizeUsdConvention(sourceCurrency.usdConvention, sourceCurrency.method);
      const winnerSourceQuote = winnerCurrency && winnerCurrency.code === sourceCurrency.code
        ? normalizeBidAsk(sourceCurrency.ratioBuy, sourceCurrency.ratioSell, 1)
        : scaleQuoteByMultiplier({ bid:winnerCurrency && winnerCurrency.ratioBuy, ask:winnerCurrency && winnerCurrency.ratioSell }, getLegacyZeroDivisor(winnerCurrency));
      const timestamp = winnerTimestamp || Date.now();

      Object.assign(sourceCurrency, {
        usdConvention: sourceConvention,
        method: conventionToLegacyMethod(sourceConvention),
        ratioBuy: winnerSourceQuote.bid,
        ratioSell: winnerSourceQuote.ask,
        rateEditedAt: timestamp,
        ratioBuyText: (winnerCurrency && winnerCurrency.code !== sourceCurrency.code) || !normalizeStoredNumericText(sourceCurrency.ratioBuyText)
          ? createStoredNumericText(winnerSourceQuote.bid)
          : normalizeStoredNumericText(sourceCurrency.ratioBuyText),
        ratioSellText: (winnerCurrency && winnerCurrency.code !== sourceCurrency.code) || !normalizeStoredNumericText(sourceCurrency.ratioSellText)
          ? createStoredNumericText(winnerSourceQuote.ask)
          : normalizeStoredNumericText(sourceCurrency.ratioSellText)
      });

      linkedCurrencies.forEach((currency) => {
        const derivedQuote = scaleQuoteByDivisor(winnerSourceQuote, getLegacyZeroDivisor(currency));
        Object.assign(currency, {
          usdConvention: sourceConvention,
          method: conventionToLegacyMethod(sourceConvention),
          ratioBuy: derivedQuote.bid,
          ratioSell: derivedQuote.ask,
          rateEditedAt: timestamp,
          ratioBuyText: createStoredNumericText(derivedQuote.bid),
          ratioSellText: createStoredNumericText(derivedQuote.ask)
        });
      });
    });

    return currencies;
  }

  function buildUsdPairDefinition(currency){
    const code = normalizeCode(currency && currency.code);
    if(!code || code === SYSTEM_CURRENCY_CODE) return null;
    const usdConvention = normalizeUsdConvention(currency && currency.usdConvention, currency && currency.method);
    const baseCode = usdConvention === 'usd-base' ? SYSTEM_CURRENCY_CODE : code;
    const quoteCode = usdConvention === 'usd-base' ? code : SYSTEM_CURRENCY_CODE;
    return { id:pairId(baseCode, quoteCode), baseCode, quoteCode, usdConvention, bookCode:DEFAULT_ACTIVE_BOOK_CODE };
  }

  function sanitizeRateBooks(rawBooks){
    const list = Array.isArray(rawBooks) && rawBooks.length ? rawBooks : [{ code:DEFAULT_ACTIVE_BOOK_CODE, name:'أسعار الصرافة' }];
    const seen = new Set();
    const books = [];
    list.forEach((book) => {
      const code = normalizeCode(book && book.code) || DEFAULT_ACTIVE_BOOK_CODE;
      if(seen.has(code)) return;
      seen.add(code);
      books.push({
        code,
        name: String(book && book.name || code).trim() || code,
        kind: String(book && book.kind || code).trim() || code,
        isOperational: Boolean(book && book.isOperational) || code === DEFAULT_ACTIVE_BOOK_CODE,
        isDefault: Boolean(book && book.isDefault) || code === DEFAULT_ACTIVE_BOOK_CODE
      });
    });
    if(!seen.has(DEFAULT_ACTIVE_BOOK_CODE)) books.unshift({ code:DEFAULT_ACTIVE_BOOK_CODE, name:'أسعار الصرافة', kind:'cash', isOperational:true, isDefault:true });
    return books;
  }

  function resolveActiveBookCode(rawValue, books){
    const normalized = normalizeCode(rawValue || DEFAULT_ACTIVE_BOOK_CODE);
    return (Array.isArray(books) && books.some((book) => normalizeCode(book.code) === normalized)) ? normalized : DEFAULT_ACTIVE_BOOK_CODE;
  }

  function sanitizeRateRecords(rawRecords, currencies, activeBookCode){
    const records = [];
    const seen = new Set();
    const pushRecord = (record) => {
      const bookCode = normalizeCode(record && record.bookCode || activeBookCode);
      const id = String(record && record.pairId || '').trim().toUpperCase();
      if(!bookCode || !id || !id.includes('/')) return;
      const normalized = normalizeBidAsk(record && record.bid, record && record.ask, 1);
      const key = `${bookCode}:${id}`;
      if(seen.has(key)) return;
      seen.add(key);
      records.push({
        ...record,
        bookCode,
        pairId:id,
        bid:normalized.bid,
        ask:normalized.ask,
        bidText:normalizeStoredNumericText(record && (record.bidText ?? (typeof record.bid === 'string' ? record.bid : ''))),
        askText:normalizeStoredNumericText(record && (record.askText ?? (typeof record.ask === 'string' ? record.ask : ''))),
        updatedAt:Number(record && record.updatedAt) > 0 ? Number(record.updatedAt) : 0
      });
    };

    (Array.isArray(rawRecords) ? rawRecords : []).forEach(pushRecord);

    currencies.forEach((currency) => {
      if(!currency || currency.code === SYSTEM_CURRENCY_CODE) return;
      const pair = buildUsdPairDefinition(currency);
      if(!pair) return;
      const normalized = normalizeBidAsk(currency.ratioBuy, currency.ratioSell, 1);
      const record = {
        bookCode:activeBookCode,
        pairId:pair.id,
        bid:normalized.bid,
        ask:normalized.ask,
        bidText:normalizeStoredNumericText(currency.ratioBuyText),
        askText:normalizeStoredNumericText(currency.ratioSellText),
        source:currency.priceUpdateMode === 'internet' ? 'internet' : 'manual',
        status:'active',
        updatedAt:Number(currency.rateEditedAt) || 0
      };
      const key = `${record.bookCode}:${record.pairId}`;
      const existingIndex = records.findIndex((item) => `${item.bookCode}:${item.pairId}` === key);
      if(existingIndex >= 0) records[existingIndex] = { ...records[existingIndex], ...record };
      else records.push(record);
      seen.add(key);
    });

    return records;
  }

  function resolveCounterpartCode(rawCode, currencies){
    const normalized = normalizeCode(rawCode || DEFAULT_COUNTERPART_CURRENCY_CODE);
    if(normalized && currencies.some((currency) => currency.code === normalized)) return normalized;
    if(currencies.some((currency) => currency.code === DEFAULT_COUNTERPART_CURRENCY_CODE)) return DEFAULT_COUNTERPART_CURRENCY_CODE;
    return SYSTEM_CURRENCY_CODE;
  }

  function sanitizeState(input){
    const raw = input && typeof input === 'object' ? input : {};
    const sourceCurrencies = Array.isArray(raw.currencies) && raw.currencies.length ? raw.currencies : [];
    const seen = new Set();
    const currencies = [];

    sourceCurrencies.forEach((item, index) => {
      const sanitized = sanitizeCurrency(item, index);
      if(!sanitized || seen.has(sanitized.code)) return;
      seen.add(sanitized.code);
      currencies.push(sanitized);
    });

    if(!seen.has(SYSTEM_CURRENCY_CODE)){
      const usd = sanitizeCurrency(DEFAULT_CURRENCIES[0], 0);
      seen.add(SYSTEM_CURRENCY_CODE);
      currencies.unshift(usd);
    }

    const ordered = syncLegacyZeroLinkedCurrencies([
      ...currencies.filter((currency) => currency.code === SYSTEM_CURRENCY_CODE),
      ...currencies.filter((currency) => currency.code !== SYSTEM_CURRENCY_CODE)
    ]);

    const books = sanitizeRateBooks(raw.rateBooks || raw.books);
    const activeBookCode = resolveActiveBookCode(raw.activeRateBookCode, books);
    const records = sanitizeRateRecords(raw.rateRecords || raw.records, ordered, activeBookCode);

    return {
      version:Number(raw.version) || 1,
      updatedAt:Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0,
      systemCurrencyCode:SYSTEM_CURRENCY_CODE,
      counterpartCode:resolveCounterpartCode(raw.counterpartCode, ordered),
      activeRateBookCode:activeBookCode,
      rateBooks:books,
      rateRecords:records,
      currencies:ordered
    };
  }

  function createDefaultState(){
    return sanitizeState({
      updatedAt:Date.now(),
      counterpartCode:DEFAULT_COUNTERPART_CURRENCY_CODE,
      currencies:clone(DEFAULT_CURRENCIES)
    });
  }

  function getCurrency(state, code){
    const safeCode = normalizeCode(code);
    return (Array.isArray(state && state.currencies) ? state.currencies : []).find((currency) => currency.code === safeCode) || null;
  }

  function getCounterpartCurrency(stateInput){
    const state = sanitizeState(stateInput);
    return getCurrency(state, state.counterpartCode) || getCurrency(state, SYSTEM_CURRENCY_CODE) || sanitizeCurrency(DEFAULT_CURRENCIES[0], 0);
  }

  function findRateRecord(stateInput, pairIdentifier, bookCode = null){
    const state = stateInput && typeof stateInput === 'object' ? stateInput : sanitizeState(stateInput);
    const safePairId = String(pairIdentifier || '').trim().toUpperCase();
    const safeBookCode = normalizeCode(bookCode || state.activeRateBookCode || DEFAULT_ACTIVE_BOOK_CODE);
    const candidates = (Array.isArray(state.rateRecords) ? state.rateRecords : [])
      .filter((record) => record && record.pairId === safePairId && record.bookCode === safeBookCode)
      .sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
    return candidates[0] || null;
  }

  function getLegacyZeroAnchor(stateInput, currencyCode){
    const state = stateInput && typeof stateInput === 'object' ? stateInput : sanitizeState(stateInput);
    const currency = getCurrency(state, currencyCode);
    if(!currency) return null;
    if(currency.rateMode === LEGACY_ZERO_DROP_MODE){
      const sourceCode = normalizeCode(currency.legacySourceCode);
      const sourceCurrency = getCurrency(state, sourceCode);
      if(!sourceCode || !sourceCurrency || sourceCurrency.rateMode === LEGACY_ZERO_DROP_MODE) return null;
      return { currencyCode:currency.code, rootCode:sourceCode, sourcePerUnit:getLegacyZeroDivisor(currency), isDerived:true, sourceCode };
    }
    return { currencyCode:currency.code, rootCode:currency.code, sourcePerUnit:1, isDerived:false, sourceCode:currency.code };
  }

  function getLegacyZeroFixedRelation(stateInput, baseCode, quoteCode){
    const state = stateInput && typeof stateInput === 'object' ? stateInput : sanitizeState(stateInput);
    const safeBase = normalizeCode(baseCode);
    const safeQuote = normalizeCode(quoteCode);
    if(!safeBase || !safeQuote || safeBase === safeQuote) return null;
    const baseCurrency = getCurrency(state, safeBase);
    const quoteCurrency = getCurrency(state, safeQuote);
    if(!baseCurrency || !quoteCurrency) return null;
    if(baseCurrency.rateMode !== LEGACY_ZERO_DROP_MODE && quoteCurrency.rateMode !== LEGACY_ZERO_DROP_MODE) return null;
    const baseAnchor = getLegacyZeroAnchor(state, safeBase);
    const quoteAnchor = getLegacyZeroAnchor(state, safeQuote);
    if(!baseAnchor || !quoteAnchor || baseAnchor.rootCode !== quoteAnchor.rootCode) return null;
    const fixedRate = getPositiveRate(baseAnchor.sourcePerUnit, 1) / getPositiveRate(quoteAnchor.sourcePerUnit, 1);
    const text = createStoredNumericText(fixedRate);
    return { baseCode:safeBase, quoteCode:safeQuote, rootCode:baseAnchor.rootCode, bid:fixedRate, ask:fixedRate, bidText:text, askText:text, derived:true, fixed:true, via:'legacy-fixed' };
  }

  function readOperationalQuote(stateInput, baseCode, quoteCode, depth = 0){
    const state = stateInput && typeof stateInput === 'object' ? stateInput : sanitizeState(stateInput);
    const safeBase = normalizeCode(baseCode);
    const safeQuote = normalizeCode(quoteCode);
    const safeBookCode = normalizeCode(state.activeRateBookCode || DEFAULT_ACTIVE_BOOK_CODE);
    if(!safeBase || !safeQuote) return null;
    if(safeBase === safeQuote) return { bid:1, ask:1, bidText:'1', askText:'1', derived:true, via:'identity', pairId:pairId(safeBase, safeQuote) };
    if(depth > 4) return null;

    const fixed = getLegacyZeroFixedRelation(state, safeBase, safeQuote);
    if(fixed) return { ...fixed, pairId:pairId(safeBase, safeQuote) };

    const direct = findRateRecord(state, pairId(safeBase, safeQuote), safeBookCode);
    if(direct){
      const normalized = normalizeBidAsk(direct.bid, direct.ask, 1);
      return { ...normalized, bidText:normalizeStoredNumericText(direct.bidText), askText:normalizeStoredNumericText(direct.askText), derived:false, via:'direct', pairId:direct.pairId };
    }

    const inverse = findRateRecord(state, pairId(safeQuote, safeBase), safeBookCode);
    if(inverse){
      const inverted = invertQuote(inverse);
      return inverted ? { ...inverted, bidText:'', askText:'', derived:true, via:'inverse', pairId:inverse.pairId } : null;
    }

    const pivot = SYSTEM_CURRENCY_CODE;
    if(safeBase === pivot || safeQuote === pivot) return null;
    const legA = readOperationalQuote(state, safeBase, pivot, depth + 1);
    const legB = readOperationalQuote(state, pivot, safeQuote, depth + 1);
    const combined = multiplyQuotes(legA, legB);
    return combined ? { ...combined, bidText:'', askText:'', derived:true, via:'pivot', pairId:pairId(safeBase, safeQuote) } : null;
  }

  function getUsdManualQuote(stateInput, currencyCode){
    const state = stateInput && typeof stateInput === 'object' ? stateInput : sanitizeState(stateInput);
    const code = normalizeCode(currencyCode);
    if(!code || code === SYSTEM_CURRENCY_CODE){
      return { currencyCode:SYSTEM_CURRENCY_CODE, pairId:pairId(SYSTEM_CURRENCY_CODE, SYSTEM_CURRENCY_CODE), baseCode:SYSTEM_CURRENCY_CODE, quoteCode:SYSTEM_CURRENCY_CODE, usdConvention:'identity', bid:1, ask:1, bidText:'1', askText:'1' };
    }
    const currency = getCurrency(state, code);
    const pair = buildUsdPairDefinition(currency);
    const record = pair ? findRateRecord(state, pair.id, state.activeRateBookCode) : null;
    const fallback = normalizeBidAsk(currency && currency.ratioBuy, currency && currency.ratioSell, 1);
    const normalized = normalizeBidAsk(record && record.bid, record && record.ask, fallback.bid);
    return {
      currencyCode:code,
      pairId:pair && pair.id || pairId(code, SYSTEM_CURRENCY_CODE),
      baseCode:pair && pair.baseCode || code,
      quoteCode:pair && pair.quoteCode || SYSTEM_CURRENCY_CODE,
      usdConvention:pair && pair.usdConvention || normalizeUsdConvention(currency && currency.usdConvention, currency && currency.method),
      bid:normalized.bid,
      ask:normalized.ask,
      bidText:normalizeStoredNumericText(record && record.bidText || currency && currency.ratioBuyText),
      askText:normalizeStoredNumericText(record && record.askText || currency && currency.ratioSellText)
    };
  }

  function resolveCurrencyFieldDecimals({ currencyDecimals = 0, counterpartDecimals = 0, field = 'buy' } = {}){
    const localDigits = clampDecimals(currencyDecimals);
    const counterpartDigits = clampDecimals(counterpartDecimals);
    switch(String(field || '').trim()){
      case 'buy':
      case 'sell':
      case 'middle':
        return Math.max(localDigits, counterpartDigits);
      case 'dollarBuy':
      case 'dollarSell':
      case 'ratioBuy':
      case 'ratioSell':
        return localDigits;
      default:
        return Math.max(localDigits, counterpartDigits);
    }
  }

  function computeRows(stateInput){
    const state = sanitizeState(stateInput);
    const counterpart = getCurrency(state, state.counterpartCode) || getCurrency(state, SYSTEM_CURRENCY_CODE);

    return state.currencies.map((currency) => {
      const usdManualQuote = getUsdManualQuote(state, currency.code);
      const usdOperationalQuote = readOperationalQuote(state, currency.code, SYSTEM_CURRENCY_CODE) || { bid:1, ask:1 };
      const isCounterpart = currency.code === counterpart.code;
      const fixedRelation = isCounterpart ? null : getLegacyZeroFixedRelation(state, currency.code, counterpart.code);
      const counterpartQuote = isCounterpart
        ? { bid:1, ask:1, bidText:'1', askText:'1', pairId:pairId(currency.code, counterpart.code), derived:true, selfReference:true }
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? readOperationalQuote(state, currency.code, counterpart.code) || usdOperationalQuote
          : readOperationalQuote(state, currency.code, counterpart.code));

      const displayDollarBuy = usdManualQuote.bid;
      const displayDollarSell = usdManualQuote.ask;
      const displayDollarBuyText = normalizeStoredNumericText(usdManualQuote.bidText);
      const displayDollarSellText = normalizeStoredNumericText(usdManualQuote.askText);
      const mirrorLegacy = Boolean(
        fixedRelation
        && counterpart.code !== SYSTEM_CURRENCY_CODE
        && currency.rateMode === LEGACY_ZERO_DROP_MODE
        && normalizeCode(currency.legacySourceCode) === counterpart.code
      );
      const displayBuy = counterpart.code === SYSTEM_CURRENCY_CODE ? displayDollarBuy : (mirrorLegacy ? displayDollarBuy : (counterpartQuote ? counterpartQuote.bid : null));
      const displaySell = counterpart.code === SYSTEM_CURRENCY_CODE ? displayDollarSell : (mirrorLegacy ? displayDollarSell : (counterpartQuote ? counterpartQuote.ask : null));
      const displayBuyText = counterpart.code === SYSTEM_CURRENCY_CODE ? displayDollarBuyText : (mirrorLegacy ? displayDollarBuyText : normalizeStoredNumericText(counterpartQuote && counterpartQuote.bidText));
      const displaySellText = counterpart.code === SYSTEM_CURRENCY_CODE ? displayDollarSellText : (mirrorLegacy ? displayDollarSellText : normalizeStoredNumericText(counterpartQuote && counterpartQuote.askText));
      const currencyDecimals = clampDecimals(currency.decimals ?? 0);
      const counterpartDecimals = clampDecimals(counterpart && counterpart.decimals !== undefined ? counterpart.decimals : 0);

      return {
        ...currency,
        buy:counterpartQuote ? counterpartQuote.bid : null,
        sell:counterpartQuote ? counterpartQuote.ask : null,
        middle:counterpartQuote ? ((counterpartQuote.bid + counterpartQuote.ask) / 2) : null,
        displayBuy,
        displaySell,
        displayBuyText,
        displaySellText,
        displayMiddle:(displayBuy !== null && displaySell !== null) ? ((displayBuy + displaySell) / 2) : null,
        dollarBuy:currency.code === SYSTEM_CURRENCY_CODE ? 1 : usdOperationalQuote.bid,
        dollarSell:currency.code === SYSTEM_CURRENCY_CODE ? 1 : usdOperationalQuote.ask,
        displayDollarBuy,
        displayDollarSell,
        displayDollarBuyText,
        displayDollarSellText,
        currencyDecimals,
        counterpartDecimals,
        fieldDecimals:{
          buy:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'buy' }),
          sell:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'sell' }),
          middle:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'middle' }),
          dollarBuy:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'dollarBuy' }),
          dollarSell:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'dollarSell' }),
          ratioBuy:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'ratioBuy' }),
          ratioSell:resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field:'ratioSell' })
        },
        usdPairId:usdManualQuote.pairId,
        usdPairLabel:formatPairCode(usdManualQuote.baseCode, usdManualQuote.quoteCode, usdManualQuote.pairId),
        counterpartPairLabel:currency.code === counterpart.code ? null : formatPairCode(currency.code, counterpart.code),
        isUsd:currency.code === SYSTEM_CURRENCY_CODE,
        isCounterpart,
        counterpartCode:counterpart.code,
        counterpartName:counterpart.name,
        counterpartFlag:counterpart.flag,
        counterpartPricingLocked:Boolean(fixedRelation)
      };
    });
  }

  function getNumericTextFractionDigits(value){
    const normalized = normalizeStoredNumericText(value, { allowDecimal:true, allowNegative:true });
    if(!normalized || !normalized.includes('.')) return 0;
    return normalized.split('.')[1].length;
  }

  function resolveAutoFractionDigits(value, { maxAutoDecimals = 6, mode = 'standard' } = {}){
    const max = clampDecimals(maxAutoDecimals);
    const number = Math.abs(toNumber(value, Number.NaN));
    if(!Number.isFinite(number) || number === 0) return 0;
    const fixed = number.toFixed(max);
    const fraction = fixed.includes('.') ? fixed.split('.')[1] : '';
    const trimmed = fraction.replace(/0+$/, '');
    if(!trimmed) return 0;
    if(number >= 1000) return 0;
    if(number >= 100) return Math.min(max, mode === 'rate' ? 2 : 1);
    if(number >= 1) return Math.min(max, 2);
    const leadingZeros = (trimmed.match(/^0+/) || [''])[0].length;
    return Math.min(max, Math.max(1, leadingZeros + (mode === 'rate' ? 4 : 3)));
  }

  function formatFixedNumericValue(value, fractionDigits = 0){
    const number = toNumber(value, Number.NaN);
    if(!Number.isFinite(number)) return '';
    const digits = clampDecimals(fractionDigits);
    return new Intl.NumberFormat('en-US', {
      useGrouping:true,
      minimumFractionDigits:digits,
      maximumFractionDigits:digits
    }).format(number);
  }

  function formatCurrencyNumericDisplay(value, {
    rawText = '',
    decimals = null,
    maxAutoDecimals = 6,
    mode = 'standard',
    fallback = '—',
    respectConfiguredDecimals = true
  } = {}){
    const preserved = normalizeStoredNumericText(rawText, { allowDecimal:true, allowNegative:true });
    const hasConfiguredDecimals = decimals !== null && decimals !== undefined && decimals !== '';
    const configuredDigits = hasConfiguredDecimals && respectConfiguredDecimals ? clampDecimals(decimals) : null;

    if(preserved){
      const rawDigits = getNumericTextFractionDigits(preserved);
      const fractionDigits = configuredDigits === null ? rawDigits : Math.max(rawDigits, configuredDigits);
      return formatFixedNumericValue(preserved, fractionDigits) || preserved;
    }

    const number = toNumber(value, Number.NaN);
    if(!Number.isFinite(number)) return fallback;
    const fractionDigits = configuredDigits !== null
      ? configuredDigits
      : resolveAutoFractionDigits(number, { maxAutoDecimals, mode });
    return formatFixedNumericValue(number, fractionDigits) || fallback;
  }

  function formatManagementCellValue(row, field, maxAutoDecimals = 6){
    const safeRow = row && typeof row === 'object' ? row : {};
    const displayTextFieldMap = {
      buy:'displayBuyText',
      sell:'displaySellText',
      dollarBuy:'displayDollarBuyText',
      dollarSell:'displayDollarSellText'
    };
    const displayFieldMap = {
      buy:'displayBuy',
      sell:'displaySell',
      middle:'displayMiddle',
      dollarBuy:'displayDollarBuy',
      dollarSell:'displayDollarSell'
    };
    const isCounterpartDisplayRow = Boolean(
      safeRow.isCounterpart
      && normalizeCode(safeRow.code) !== SYSTEM_CURRENCY_CODE
      && (field === 'buy' || field === 'sell' || field === 'middle')
    );

    let effectiveField = field;
    let rawText = displayTextFieldMap[field] ? safeRow[displayTextFieldMap[field]] : '';
    let value = displayFieldMap[field] && Object.prototype.hasOwnProperty.call(safeRow, displayFieldMap[field])
      ? safeRow[displayFieldMap[field]]
      : safeRow[field];

    if(isCounterpartDisplayRow){
      if(field === 'buy'){
        effectiveField = 'dollarBuy';
        rawText = safeRow.displayDollarBuyText;
        value = safeRow.displayDollarBuy;
      }else if(field === 'sell'){
        effectiveField = 'dollarSell';
        rawText = safeRow.displayDollarSellText;
        value = safeRow.displayDollarSell;
      }else{
        const buy = toNumber(safeRow.displayDollarBuy, Number.NaN);
        const sell = toNumber(safeRow.displayDollarSell, Number.NaN);
        effectiveField = 'middle';
        rawText = '';
        value = Number.isFinite(buy) && Number.isFinite(sell) ? ((buy + sell) / 2) : safeRow.displayMiddle;
      }
    }

    const numericValue = toNumber(value, Number.NaN);
    if(value === null || value === undefined || !Number.isFinite(numericValue)) return '—';
    const decimalsLookupField = effectiveField === 'middle' && isCounterpartDisplayRow ? 'dollarBuy' : effectiveField;
    const fieldDecimals = safeRow.fieldDecimals && Object.prototype.hasOwnProperty.call(safeRow.fieldDecimals, decimalsLookupField)
      ? safeRow.fieldDecimals[decimalsLookupField]
      : safeRow.decimals;
    const safeRawText = normalizeStoredNumericText(rawText, { allowDecimal:true, allowNegative:true });
    const quoteLikeField = ['buy','sell','middle','dollarBuy','dollarSell','ratioBuy','ratioSell'].includes(effectiveField);
    const relaxDecimals = quoteLikeField
      && !safeRawText
      && clampDecimals(fieldDecimals) === 0
      && Math.abs(numericValue) > 0
      && Math.abs(numericValue) < 10;

    return formatCurrencyNumericDisplay(numericValue, {
      rawText:safeRawText,
      decimals:fieldDecimals,
      maxAutoDecimals,
      mode:effectiveField === 'middle' ? 'mid' : 'rate',
      fallback:'—',
      respectConfiguredDecimals:!relaxDecimals
    });
  }

  function renderPairBadgeMarkup(pairLabel){
    const label = String(pairLabel || 'USD/USD').trim() || 'USD/USD';
    const [left, ...rest] = label.split('/');
    const right = rest.join('/') || '';
    if(!left || !right) return escapeHtml(label);
    return `<span class="taif-pair-badge__part taif-pair-badge__part--usd">${escapeHtml(left)}</span><span class="taif-pair-badge__slash">/</span><span class="taif-pair-badge__part taif-pair-badge__part--counterpart">${escapeHtml(right)}</span>`;
  }

  function parseJsonSafely(rawValue){
    if(typeof rawValue !== 'string') return { ok:false, value:null };
    const raw = rawValue.trim();
    if(!raw) return { ok:false, value:null };
    try{ return { ok:true, value:JSON.parse(raw) }; }
    catch{ return { ok:false, value:null }; }
  }

  function looksLikeCurrencyState(value){
    return Boolean(value && typeof value === 'object' && (
      Array.isArray(value.currencies)
      || Array.isArray(value.rateRecords)
      || Object.prototype.hasOwnProperty.call(value, 'counterpartCode')
      || Object.prototype.hasOwnProperty.call(value, 'systemCurrencyCode')
    ));
  }

  function unwrapCurrencyStatePayload(value, depth = 0){
    if(depth > 6 || value == null) return null;
    if(typeof value === 'string'){
      const parsed = parseJsonSafely(value);
      return parsed.ok ? unwrapCurrencyStatePayload(parsed.value, depth + 1) : null;
    }
    if(looksLikeCurrencyState(value)) return value;
    if(Array.isArray(value)){
      for(const item of value){
        const unwrapped = unwrapCurrencyStatePayload(item, depth + 1);
        if(unwrapped) return unwrapped;
      }
      return null;
    }
    if(typeof value !== 'object') return null;

    const directKeys = [
      STORAGE_KEY,
      'currencyManagement',
      'currencyDomain',
      'priceScreen',
      'state',
      'payload',
      'raw_value',
      'rawValue',
      'value',
      'data'
    ];

    for(const key of directKeys){
      if(Object.prototype.hasOwnProperty.call(value, key)){
        const unwrapped = unwrapCurrencyStatePayload(value[key], depth + 1);
        if(unwrapped) return unwrapped;
      }
    }

    for(const [key, entry] of Object.entries(value)){
      if(String(key).endsWith(`::${STORAGE_KEY}`) || String(key) === STORAGE_KEY || String(key).includes(STORAGE_KEY)){
        const unwrapped = unwrapCurrencyStatePayload(entry, depth + 1);
        if(unwrapped) return unwrapped;
      }
    }
    return null;
  }

  window.TAIFPublicPriceEngine = Object.freeze({
    SYSTEM_CURRENCY_CODE,
    STORAGE_KEY,
    clone,
    escapeHtml,
    wrapControlTextMarkup,
    normalizeCode,
    createDefaultState,
    sanitizeState,
    computeRows,
    getCounterpartCurrency,
    formatManagementCellValue,
    resolveCurrencyFlagAsset,
    renderPairBadgeMarkup,
    unwrapCurrencyStatePayload
  });
})();
