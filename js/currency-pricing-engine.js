(()=>{
  /*
   * TAIF Currency feature pricing engine.
   * Replaces the legacy multiply/divide-only pricing logic with a pair-driven engine,
   * active rate books, strict bid/ask validation, inverse derivation, and pivot-based cross rates.
   */
  const TAIF = window.TAIF;
  const { clone } = TAIF.core.utils;
  const feature = TAIF.currencyManagementFeature || (TAIF.currencyManagementFeature = {});
  const {
    DEFAULT_CURRENCIES,
    DEFAULT_COUNTERPART_CURRENCY_CODE = 'SYP',
    LEGACY_ZERO_DROP_MODE = 'legacy-zero-drop',
    LEGACY_ZERO_DROP_SHIFT = 2,
    MODULE_KEY = 'taif-currency-management-module-v1',
    writeModuleState,
    normalizeCode,
    clampDecimals,
    normalizeStoredNumericText,
    toNumber,
    getPositiveRate,
    getDefaultCurrency,
    sanitizeCurrency,
    resolveCounterpartCode,
    getCounterpartDisplayName,
    getCounterpartHeaderText,
    notifyStateChange,
    formatCurrencyNumericDisplay,
    resolveCurrencyFieldDecimals,
    pairId,
    formatPairCode,
    normalizeUsdConvention,
    conventionToLegacyMethod
  } = feature;

  const SYSTEM_CURRENCY_CODE = 'USD';
  const DEFAULT_ACTIVE_BOOK_CODE = 'cash';
  const CURRENCY_DEFAULTS_VERSION = 7;
  const LEGACY_DEFAULT_CURRENCY_CODES = Object.freeze(['USD', 'EUR', 'SAR', 'AED', 'TRY', 'JOD']);
  const DEFAULT_RATE_BOOKS = Object.freeze([
    { code: 'cash', name: 'أسعار الصرافة', kind: 'cash', isOperational: true, isDefault: true },
    { code: 'remittance', name: 'أسعار الحوالات', kind: 'remittance', isOperational: false, isDefault: false },
    { code: 'accounting', name: 'الأسعار المحاسبية', kind: 'accounting', isOperational: false, isDefault: false },
    { code: 'reference', name: 'الأسعار المرجعية', kind: 'reference', isOperational: false, isDefault: false }
  ]);


  function shouldReplaceLegacyDefaultCurrencyCatalog(rawCurrencies, rawVersion){
    const versionNumber = Number(rawVersion);
    if(Number.isFinite(versionNumber) && versionNumber >= CURRENCY_DEFAULTS_VERSION) return false;

    const list = Array.isArray(rawCurrencies) ? rawCurrencies : [];
    if(!list.length) return false;

    const codes = list
      .map((currency) => normalizeCode(currency && currency.code))
      .filter(Boolean);
    if(!codes.length) return false;

    const uniqueCodes = Array.from(new Set(codes));
    if(!uniqueCodes.includes(SYSTEM_CURRENCY_CODE)) return false;
    if(uniqueCodes.some((code) => !LEGACY_DEFAULT_CURRENCY_CODES.includes(code))) return false;
    return true;
  }

  function isLegacyDefaultSyrianLiraDirection(currency){
    if(!currency || normalizeCode(currency.code) !== 'SYP') return false;
    const currentConvention = normalizeUsdConvention(currency.usdConvention, currency.method);
    if(currentConvention === 'usd-base') return false;

    const bid = getPositiveRate(currency.ratioBuy, 0);
    const ask = getPositiveRate(currency.ratioSell, 0);
    if(!Number.isFinite(bid) || !Number.isFinite(ask)) return false;

    const normalizedName = String(currency.name || '')
      .trim()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي');

    return Math.abs(bid - 11000) < 1e-9
      && Math.abs(ask - 11500) < 1e-9
      && (!normalizedName || normalizedName.includes('الليره السوري'));
  }

  function upgradeLegacyDefaultCurrencyCatalog(rawCurrencies, rawVersion){
    const versionNumber = Number(rawVersion);
    if(Number.isFinite(versionNumber) && versionNumber >= CURRENCY_DEFAULTS_VERSION) return rawCurrencies;

    const list = Array.isArray(rawCurrencies) ? rawCurrencies : [];
    if(!list.length) return rawCurrencies;

    let changed = false;
    const upgraded = list.map((currency) => {
      if(!isLegacyDefaultSyrianLiraDirection(currency)) return currency;
      changed = true;
      return {
        ...currency,
        method: 'divide',
        usdConvention: 'usd-base'
      };
    });

    return changed ? upgraded : rawCurrencies;
  }

  function hasDefaultCurrencyCatalogShape(currencies){
    const currentCodes = Array.from(new Set(
      (Array.isArray(currencies) ? currencies : [])
        .map((currency) => normalizeCode(currency && currency.code))
        .filter(Boolean)
    ));
    const defaultCodes = Array.from(new Set(
      DEFAULT_CURRENCIES
        .map((currency) => normalizeCode(currency && currency.code))
        .filter(Boolean)
    ));
    if(!currentCodes.length || currentCodes.length !== defaultCodes.length) return false;
    return defaultCodes.every((code) => currentCodes.includes(code));
  }

  function shouldMigrateLegacyDefaultCounterpart(rawState, currencies, rawVersion){
    const versionNumber = Number(rawVersion);
    if(Number.isFinite(versionNumber) && versionNumber >= CURRENCY_DEFAULTS_VERSION) return false;
    if(normalizeCode(rawState && rawState.counterpartCode) !== SYSTEM_CURRENCY_CODE) return false;
    return hasDefaultCurrencyCatalogShape(currencies);
  }


  function createRateBooks(rawBooks){
    const list = Array.isArray(rawBooks) && rawBooks.length ? rawBooks : DEFAULT_RATE_BOOKS;
    const seen = new Set();
    const books = [];
    list.forEach((book, index) => {
      const code = normalizeCode(book && book.code) || normalizeCode(DEFAULT_RATE_BOOKS[index] && DEFAULT_RATE_BOOKS[index].code) || '';
      if(!code || seen.has(code)) return;
      seen.add(code);
      books.push({
        code,
        name: String(book && book.name || code).trim() || code,
        kind: String(book && book.kind || code).trim() || code,
        isOperational: Boolean(book && book.isOperational) || code === DEFAULT_ACTIVE_BOOK_CODE,
        isDefault: Boolean(book && book.isDefault) || code === DEFAULT_ACTIVE_BOOK_CODE
      });
    });

    DEFAULT_RATE_BOOKS.forEach((book) => {
      const normalizedDefaultCode = normalizeCode(book && book.code);
      if(!normalizedDefaultCode || seen.has(normalizedDefaultCode)) return;
      seen.add(normalizedDefaultCode);
      books.push(clone(book));
    });

    return books;
  }

  function resolveActiveBookCode(rawValue, books){
    const normalized = normalizeCode(rawValue || DEFAULT_ACTIVE_BOOK_CODE);
    if(Array.isArray(books) && books.some((book) => normalizeCode(book && book.code) === normalized)) return normalized;
    return DEFAULT_ACTIVE_BOOK_CODE;
  }

  function normalizeBidAsk(rawBid, rawAsk, fallback = 1){
    const bid = getPositiveRate(rawBid, fallback);
    const ask = getPositiveRate(rawAsk, bid);
    return bid <= ask
      ? { bid, ask }
      : { bid: ask, ask: bid };
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

  function divideQuotes(dividendQuote, divisorQuote){
    if(!dividendQuote || !divisorQuote) return null;
    return normalizeBidAsk(
      getPositiveRate(dividendQuote.bid, 1) / getPositiveRate(divisorQuote.bid, 1),
      getPositiveRate(dividendQuote.ask, 1) / getPositiveRate(divisorQuote.ask, 1),
      1
    );
  }

  function normalizeRateEditedAt(value){
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  function getLegacyZeroDivisor(currency){
    const rawShift = Number(currency && currency.legacyZeroShift);
    const safeShift = Number.isFinite(rawShift) && rawShift > 0 ? Math.round(rawShift) : LEGACY_ZERO_DROP_SHIFT;
    return 10 ** Math.max(1, safeShift);
  }

  function createStoredNumericText(value){
    const numeric = Number(value);
    if(!Number.isFinite(numeric) || !(numeric > 0)) return '';
    return normalizeStoredNumericText(String(numeric));
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

  function findCurrencyByCode(stateInput, currencyCode){
    const state = ensureState(stateInput);
    const safeCode = normalizeCode(currencyCode);
    if(!safeCode) return null;
    return (Array.isArray(state.currencies) ? state.currencies : []).find((currency) => normalizeCode(currency && currency.code) === safeCode) || null;
  }

  function getLegacyZeroAnchor(stateInput, currencyCode){
    const state = ensureState(stateInput);
    const currency = findCurrencyByCode(state, currencyCode);
    if(!currency) return null;

    const safeCode = normalizeCode(currency.code);
    if(currency.rateMode === LEGACY_ZERO_DROP_MODE){
      const sourceCode = normalizeCode(currency.legacySourceCode);
      const sourceCurrency = findCurrencyByCode(state, sourceCode);
      if(!sourceCode || !sourceCurrency || sourceCurrency.rateMode === LEGACY_ZERO_DROP_MODE) return null;
      return {
        currencyCode: safeCode,
        rootCode: sourceCode,
        sourcePerUnit: getLegacyZeroDivisor(currency),
        isDerived: true,
        sourceCode
      };
    }

    return {
      currencyCode: safeCode,
      rootCode: safeCode,
      sourcePerUnit: 1,
      isDerived: false,
      sourceCode: safeCode
    };
  }

  function getLegacyZeroFixedRelation(stateInput, baseCode, quoteCode){
    const state = ensureState(stateInput);
    const safeBase = normalizeCode(baseCode);
    const safeQuote = normalizeCode(quoteCode);
    if(!safeBase || !safeQuote || safeBase === safeQuote) return null;

    const baseCurrency = findCurrencyByCode(state, safeBase);
    const quoteCurrency = findCurrencyByCode(state, safeQuote);
    if(!baseCurrency || !quoteCurrency) return null;

    const hasLegacyParticipant = baseCurrency.rateMode === LEGACY_ZERO_DROP_MODE || quoteCurrency.rateMode === LEGACY_ZERO_DROP_MODE;
    if(!hasLegacyParticipant) return null;

    const baseAnchor = getLegacyZeroAnchor(state, safeBase);
    const quoteAnchor = getLegacyZeroAnchor(state, safeQuote);
    if(!baseAnchor || !quoteAnchor || baseAnchor.rootCode !== quoteAnchor.rootCode) return null;

    const fixedRate = getPositiveRate(baseAnchor.sourcePerUnit, 1) / getPositiveRate(quoteAnchor.sourcePerUnit, 1);
    const storedText = createStoredNumericText(fixedRate);

    return {
      baseCode: safeBase,
      quoteCode: safeQuote,
      rootCode: baseAnchor.rootCode,
      baseSourcePerUnit: baseAnchor.sourcePerUnit,
      quoteSourcePerUnit: quoteAnchor.sourcePerUnit,
      bid: fixedRate,
      ask: fixedRate,
      bidText: storedText,
      askText: storedText,
      derived: true,
      fixed: true,
      via: 'legacy-fixed'
    };
  }

  function syncLegacyZeroLinkedCurrencies(currenciesInput){
    const currencies = Array.isArray(currenciesInput)
      ? currenciesInput.map((currency) => currency && typeof currency === 'object' ? { ...currency } : currency).filter(Boolean)
      : [];
    const currencyMap = new Map(currencies.map((currency) => [currency.code, currency]));
    const derivedBySource = new Map();

    currencies.forEach((currency) => {
      if(!currency || currency.code === SYSTEM_CURRENCY_CODE) return;
      if(currency.rateMode !== LEGACY_ZERO_DROP_MODE) return;
      const sourceCode = normalizeCode(currency.legacySourceCode);
      if(!sourceCode || sourceCode === currency.code) return;
      const sourceCurrency = currencyMap.get(sourceCode);
      if(!sourceCurrency || sourceCurrency.rateMode === LEGACY_ZERO_DROP_MODE) return;
      if(!derivedBySource.has(sourceCode)) derivedBySource.set(sourceCode, []);
      derivedBySource.get(sourceCode).push(currency);
    });

    derivedBySource.forEach((linkedCurrencies, sourceCode) => {
      const sourceCurrency = currencyMap.get(sourceCode);
      if(!sourceCurrency) return;

      const participants = [sourceCurrency, ...linkedCurrencies];
      let winnerCurrency = sourceCurrency;
      let winnerTimestamp = normalizeRateEditedAt(sourceCurrency.rateEditedAt);

      participants.forEach((currency) => {
        const timestamp = normalizeRateEditedAt(currency && currency.rateEditedAt);
        if(timestamp > winnerTimestamp){
          winnerTimestamp = timestamp;
          winnerCurrency = currency;
        }
      });

      const sourceConvention = normalizeUsdConvention(sourceCurrency.usdConvention, sourceCurrency.method);
      const winnerSourceQuote = winnerCurrency && winnerCurrency.code === sourceCurrency.code
        ? normalizeBidAsk(sourceCurrency.ratioBuy, sourceCurrency.ratioSell, 1)
        : scaleQuoteByMultiplier(
            {
              bid: winnerCurrency && winnerCurrency.ratioBuy,
              ask: winnerCurrency && winnerCurrency.ratioSell
            },
            getLegacyZeroDivisor(winnerCurrency)
          );
      const resolvedTimestamp = winnerTimestamp || Date.now();

      sourceCurrency.usdConvention = sourceConvention;
      sourceCurrency.method = conventionToLegacyMethod(sourceConvention);
      sourceCurrency.ratioBuy = winnerSourceQuote.bid;
      sourceCurrency.ratioSell = winnerSourceQuote.ask;
      sourceCurrency.rateEditedAt = resolvedTimestamp;
      if((winnerCurrency && winnerCurrency.code !== sourceCurrency.code) || !normalizeStoredNumericText(sourceCurrency.ratioBuyText)){
        sourceCurrency.ratioBuyText = createStoredNumericText(winnerSourceQuote.bid);
      }
      if((winnerCurrency && winnerCurrency.code !== sourceCurrency.code) || !normalizeStoredNumericText(sourceCurrency.ratioSellText)){
        sourceCurrency.ratioSellText = createStoredNumericText(winnerSourceQuote.ask);
      }

      linkedCurrencies.forEach((currency) => {
        const divisor = getLegacyZeroDivisor(currency);
        const derivedQuote = scaleQuoteByDivisor(winnerSourceQuote, divisor);
        currency.usdConvention = sourceConvention;
        currency.method = conventionToLegacyMethod(sourceConvention);
        currency.ratioBuy = derivedQuote.bid;
        currency.ratioSell = derivedQuote.ask;
        currency.rateEditedAt = resolvedTimestamp;
        if(!(winnerCurrency && winnerCurrency.code === currency.code && normalizeStoredNumericText(currency.ratioBuyText))){
          currency.ratioBuyText = createStoredNumericText(derivedQuote.bid);
        }else{
          currency.ratioBuyText = normalizeStoredNumericText(currency.ratioBuyText);
        }
        if(!(winnerCurrency && winnerCurrency.code === currency.code && normalizeStoredNumericText(currency.ratioSellText))){
          currency.ratioSellText = createStoredNumericText(derivedQuote.ask);
        }else{
          currency.ratioSellText = normalizeStoredNumericText(currency.ratioSellText);
        }
      });
    });

    return currencies;
  }

  function sanitizeCurrencyMaster(input, index = 0){
    const baseCurrency = typeof sanitizeCurrency === 'function'
      ? sanitizeCurrency(input, index)
      : null;
    if(!baseCurrency) return null;

    const isUsd = baseCurrency.code === SYSTEM_CURRENCY_CODE;
    const usdConvention = isUsd ? 'identity' : normalizeUsdConvention(input && input.usdConvention, baseCurrency.method);
    const normalizedShadow = isUsd
      ? { bid: 1, ask: 1 }
      : normalizeBidAsk(baseCurrency.ratioBuy, baseCurrency.ratioSell, 1);
    const rateMode = isUsd ? 'manual' : (baseCurrency.rateMode === LEGACY_ZERO_DROP_MODE ? LEGACY_ZERO_DROP_MODE : 'manual');

    return {
      ...baseCurrency,
      usdConvention,
      method: isUsd ? 'multiply' : conventionToLegacyMethod(usdConvention),
      ratioBuy: normalizedShadow.bid,
      ratioSell: normalizedShadow.ask,
      ratioBuyText: isUsd ? '' : normalizeStoredNumericText(baseCurrency.ratioBuyText),
      ratioSellText: isUsd ? '' : normalizeStoredNumericText(baseCurrency.ratioSellText),
      buy: isUsd ? getPositiveRate(baseCurrency.buy, 1) : undefined,
      sell: isUsd ? getPositiveRate(baseCurrency.sell, 1) : undefined,
      buyText: isUsd ? normalizeStoredNumericText(baseCurrency.buyText) : undefined,
      sellText: isUsd ? normalizeStoredNumericText(baseCurrency.sellText) : undefined,
      rateMode,
      legacySourceCode: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE ? normalizeCode(baseCurrency.legacySourceCode) : '',
      legacyZeroShift: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE ? Math.max(1, Number(baseCurrency.legacyZeroShift) || LEGACY_ZERO_DROP_SHIFT) : 0,
      rateEditedAt: normalizeRateEditedAt(baseCurrency.rateEditedAt)
    };
  }

  function createDefaultState(){
    const currencies = clone(DEFAULT_CURRENCIES)
      .map((currency, index) => sanitizeCurrencyMaster(currency, index))
      .filter(Boolean);

    return sanitizeState({
      version: CURRENCY_DEFAULTS_VERSION,
      updatedAt: Date.now(),
      systemCurrencyCode: SYSTEM_CURRENCY_CODE,
      activeRateBookCode: DEFAULT_ACTIVE_BOOK_CODE,
      counterpartCode: DEFAULT_COUNTERPART_CURRENCY_CODE,
      rateBooks: clone(DEFAULT_RATE_BOOKS),
      pairRegistry: [],
      rateRecords: [],
      currencies
    });
  }

  function buildUsdPairDefinition(currency){
    const code = normalizeCode(currency && currency.code);
    if(!code || code === SYSTEM_CURRENCY_CODE) return null;
    const usdConvention = normalizeUsdConvention(currency && currency.usdConvention, currency && currency.method);
    const baseCode = usdConvention === 'usd-base' ? SYSTEM_CURRENCY_CODE : code;
    const quoteCode = usdConvention === 'usd-base' ? code : SYSTEM_CURRENCY_CODE;
    return {
      id: pairId(baseCode, quoteCode),
      baseCode,
      quoteCode,
      usdConvention,
      role: 'manual-usd-anchor',
      sourceType: 'manual'
    };
  }

  function sanitizePairRegistry(rawPairs, currencies){
    const registry = [];
    const seen = new Set();
    const list = Array.isArray(rawPairs) ? rawPairs : [];
    const availableCurrencyCodes = new Set(
      (Array.isArray(currencies) ? currencies : [])
        .map((currency) => normalizeCode(currency && currency.code))
        .filter(Boolean)
    );

    list.forEach((pair) => {
      const baseCode = normalizeCode(pair && pair.baseCode);
      const quoteCode = normalizeCode(pair && pair.quoteCode);
      if(!baseCode || !quoteCode || baseCode === quoteCode) return;
      if(!availableCurrencyCodes.has(baseCode) || !availableCurrencyCodes.has(quoteCode)) return;
      const id = pairId(baseCode, quoteCode);
      if(seen.has(id)) return;
      seen.add(id);
      registry.push({
        id,
        baseCode,
        quoteCode,
        usdConvention: String(pair && pair.usdConvention || '').trim() || null,
        role: String(pair && pair.role || '').trim() || 'manual',
        sourceType: String(pair && pair.sourceType || '').trim() || 'manual'
      });
    });

    (Array.isArray(currencies) ? currencies : []).forEach((currency) => {
      const definition = buildUsdPairDefinition(currency);
      if(!definition || seen.has(definition.id)) return;
      seen.add(definition.id);
      registry.push(definition);
    });

    return registry;
  }

  function sanitizeRateRecords(rawRecords, pairRegistry, activeBookCode, currencies){
    const pairIds = new Set((Array.isArray(pairRegistry) ? pairRegistry : []).map((pair) => pair.id));
    const records = [];
    const seen = new Set();

    (Array.isArray(rawRecords) ? rawRecords : []).forEach((record) => {
      const bookCode = normalizeCode(record && record.bookCode || activeBookCode);
      const recordPairId = String(record && record.pairId || '').trim().toUpperCase();
      if(!bookCode || !recordPairId || !pairIds.has(recordPairId)) return;
      const normalized = normalizeBidAsk(record && record.bid, record && record.ask, 1);
      const key = `${bookCode}:${recordPairId}`;
      if(seen.has(key)) return;
      seen.add(key);
      records.push({
        bookCode,
        pairId: recordPairId,
        bid: normalized.bid,
        ask: normalized.ask,
        bidText: normalizeStoredNumericText(record && (record.bidText ?? (typeof record.bid === 'string' ? record.bid : ''))),
        askText: normalizeStoredNumericText(record && (record.askText ?? (typeof record.ask === 'string' ? record.ask : ''))),
        source: String(record && record.source || 'manual').trim() || 'manual',
        status: String(record && record.status || 'active').trim() || 'active',
        effectiveAt: Number(record && record.effectiveAt) > 0 ? Number(record && record.effectiveAt) : Date.now(),
        updatedAt: Number(record && record.updatedAt) > 0 ? Number(record && record.updatedAt) : Date.now()
      });
    });

    (Array.isArray(currencies) ? currencies : []).forEach((currency) => {
      if(!currency || currency.code === SYSTEM_CURRENCY_CODE) return;
      const pair = buildUsdPairDefinition(currency);
      if(!pair) return;
      const normalized = normalizeBidAsk(currency.ratioBuy, currency.ratioSell, 1);
      const key = `${activeBookCode}:${pair.id}`;
      const staleKeys = [
        `${activeBookCode}:${pairId(SYSTEM_CURRENCY_CODE, currency.code)}`,
        `${activeBookCode}:${pairId(currency.code, SYSTEM_CURRENCY_CODE)}`
      ];
      for(const staleKey of staleKeys){
        const index = records.findIndex((record) => `${record.bookCode}:${record.pairId}` === staleKey && staleKey !== key);
        if(index >= 0) records.splice(index, 1);
        seen.delete(staleKey);
      }
      const nextRecord = {
        bookCode: activeBookCode,
        pairId: pair.id,
        bid: normalized.bid,
        ask: normalized.ask,
        bidText: normalizeStoredNumericText(currency.ratioBuyText),
        askText: normalizeStoredNumericText(currency.ratioSellText),
        source: currency.priceUpdateMode === 'internet' ? 'internet' : 'manual',
        status: 'active',
        effectiveAt: Date.now(),
        updatedAt: Date.now()
      };
      const existingIndex = records.findIndex((record) => `${record.bookCode}:${record.pairId}` === key);
      if(existingIndex >= 0) records[existingIndex] = { ...records[existingIndex], ...nextRecord };
      else records.push(nextRecord);
      seen.add(key);
    });

    return records;
  }

  function sanitizePricingState(raw, currencies, activeBookCode){
    const rateBooks = createRateBooks(raw && raw.rateBooks || raw && raw.books);
    const resolvedActiveBookCode = resolveActiveBookCode(raw && raw.activeRateBookCode || activeBookCode, rateBooks);
    const pairRegistry = sanitizePairRegistry(raw && raw.pairRegistry || raw && raw.pairs, currencies);
    const rateRecords = sanitizeRateRecords(raw && raw.rateRecords || raw && raw.records, pairRegistry, resolvedActiveBookCode, currencies);
    return { rateBooks, activeRateBookCode: resolvedActiveBookCode, pairRegistry, rateRecords };
  }

  function applyLegacyShadowFields(state){
    const counterpart = getCounterpartCurrencyFromState(state);
    const usdAgainstCounterpart = readOperationalQuote(state, SYSTEM_CURRENCY_CODE, counterpart.code) || { bid: 1, ask: 1 };

    state.currencies = state.currencies.map((currency) => {
      if(currency.code === SYSTEM_CURRENCY_CODE){
        return {
          ...currency,
          usdConvention: 'identity',
          method: 'multiply',
          ratioBuy: 1,
          ratioSell: 1,
          buy: counterpart.code === SYSTEM_CURRENCY_CODE ? 1 : usdAgainstCounterpart.bid,
          sell: counterpart.code === SYSTEM_CURRENCY_CODE ? 1 : usdAgainstCounterpart.ask
        };
      }
      const usdManualQuote = getUsdManualQuote(state, currency.code);
      return {
        ...currency,
        usdConvention: usdManualQuote.usdConvention,
        method: conventionToLegacyMethod(usdManualQuote.usdConvention),
        ratioBuy: usdManualQuote.bid,
        ratioSell: usdManualQuote.ask
      };
    });

    return state;
  }

  function sanitizeState(input){
    const fallback = clone(DEFAULT_CURRENCIES);
    const raw = input && typeof input === 'object' ? input : {};
    const isAuthoritativeOnlineEmpty = raw.__taifOnlineEmpty === true || raw.__taifFactoryResetEmpty === true;
    const rawCurrencies = Array.isArray(raw.currencies) && (raw.currencies.length || isAuthoritativeOnlineEmpty)
      ? (isAuthoritativeOnlineEmpty ? raw.currencies : upgradeLegacyDefaultCurrencyCatalog(raw.currencies, raw.version))
      : null;
    const list = isAuthoritativeOnlineEmpty
      ? (rawCurrencies || [])
      : (shouldReplaceLegacyDefaultCurrencyCatalog(rawCurrencies, raw.version)
        ? fallback
        : (rawCurrencies && rawCurrencies.length ? rawCurrencies : fallback));
    const seenCodes = new Set();
    const currencies = [];

    list.forEach((item, index) => {
      const sanitized = sanitizeCurrencyMaster(item, index);
      if(!sanitized) return;
      if(seenCodes.has(sanitized.code)) return;
      seenCodes.add(sanitized.code);
      currencies.push(sanitized);
    });

    // في الوضع Online وبعد Reset/قاعدة فارغة لا نعيد كتالوج العملات القديمة كله.
    // نُبقي USD فقط كعملة نظام حتى لا تنكسر الحسابات، وتبقى باقي العملات فارغة إلى أن يضيفها المستخدم.
    if(!seenCodes.has(SYSTEM_CURRENCY_CODE)){
      currencies.unshift(sanitizeCurrencyMaster(getDefaultCurrency(SYSTEM_CURRENCY_CODE) || fallback[0], 0));
      seenCodes.add(SYSTEM_CURRENCY_CODE);
    }

    const usd = currencies.find((currency) => currency.code === SYSTEM_CURRENCY_CODE) || sanitizeCurrencyMaster(getDefaultCurrency(SYSTEM_CURRENCY_CODE) || fallback[0], 0);
    const others = currencies.filter((currency) => currency.code !== SYSTEM_CURRENCY_CODE);
    const orderedCurrencies = syncLegacyZeroLinkedCurrencies([usd, ...others]);

    const pricing = sanitizePricingState(raw, orderedCurrencies, raw.activeRateBookCode || DEFAULT_ACTIVE_BOOK_CODE);
    const counterpartSeed = shouldMigrateLegacyDefaultCounterpart(raw, orderedCurrencies, raw.version)
      ? DEFAULT_COUNTERPART_CURRENCY_CODE
      : raw.counterpartCode;
    const state = {
      version: CURRENCY_DEFAULTS_VERSION,
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : Date.now(),
      systemCurrencyCode: SYSTEM_CURRENCY_CODE,
      counterpartCode: resolveCounterpartCode(counterpartSeed, orderedCurrencies),
      activeRateBookCode: pricing.activeRateBookCode,
      rateBooks: pricing.rateBooks,
      pairRegistry: pricing.pairRegistry,
      rateRecords: pricing.rateRecords,
      currencies: orderedCurrencies
    };
    if(isAuthoritativeOnlineEmpty) state.__taifOnlineEmpty = true;

    return applyLegacyShadowFields(state);
  }

  function snapshotStateForComparison(value){
    try{
      return JSON.stringify(value);
    }catch{
      return '';
    }
  }

  function persistSanitizedStateSilently(rawState, sanitizedState){
    if(!rawState || typeof rawState !== 'object' || !sanitizedState || typeof sanitizedState !== 'object') return;
    // في وضع الأونلاين لا يجوز أن تتحول قراءة الشاشة إلى كتابة صامتة على قاعدة البيانات؛
    // هذا كان يسبب رجوع بيانات افتراضية/قديمة عند دخول مستخدم جديد أو عند استقبال تحديث من مستخدم آخر.
    // الحفظ يتم فقط من أفعال صريحة مثل زر حفظ/إضافة/حذف.
    try{
      const sync = window.TAIF?.online?.domainSync;
      if(sync && typeof sync.isBusinessKey === 'function' && sync.isBusinessKey(MODULE_KEY)) return;
    }catch{}
    const rawSnapshot = snapshotStateForComparison(rawState);
    const sanitizedSnapshot = snapshotStateForComparison(sanitizedState);
    if(!rawSnapshot || !sanitizedSnapshot || rawSnapshot === sanitizedSnapshot) return;
    try{
      writeModuleState(sanitizedState);
    }catch{}
  }

  function readState(){
    const stored = TAIF.core.utils.readLocalState(MODULE_KEY, null);
    if(!stored) return sanitizeState(createDefaultState());
    const sanitized = sanitizeState(stored);
    persistSanitizedStateSilently(stored, sanitized);
    return sanitized;
  }

  function writeState(nextState){
    const sanitized = sanitizeState(nextState);
    sanitized.updatedAt = Date.now();
    writeModuleState(sanitized);
    if(typeof notifyStateChange === 'function') notifyStateChange(sanitized);
    return sanitized;
  }

  function resetState(){
    return writeState(createDefaultState());
  }

  function ensureState(stateInput){
    if(stateInput && typeof stateInput === 'object' && Array.isArray(stateInput.currencies) && Array.isArray(stateInput.rateRecords) && Array.isArray(stateInput.rateBooks)) return stateInput;
    return sanitizeState(stateInput);
  }

  function getCounterpartCurrencyFromState(stateInput){
    const state = ensureState(stateInput);
    const currencies = Array.isArray(state.currencies) ? state.currencies : [];
    const counterpartCode = resolveCounterpartCode(state.counterpartCode, currencies);
    return currencies.find((currency) => currency.code === counterpartCode)
      || currencies.find((currency) => currency.code === SYSTEM_CURRENCY_CODE)
      || sanitizeCurrencyMaster(getDefaultCurrency(SYSTEM_CURRENCY_CODE) || DEFAULT_CURRENCIES[0], 0);
  }

  function getCounterpartCurrency(stateInput){
    return getCounterpartCurrencyFromState(ensureState(stateInput));
  }

  function getCounterpartOptions(stateInput){
    const state = ensureState(stateInput);
    const seen = new Set();
    const ordered = [];
    const pushCurrency = (currency) => {
      if(!currency || !currency.code) return;
      const code = normalizeCode(currency.code);
      if(!code || seen.has(code)) return;
      seen.add(code);
      ordered.push(currency);
    };
    pushCurrency(state.currencies.find((currency) => currency.code === SYSTEM_CURRENCY_CODE));
    state.currencies.forEach(pushCurrency);
    return ordered;
  }

  function getActiveBookCode(stateInput){
    const state = ensureState(stateInput);
    return resolveActiveBookCode(state.activeRateBookCode, state.rateBooks);
  }

  function getActiveRateBook(stateInput){
    const state = ensureState(stateInput);
    const activeCode = getActiveBookCode(state);
    return (Array.isArray(state.rateBooks) ? state.rateBooks : []).find((book) => normalizeCode(book && book.code) === activeCode)
      || clone(DEFAULT_RATE_BOOKS.find((book) => normalizeCode(book.code) === activeCode) || DEFAULT_RATE_BOOKS[0]);
  }

  function getDollarHeaderText(field = 'buy'){
    return field === 'sell'
      ? 'مبيع / الدولار الأمريكي'
      : 'شراء / الدولار الأمريكي';
  }

  function getCounterpartRatioHeaderText(_counterpart, field = 'buy'){
    return getDollarHeaderText(field);
  }

  function getUsdPairDefinition(stateInput, currencyCode){
    const state = ensureState(stateInput);
    const safeCode = normalizeCode(currencyCode);
    const currency = state.currencies.find((item) => item.code === safeCode);
    if(!currency || safeCode === SYSTEM_CURRENCY_CODE) return null;
    const pair = buildUsdPairDefinition(currency);
    return pair ? {
      ...pair,
      bookCode: getActiveBookCode(state)
    } : null;
  }

  function findRateRecord(stateInput, pairIdentifier, bookCode = null){
    const state = ensureState(stateInput);
    const safePairId = String(pairIdentifier || '').trim().toUpperCase();
    const safeBookCode = normalizeCode(bookCode || state.activeRateBookCode || DEFAULT_ACTIVE_BOOK_CODE);
    const candidates = (Array.isArray(state.rateRecords) ? state.rateRecords : []).filter((record) => record && record.pairId === safePairId && record.bookCode === safeBookCode);
    if(!candidates.length) return null;
    candidates.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const latest = candidates[0];
    return {
      ...latest,
      bid: getPositiveRate(latest.bid, 1),
      ask: getPositiveRate(latest.ask, getPositiveRate(latest.bid, 1)),
      bidText: normalizeStoredNumericText(latest.bidText),
      askText: normalizeStoredNumericText(latest.askText)
    };
  }

  function readOperationalQuote(stateInput, baseCode, quoteCode, depth = 0){
    const state = ensureState(stateInput);
    const safeBase = normalizeCode(baseCode);
    const safeQuote = normalizeCode(quoteCode);
    const safeBookCode = getActiveBookCode(state);
    if(!safeBase || !safeQuote) return null;
    if(safeBase === safeQuote) return { bid: 1, ask: 1, bidText: '1', askText: '1', derived: true, via: 'identity' };
    if(depth > 4) return null;

    const fixedLegacyRelation = getLegacyZeroFixedRelation(state, safeBase, safeQuote);
    if(fixedLegacyRelation){
      return {
        bid: fixedLegacyRelation.bid,
        ask: fixedLegacyRelation.ask,
        bidText: fixedLegacyRelation.bidText,
        askText: fixedLegacyRelation.askText,
        derived: true,
        fixed: true,
        via: fixedLegacyRelation.via,
        pairId: pairId(safeBase, safeQuote),
        rootCode: fixedLegacyRelation.rootCode
      };
    }

    const direct = findRateRecord(state, pairId(safeBase, safeQuote), safeBookCode);
    if(direct){
      const normalized = normalizeBidAsk(direct.bid, direct.ask, 1);
      return {
        bid: normalized.bid,
        ask: normalized.ask,
        bidText: normalizeStoredNumericText(direct.bidText),
        askText: normalizeStoredNumericText(direct.askText),
        derived: false,
        via: 'direct',
        pairId: direct.pairId
      };
    }

    const inverse = findRateRecord(state, pairId(safeQuote, safeBase), safeBookCode);
    if(inverse){
      return {
        ...invertQuote(inverse),
        bidText: '',
        askText: '',
        derived: true,
        via: 'inverse',
        pairId: inverse.pairId
      };
    }

    const pivot = normalizeCode(state.systemCurrencyCode || SYSTEM_CURRENCY_CODE) || SYSTEM_CURRENCY_CODE;
    if(safeBase === pivot || safeQuote === pivot) return null;

    const legA = readOperationalQuote(state, safeBase, pivot, depth + 1);
    const legB = readOperationalQuote(state, pivot, safeQuote, depth + 1);
    if(!legA || !legB) return null;

    const combined = multiplyQuotes(legA, legB);
    if(!combined) return null;

    return {
      bid: combined.bid,
      ask: combined.ask,
      bidText: '',
      askText: '',
      derived: true,
      via: 'pivot'
    };
  }

  function upsertUsdPairRecord(stateInput, currencyCode, rawBuy, rawSell, usdConvention = null, displayText = {}){
    const state = clone(ensureState(stateInput));
    const safeCode = normalizeCode(currencyCode);
    if(!safeCode || safeCode === SYSTEM_CURRENCY_CODE) return state;

    const nextBidText = normalizeStoredNumericText(displayText && displayText.bidText);
    const nextAskText = normalizeStoredNumericText(displayText && displayText.askText);
    const currencies = state.currencies.map((currency) => {
      if(currency.code !== safeCode) return currency;
      const convention = normalizeUsdConvention(usdConvention || currency.usdConvention, currency.method);
      const normalized = normalizeBidAsk(rawBuy, rawSell, 1);
      return {
        ...currency,
        usdConvention: convention,
        method: conventionToLegacyMethod(convention),
        ratioBuy: normalized.bid,
        ratioSell: normalized.ask,
        ratioBuyText: nextBidText,
        ratioSellText: nextAskText
      };
    });

    const nextState = sanitizeState({ ...state, currencies });
    return nextState;
  }

  function getUsdManualQuote(stateInput, currencyCode){
    const state = ensureState(stateInput);
    const safeCode = normalizeCode(currencyCode);
    if(!safeCode || safeCode === SYSTEM_CURRENCY_CODE){
      return {
        currencyCode: SYSTEM_CURRENCY_CODE,
        pairId: pairId(SYSTEM_CURRENCY_CODE, SYSTEM_CURRENCY_CODE),
        baseCode: SYSTEM_CURRENCY_CODE,
        quoteCode: SYSTEM_CURRENCY_CODE,
        usdConvention: 'identity',
        bid: 1,
        ask: 1,
        bidText: '1',
        askText: '1'
      };
    }

    const pair = getUsdPairDefinition(state, safeCode);
    const record = pair ? findRateRecord(state, pair.id, pair.bookCode) : null;
    const fallbackCurrency = state.currencies.find((currency) => currency.code === safeCode);
    const fallbackQuote = normalizeBidAsk(fallbackCurrency && fallbackCurrency.ratioBuy, fallbackCurrency && fallbackCurrency.ratioSell, 1);
    const normalized = normalizeBidAsk(record && record.bid, record && record.ask, fallbackQuote.bid);

    return {
      currencyCode: safeCode,
      pairId: pair && pair.id || pairId(safeCode, SYSTEM_CURRENCY_CODE),
      baseCode: pair && pair.baseCode || safeCode,
      quoteCode: pair && pair.quoteCode || SYSTEM_CURRENCY_CODE,
      usdConvention: pair && pair.usdConvention || normalizeUsdConvention(fallbackCurrency && fallbackCurrency.usdConvention, fallbackCurrency && fallbackCurrency.method),
      bid: normalized.bid,
      ask: normalized.ask,
      bidText: normalizeStoredNumericText(record && record.bidText || fallbackCurrency && fallbackCurrency.ratioBuyText),
      askText: normalizeStoredNumericText(record && record.askText || fallbackCurrency && fallbackCurrency.ratioSellText)
    };
  }

  function getUsdAgainstCounterpartQuote(stateInput){
    const state = ensureState(stateInput);
    const counterpart = getCounterpartCurrencyFromState(state);
    if(counterpart.code === SYSTEM_CURRENCY_CODE){
      return { bid: 1, ask: 1, bidText: '1', askText: '1', pairId: pairId(SYSTEM_CURRENCY_CODE, SYSTEM_CURRENCY_CODE), derived: true };
    }
    return readOperationalQuote(state, SYSTEM_CURRENCY_CODE, counterpart.code) || { bid: 1, ask: 1, bidText: '', askText: '', pairId: pairId(SYSTEM_CURRENCY_CODE, counterpart.code), derived: true };
  }

  function setUsdAgainstCounterpartQuote(stateInput, { buy, sell, buyText = '', sellText = '' }){
    const state = ensureState(stateInput);
    const counterpart = getCounterpartCurrencyFromState(state);
    if(counterpart.code === SYSTEM_CURRENCY_CODE) return state;

    const normalized = normalizeBidAsk(buy, sell, 1);
    const counterpartQuote = getUsdPairDefinition(state, counterpart.code);
    if(!counterpartQuote) return state;

    if(counterpartQuote.usdConvention === 'usd-base'){
      return upsertUsdPairRecord(state, counterpart.code, normalized.bid, normalized.ask, counterpartQuote.usdConvention, { bidText: buyText, askText: sellText });
    }

    const inverse = invertQuote(normalized);
    return upsertUsdPairRecord(state, counterpart.code, inverse.bid, inverse.ask, counterpartQuote.usdConvention);
  }

  function getCounterpartCrossQuote(stateInput, currencyCode){
    const state = ensureState(stateInput);
    const counterpart = getCounterpartCurrencyFromState(state);
    const safeCode = normalizeCode(currencyCode);
    if(!safeCode || safeCode === counterpart.code) return null;
    if(counterpart.code === SYSTEM_CURRENCY_CODE) return getUsdManualQuote(state, safeCode);
    return readOperationalQuote(state, safeCode, counterpart.code);
  }

  function setCounterpartCrossQuote(stateInput, currencyCode, { buy, sell, buyText = '', sellText = '' }){
    const state = ensureState(stateInput);
    const counterpart = getCounterpartCurrencyFromState(state);
    const safeCode = normalizeCode(currencyCode);
    if(!safeCode || safeCode === counterpart.code) return state;
    if(getLegacyZeroFixedRelation(state, safeCode, counterpart.code)) return state;

    const normalizedCross = normalizeBidAsk(buy, sell, 1);
    if(counterpart.code === SYSTEM_CURRENCY_CODE){
      return upsertUsdPairRecord(state, safeCode, normalizedCross.bid, normalizedCross.ask, null, { bidText: buyText, askText: sellText });
    }

    if(safeCode === SYSTEM_CURRENCY_CODE){
      return setUsdAgainstCounterpartQuote(state, { buy: normalizedCross.bid, sell: normalizedCross.ask, buyText, sellText });
    }

    const usdAgainstCounterpart = readOperationalQuote(state, SYSTEM_CURRENCY_CODE, counterpart.code);
    if(!usdAgainstCounterpart) return state;

    const xToUsd = divideQuotes(normalizedCross, usdAgainstCounterpart);
    if(!xToUsd) return state;

    const usdPair = getUsdPairDefinition(state, safeCode);
    if(!usdPair) return state;

    if(usdPair.usdConvention === 'currency-base'){
      return upsertUsdPairRecord(state, safeCode, xToUsd.bid, xToUsd.ask, usdPair.usdConvention);
    }

    const inverted = invertQuote(xToUsd);
    return upsertUsdPairRecord(state, safeCode, inverted.bid, inverted.ask, usdPair.usdConvention);
  }

  function computeRows(stateInput){
    const state = ensureState(stateInput);
    const counterpart = getCounterpartCurrencyFromState(state);
    const activeBook = getActiveRateBook(state);

    return state.currencies.map((currency) => {
      const usdManualQuote = getUsdManualQuote(state, currency.code);
      const usdOperationalQuote = readOperationalQuote(state, currency.code, SYSTEM_CURRENCY_CODE) || { bid: 1, ask: 1 };
      const counterpartFixedRelation = currency.code === counterpart.code
        ? null
        : getLegacyZeroFixedRelation(state, currency.code, counterpart.code);
      const counterpartOperationalQuote = currency.code === counterpart.code
        ? null
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? readOperationalQuote(state, currency.code, counterpart.code) || usdOperationalQuote
          : readOperationalQuote(state, currency.code, counterpart.code));

      const internalBuy = counterpartOperationalQuote ? counterpartOperationalQuote.bid : null;
      const internalSell = counterpartOperationalQuote ? counterpartOperationalQuote.ask : null;
      const internalMiddle = counterpartOperationalQuote ? ((counterpartOperationalQuote.bid + counterpartOperationalQuote.ask) / 2) : null;
      const displayDollarBuy = usdManualQuote.bid;
      const displayDollarSell = usdManualQuote.ask;
      const displayDollarBuyText = normalizeStoredNumericText(usdManualQuote.bidText);
      const displayDollarSellText = normalizeStoredNumericText(usdManualQuote.askText);
      const shouldMirrorLegacySourceDisplay = Boolean(
        counterpartFixedRelation
        && counterpart.code !== SYSTEM_CURRENCY_CODE
        && currency.rateMode === LEGACY_ZERO_DROP_MODE
        && normalizeCode(currency.legacySourceCode) === normalizeCode(counterpart.code)
      );
      const shouldShowUsdQuoteForCounterpart = currency.code === counterpart.code;
      const displayBuy = shouldShowUsdQuoteForCounterpart
        ? displayDollarBuy
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? displayDollarBuy
          : (shouldMirrorLegacySourceDisplay ? displayDollarBuy : internalBuy));
      const displaySell = shouldShowUsdQuoteForCounterpart
        ? displayDollarSell
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? displayDollarSell
          : (shouldMirrorLegacySourceDisplay ? displayDollarSell : internalSell));
      const displayBuyText = shouldShowUsdQuoteForCounterpart
        ? displayDollarBuyText
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? displayDollarBuyText
          : (shouldMirrorLegacySourceDisplay
              ? displayDollarBuyText
              : normalizeStoredNumericText(counterpartOperationalQuote && counterpartOperationalQuote.bidText)));
      const displaySellText = shouldShowUsdQuoteForCounterpart
        ? displayDollarSellText
        : (counterpart.code === SYSTEM_CURRENCY_CODE
          ? displayDollarSellText
          : (shouldMirrorLegacySourceDisplay
              ? displayDollarSellText
              : normalizeStoredNumericText(counterpartOperationalQuote && counterpartOperationalQuote.askText)));
      const displayMiddle = (displayBuy !== null && displaySell !== null)
        ? ((displayBuy + displaySell) / 2)
        : null;

      const currencyDecimals = clampDecimals(currency.decimals ?? 0);
      const counterpartDecimals = clampDecimals(counterpart && counterpart.decimals !== undefined ? counterpart.decimals : 0);
      const fieldDecimals = {
        buy: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'buy' }),
        sell: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'sell' }),
        middle: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'middle' }),
        dollarBuy: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'dollarBuy' }),
        dollarSell: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'dollarSell' }),
        ratioBuy: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'ratioBuy' }),
        ratioSell: resolveCurrencyFieldDecimals({ currencyDecimals, counterpartDecimals, field: 'ratioSell' })
      };

      return {
        ...currency,
        buy: internalBuy,
        sell: internalSell,
        middle: internalMiddle,
        displayBuy,
        displaySell,
        displayBuyText,
        displaySellText,
        displayMiddle,
        dollarBuy: currency.code === SYSTEM_CURRENCY_CODE ? 1 : usdOperationalQuote.bid,
        dollarSell: currency.code === SYSTEM_CURRENCY_CODE ? 1 : usdOperationalQuote.ask,
        displayDollarBuy,
        displayDollarSell,
        displayDollarBuyText,
        displayDollarSellText,
        currencyDecimals,
        counterpartDecimals,
        fieldDecimals,
        usdPairId: usdManualQuote.pairId,
        usdPairLabel: formatPairCode(usdManualQuote.baseCode, usdManualQuote.quoteCode, usdManualQuote.pairId),
        counterpartPairLabel: currency.code === counterpart.code ? null : formatPairCode(currency.code, counterpart.code),
        usdConvention: usdManualQuote.usdConvention,
        usdBaseCode: usdManualQuote.baseCode,
        usdQuoteCode: usdManualQuote.quoteCode,
        activeRateBookCode: activeBook.code,
        activeRateBookName: activeBook.name,
        isUsd: currency.code === SYSTEM_CURRENCY_CODE,
        isCounterpart: currency.code === counterpart.code,
        counterpartCode: counterpart.code,
        counterpartName: counterpart.name,
        counterpartFlag: counterpart.flag,
        counterpartPricingLocked: Boolean(counterpartFixedRelation),
        counterpartPricingMode: counterpartFixedRelation ? counterpartFixedRelation.via : null,
        counterpartFixedRate: counterpartFixedRelation ? counterpartFixedRelation.bid : null,
        counterpartFixedRootCode: counterpartFixedRelation ? counterpartFixedRelation.rootCode : null,
        counterpartDisplayMode: shouldMirrorLegacySourceDisplay ? 'legacy-shadow-from-usd' : null
      };
    });
  }

  function auditState(stateInput){
    const state = ensureState(stateInput);
    const errors = [];
    const warnings = [];
    const rateBooks = Array.isArray(state.rateBooks) ? state.rateBooks : [];
    const currencies = Array.isArray(state.currencies) ? state.currencies : [];
    const pairRegistry = Array.isArray(state.pairRegistry) ? state.pairRegistry : [];
    const rateRecords = Array.isArray(state.rateRecords) ? state.rateRecords : [];
    const seenCurrencyCodes = new Set();
    const seenPairIds = new Set();
    const seenRecordKeys = new Set();
    const rateBookCodes = new Set();

    rateBooks.forEach((book) => {
      const code = normalizeCode(book && book.code);
      if(!code){
        errors.push('يوجد كتاب أسعار بدون كود صالح.');
        return;
      }
      if(rateBookCodes.has(code)) warnings.push(`يوجد كتاب أسعار مكرر بالكود ${code}.`);
      rateBookCodes.add(code);
    });

    if(!rateBookCodes.has(getActiveBookCode(state))){
      errors.push('كتاب الأسعار النشط غير موجود داخل تعريف كتب الأسعار.');
    }

    currencies.forEach((currency) => {
      const code = normalizeCode(currency && currency.code);
      if(!code){
        errors.push('يوجد سجل عملة بدون كود صالح.');
        return;
      }
      if(seenCurrencyCodes.has(code)) warnings.push(`يوجد تكرار منطقي للعملة ${code} داخل الحالة الحالية.`);
      seenCurrencyCodes.add(code);
      if(clampDecimals(currency && currency.decimals) !== Number(currency && currency.decimals)){
        warnings.push(`تم تطبيع عداد المنازل العشرية للعملة ${code} إلى المجال المسموح 0 - 6.`);
      }
      if(currency && currency.rateMode === LEGACY_ZERO_DROP_MODE){
        const sourceCode = normalizeCode(currency.legacySourceCode);
        if(!sourceCode){
          errors.push(`العملة ${code} مفعّل لها خيار حذف الأصفار بدون تحديد العملة القديمة المرجعية.`);
          return;
        }
        if(sourceCode === code){
          errors.push(`لا يمكن ربط العملة ${code} بنفسها داخل وضع حذف الأصفار.`);
          return;
        }
        const sourceCurrency = currencies.find((item) => normalizeCode(item && item.code) === sourceCode);
        if(!sourceCurrency){
          errors.push(`العملة ${code} مرتبطة بالعملة ${sourceCode} لكنها غير موجودة ضمن إدارة العملات.`);
          return;
        }
        if(sourceCurrency.rateMode === LEGACY_ZERO_DROP_MODE){
          errors.push(`لا يمكن ربط العملة ${code} بعملة مشتقة أخرى (${sourceCode}). اختر عملة أصلية مباشرة.`);
        }
      }
    });

    if(!seenCurrencyCodes.has(SYSTEM_CURRENCY_CODE)){
      errors.push('الدولار الأمريكي مفقود من قائمة العملات الأساسية.');
    }

    pairRegistry.forEach((pair) => {
      const id = String(pair && pair.id || '').trim().toUpperCase();
      const baseCode = normalizeCode(pair && pair.baseCode);
      const quoteCode = normalizeCode(pair && pair.quoteCode);
      if(!id || !baseCode || !quoteCode || baseCode === quoteCode){
        errors.push('يوجد تعريف زوج عملات غير صالح داخل السجل التشغيلي.');
        return;
      }
      if(seenPairIds.has(id)) warnings.push(`يوجد تعريف زوج مكرر للزوج ${id}.`);
      seenPairIds.add(id);
      if(!seenCurrencyCodes.has(baseCode) || !seenCurrencyCodes.has(quoteCode)){
        errors.push(`الزوج ${id} يشير إلى عملة غير موجودة داخل الحالة.`);
      }
    });

    rateRecords.forEach((record) => {
      const bookCode = normalizeCode(record && record.bookCode);
      const recordPairId = String(record && record.pairId || '').trim().toUpperCase();
      const key = `${bookCode}:${recordPairId}`;
      if(seenRecordKeys.has(key)) warnings.push(`يوجد سجل مكرر للزوج ${recordPairId} داخل الكتاب ${bookCode}.`);
      seenRecordKeys.add(key);
      if(!rateBookCodes.has(bookCode)) errors.push(`الزوج ${recordPairId} مرتبط بكتاب أسعار غير موجود (${bookCode}).`);
      if(!seenPairIds.has(recordPairId)) errors.push(`يوجد سجل أسعار لزوج غير معرف داخل السجل التشغيلي (${recordPairId}).`);
      if(!(record.bid > 0) || !(record.ask > 0)) errors.push(`الزوج ${recordPairId} يحتوي على سعر غير صالح.`);
      if(record.bid > record.ask) errors.push(`الزوج ${recordPairId} يحتوي على شراء أكبر من المبيع.`);
    });

    currencies.forEach((currency) => {
      if(currency.code === SYSTEM_CURRENCY_CODE) return;
      const pair = getUsdPairDefinition(state, currency.code);
      const record = pair ? findRateRecord(state, pair.id, state.activeRateBookCode) : null;
      if(!pair || !record){
        errors.push(`لا يوجد زوج تشغيلي معرف للعملة ${currency.code} مقابل الدولار.`);
      }
    });

    const counterpartCode = normalizeCode(state.counterpartCode);
    if(counterpartCode && !seenCurrencyCodes.has(counterpartCode)){
      errors.push('عملة التسعير المتقاطع الحالية غير موجودة ضمن العملات المعرفة.');
    }

    return { errors, warnings };
  }

  function formatManagementCellValue(row, field, maxAutoDecimals = 6){
    const safeRow = row && typeof row === 'object' ? row : {};
    const displayTextFieldMap = {
      buy: 'displayBuyText',
      sell: 'displaySellText',
      dollarBuy: 'displayDollarBuyText',
      dollarSell: 'displayDollarSellText'
    };
    const displayFieldMap = {
      buy: 'displayBuy',
      sell: 'displaySell',
      middle: 'displayMiddle',
      dollarBuy: 'displayDollarBuy',
      dollarSell: 'displayDollarSell'
    };
    const rawText = displayTextFieldMap[field] ? safeRow[displayTextFieldMap[field]] : '';
    const preferredField = displayFieldMap[field];
    const value = preferredField && Object.prototype.hasOwnProperty.call(safeRow, preferredField)
      ? safeRow[preferredField]
      : safeRow[field];
    const numericValue = toNumber(value, Number.NaN);
    if(value === null || value === undefined || !Number.isFinite(numericValue)) return '—';

    const fieldDecimals = safeRow.fieldDecimals && Object.prototype.hasOwnProperty.call(safeRow.fieldDecimals, field)
      ? safeRow.fieldDecimals[field]
      : safeRow.decimals;
    const safeRawText = normalizeStoredNumericText(rawText, { allowDecimal: true, allowNegative: true });
    const quoteLikeField = field === 'buy'
      || field === 'sell'
      || field === 'middle'
      || field === 'dollarBuy'
      || field === 'dollarSell'
      || field === 'ratioBuy'
      || field === 'ratioSell';
    const shouldRelaxConfiguredDecimals = quoteLikeField
      && !safeRawText
      && clampDecimals(fieldDecimals) === 0
      && Math.abs(numericValue) > 0
      && Math.abs(numericValue) < 10;

    if(typeof formatCurrencyNumericDisplay === 'function'){
      return formatCurrencyNumericDisplay(numericValue, {
        rawText: safeRawText,
        decimals: fieldDecimals,
        maxAutoDecimals,
        mode: field === 'middle' ? 'mid' : 'rate',
        fallback: '—',
        respectConfiguredDecimals: !shouldRelaxConfiguredDecimals
      });
    }

    return feature.formatDynamic(numericValue, maxAutoDecimals);
  }

  Object.assign(feature, {
    SYSTEM_CURRENCY_CODE,
    DEFAULT_ACTIVE_BOOK_CODE,
    DEFAULT_RATE_BOOKS,
    createDefaultState,
    sanitizeState,
    readState,
    writeState,
    resetState,
    getCounterpartCurrencyFromState,
    getCounterpartCurrency,
    getCounterpartDisplayName,
    getCounterpartHeaderText,
    getCounterpartRatioHeaderText,
    getDollarHeaderText,
    getCounterpartOptions,
    getActiveBookCode,
    getActiveRateBook,
    getUsdPairDefinition,
    getUsdManualQuote,
    getUsdAgainstCounterpartQuote,
    setUsdAgainstCounterpartQuote,
    getCounterpartCrossQuote,
    setCounterpartCrossQuote,
    readOperationalQuote,
    computeRows,
    auditState,
    formatManagementCellValue
  });
})();
