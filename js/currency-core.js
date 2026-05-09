(()=>{
  /*
   * TAIF Currency feature core.
   * Shared state, calculations, and flag helpers for Currency Management and Price Screen.
   */
  const TAIF = window.TAIF;
  const { clone, escapeHtml } = TAIF.core.utils;
  const feature = TAIF.currencyManagementFeature || (TAIF.currencyManagementFeature = {});
  const moduleKeys = TAIF?.core?.moduleKeys || {};
  const MODULE_KEY = moduleKeys.currencyDomain || moduleKeys.currencyManagement || 'taif-currency-management-module-v1';
  const runtime = feature.runtime || (feature.runtime = {
    panel: null,
    filter: '',
    selectedCode: null,
    rowInteractionGuardUntil: 0,
    bulkFilter: '',
    toastTimer: null,
    modalLayer: null,
    modalStack: [],
    modalZIndex: 2398,
    modalSequence: 0,
    modalCascadeSlots: 6,
    textSelectionGuardBound: false,
    counterpartPickerCleanup: null,
    topbarFitCleanup: null,
    mainHeaderFitCleanup: null,
    bulkHeaderFitCleanup: null
  });

  // ---------------------------------------------------------------------------
  // Reference data
  // ---------------------------------------------------------------------------
  const DEFAULT_CURRENCIES = [
    { code: 'USD', name: 'الدولار الأمريكي', flag: 'us', buy: 1, sell: 1, ratioBuy: 1, ratioSell: 1, method: 'multiply', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'EUR', name: 'اليورو الأوروبي', flag: 'eu', ratioBuy: 1.15, ratioSell: 1.16, method: 'multiply', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'SYP', name: 'الليرة السورية', flag: 'sy', ratioBuy: 11000, ratioSell: 11500, method: 'divide', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'TRY', name: 'الليرة التركية', flag: 'tr', ratioBuy: 40, ratioSell: 45, method: 'divide', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'SAR', name: 'الريال السعودي', flag: 'sa', ratioBuy: 3.7, ratioSell: 3.75, method: 'divide', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'AED', name: 'الدرهم الإماراتي', flag: 'ae', ratioBuy: 3.7, ratioSell: 3.75, method: 'divide', decimals: 0, priceUpdateMode: 'manual' },
    { code: 'JOD', name: 'الدينار الأردني', flag: 'jo', ratioBuy: 1.35, ratioSell: 1.4, method: 'multiply', decimals: 0, priceUpdateMode: 'manual' }
  ];
  const DEFAULT_COUNTERPART_CURRENCY_CODE = 'SYP';

  const LEGACY_ZERO_DROP_MODE = 'legacy-zero-drop';
  const LEGACY_ZERO_DROP_SHIFT = 2;
  const LEGACY_ZERO_DROP_DIVISOR = 10 ** LEGACY_ZERO_DROP_SHIFT;

  const CALCULATION_METHOD_OPTIONS = [
    { value: 'multiply', label: 'ضرب' },
    { value: 'divide', label: 'قسمة' },
    { value: LEGACY_ZERO_DROP_MODE, label: 'حذف اصفار عملة قديمة' }
  ];

  const PRICE_UPDATE_MODE_OPTIONS = [
    { value: 'manual', label: 'يدوي' },
    { value: 'internet', label: 'عبر الانترنت' }
  ];

  const DECIMAL_PLACES_OPTIONS = Array.from({ length: 7 }, (_, index) => ({
    value: String(index),
    label: String(index)
  }));

  const SINGLE_CURRENCY_FORM_PICKERS = [
    {
      pickerSelector: '[data-currency-management-method-picker]',
      triggerSelector: '#currency-management-currency-method-trigger',
      inputSelector: '#currency-management-currency-method',
      valueSelector: '[data-currency-management-method-value]',
      options: CALCULATION_METHOD_OPTIONS,
      ariaLabel: 'طريقة الاحتساب'
    },
    {
      pickerSelector: '[data-currency-management-price-update-mode-picker]',
      triggerSelector: '#currency-management-currency-price-update-mode-trigger',
      inputSelector: '#currency-management-currency-price-update-mode',
      valueSelector: '[data-currency-management-price-update-mode-value]',
      options: PRICE_UPDATE_MODE_OPTIONS,
      ariaLabel: 'طريقة تعديل الأسعار'
    },
    {
      pickerSelector: '[data-currency-management-decimals-picker]',
      triggerSelector: '#currency-management-currency-decimals-trigger',
      inputSelector: '#currency-management-currency-decimals',
      valueSelector: '[data-currency-management-decimals-value]',
      options: DECIMAL_PLACES_OPTIONS,
      ariaLabel: 'عداد المنازل العشرية',
      preferredOpenDirection: 'down',
      maxPopoverHeight: 320,
      viewportBoundary: 'panel'
    }
  ];

  const SINGLE_EDITOR_MODAL_OPTIONS = Object.freeze({
    size: 'md',
    variant: 'grand',
    modalClass: 'taif-currency-management-modal--single-editor',
    bodyClass: 'taif-currency-management-modal__body--single-editor',
    showExpand: true
  });

  const FALLBACK_FLAGS = {
    USD: '🇺🇸',
    EUR: '🇪🇺',
    SAR: '🇸🇦',
    AED: '🇦🇪',
    TRY: '🇹🇷',
    SYP: '🇸🇾',
    JOD: '🇯🇴',
    GBP: '🇬🇧',
    CHF: '🇨🇭',
    SEK: '🇸🇪',
    NOK: '🇳🇴',
    DKK: '🇩🇰',
    KWD: '🇰🇼',
    QAR: '🇶🇦',
    IQD: '🇮🇶',
    EGP: '🇪🇬',
    RUB: '🇷🇺',
    CNY: '🇨🇳'
  };


  const BULK_EDITOR_TITLE = 'تعديل كافة العملات';
  const TOOLBAR_BUTTONS = [
    { action: 'add', label: 'إضافة عملة', tone: 'ghost', icon: 'plus' },
    { action: 'delete-currency', label: 'حذف عملة', tone: 'danger', icon: 'trash' },
    { action: 'counterpart-edit', label: 'تعديل عملة التسعير', tone: 'primary', icon: 'edit' },
    { action: 'edit-single', label: 'تعديل عملة فردي', tone: 'ghost', icon: 'edit' },
    { action: 'bulk', label: BULK_EDITOR_TITLE, tone: 'dark', icon: 'settings' }
  ];

  // ---------------------------------------------------------------------------
  // Core helpers
  // ---------------------------------------------------------------------------
  function writeModuleState(value){
    TAIF.core.utils.onlineStateSet(MODULE_KEY, JSON.stringify(value));
  }

  const {
    clampDecimals,
    getPositiveRate,
    toNumber,
    normalizeStoredNumericText
  } = feature;

  function resolveStoredMethod(value){
    return value === 'divide' ? 'divide' : 'multiply';
  }

  function resolveRateMode(value){
    return String(value || '').trim() === LEGACY_ZERO_DROP_MODE ? LEGACY_ZERO_DROP_MODE : 'manual';
  }

  function getCalculationMethodOptions(currencyCode, { includeLegacyZeroDrop = true } = {}){
    const options = [
      ...getUsdPairDirectionOptions(currencyCode)
    ];
    if(includeLegacyZeroDrop){
      options.push({ value: LEGACY_ZERO_DROP_MODE, label: 'حذف اصفار عملة قديمة' });
    }
    return options;
  }

  function normalizeCode(value){
    return String(value ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  }

  function fallbackFlag(code){
    return FALLBACK_FLAGS[code] || '🏳️';
  }

  function resolveEventElement(target){
    if(target instanceof Element) return target;
    if(typeof Node !== 'undefined' && target instanceof Node && target.nodeType === Node.TEXT_NODE) return target.parentElement;
    return null;
  }

  function isCurrencyManagementSurfaceTarget(target){
    const element = resolveEventElement(target);
    if(!element) return false;
    return Boolean(element.closest('.currency-management-shell, .taif-currency-management-modal, .taif-currency-management-window-layer'));
  }

  function isWritableSelectionTarget(target){
    const sharedCheck = TAIF?.ui?.selectionGuard?.isWritableField;
    if(typeof sharedCheck === 'function') return sharedCheck(target);

    const element = resolveEventElement(target);
    if(!element) return false;

    const editable = element.closest('input, textarea, [contenteditable]');
    if(!editable) return false;

    if(editable instanceof HTMLTextAreaElement){
      return !editable.disabled && !editable.readOnly;
    }

    if(editable instanceof HTMLInputElement){
      const type = String(editable.type || 'text').toLowerCase();
      if(editable.disabled || editable.readOnly) return false;
      return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type);
    }

    const editableState = editable.getAttribute('contenteditable');
    if(editableState === 'false') return false;
    return editable.isContentEditable;
  }

  function clearBrowserTextSelection(){
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if(selection && selection.rangeCount){
      try{
        selection.removeAllRanges();
      }catch{}
    }
  }

  function bindTextSelectionGuard(){
    const sharedBind = TAIF && TAIF.ui && TAIF.ui.selectionGuard && TAIF.ui.selectionGuard.bind;
    if(typeof sharedBind === 'function'){
      sharedBind(document);
      return;
    }

    if(runtime.textSelectionGuardBound) return;
    runtime.textSelectionGuardBound = true;

    document.addEventListener('selectstart', (event) => {
      if(!isCurrencyManagementSurfaceTarget(event.target)) return;
      if(isWritableSelectionTarget(event.target)) return;
      event.preventDefault();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if(!isCurrencyManagementSurfaceTarget(event.target)) return;
      if(isWritableSelectionTarget(event.target)) return;
      clearBrowserTextSelection();
    }, true);
  }

  function getDefaultCurrency(code){
    const normalized = normalizeCode(code);
    const found = DEFAULT_CURRENCIES.find((currency) => currency.code === normalized);
    return found ? clone(found) : null;
  }

  function sanitizeCurrency(input, index = 0){
    const defaultUsd = getDefaultCurrency('USD');
    const raw = input && typeof input === 'object' ? input : {};
    const defaultCurrency = getDefaultCurrency(raw.code) || {};
    const code = normalizeCode(raw.code || defaultCurrency.code || (index === 0 ? 'USD' : ''));
    if(!code) return null;

    const isUsd = code === 'USD';
    const rateMode = isUsd ? 'manual' : resolveRateMode(raw.rateMode);
    const ratioBuyText = isUsd
      ? ''
      : normalizeStoredNumericText(raw.ratioBuyText ?? (typeof raw.ratioBuy === 'string' ? raw.ratioBuy : ''));
    const ratioSellText = isUsd
      ? ''
      : normalizeStoredNumericText(raw.ratioSellText ?? (typeof raw.ratioSell === 'string' ? raw.ratioSell : ''));
    const rateEditedAt = Number(raw.rateEditedAt);
    const sanitized = {
      code,
      name: String(raw.name || defaultCurrency.name || code).trim(),
      flag: resolveStoredFlagCode(raw.flag || defaultCurrency.flag || '', code),
      ratioBuy: isUsd ? 1 : getPositiveRate(raw.ratioBuy ?? defaultCurrency.ratioBuy, 1),
      ratioSell: isUsd ? 1 : getPositiveRate(raw.ratioSell ?? defaultCurrency.ratioSell, 1),
      ratioBuyText,
      ratioSellText,
      method: isUsd ? 'multiply' : resolveStoredMethod(raw.method),
      decimals: clampDecimals(raw.decimals ?? defaultCurrency.decimals ?? 0),
      priceUpdateMode: raw.priceUpdateMode === 'internet' ? 'internet' : 'manual',
      rateMode,
      legacyZeroDropAllowed: !isUsd && Boolean(
        raw.legacyZeroDropAllowed
        || raw.legacyZeroDropEnabled
        || raw.zeroDropCreated
        || raw.rateMode === LEGACY_ZERO_DROP_MODE
        || Number(raw.legacyZeroShift) > 0
        || normalizeCode(raw.legacySourceCode || raw.sourceCurrencyCode || raw.linkedCurrencyCode || '')
      ),
      legacySourceCode: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE
        ? normalizeCode(raw.legacySourceCode || raw.sourceCurrencyCode || raw.linkedCurrencyCode || '')
        : '',
      legacyZeroShift: !isUsd && rateMode === LEGACY_ZERO_DROP_MODE ? LEGACY_ZERO_DROP_SHIFT : 0,
      rateEditedAt: Number.isFinite(rateEditedAt) && rateEditedAt > 0 ? rateEditedAt : 0
    };

    if(isUsd){
      sanitized.buy = getPositiveRate(raw.buy ?? defaultUsd.buy, defaultUsd.buy);
      sanitized.sell = getPositiveRate(raw.sell ?? defaultUsd.sell, defaultUsd.sell);
      sanitized.buyText = normalizeStoredNumericText(raw.buyText ?? (typeof raw.buy === 'string' ? raw.buy : ''));
      sanitized.sellText = normalizeStoredNumericText(raw.sellText ?? (typeof raw.sell === 'string' ? raw.sell : ''));
    }

    return sanitized;
  }

  function pairId(baseCode, quoteCode){
    return `${normalizeCode(baseCode)}/${normalizeCode(quoteCode)}`;
  }

  function formatPairCode(baseCode, quoteCode, fallback = ''){
    const safeBase = normalizeCode(baseCode);
    const safeQuote = normalizeCode(quoteCode);
    if(safeBase && safeQuote) return `${safeBase}/${safeQuote}`;
    return String(fallback || '').trim();
  }

  function normalizeUsdConvention(value, fallbackMethod = 'multiply'){
    const raw = String(value ?? '').trim().toLowerCase();
    if(raw === 'usd-base' || raw === 'usdbase' || raw === 'usd_per_currency') return 'usd-base';
    if(raw === 'currency-base' || raw === 'currencybase' || raw === 'currency_per_usd') return 'currency-base';
    return resolveStoredMethod(fallbackMethod) === 'divide' ? 'usd-base' : 'currency-base';
  }

  function conventionToLegacyMethod(convention){
    return normalizeUsdConvention(convention) === 'usd-base' ? 'divide' : 'multiply';
  }

  function getUsdPairLabelFromConvention(currencyCode, usdConvention, fallbackToken = 'العملة'){
    const safeCode = normalizeCode(currencyCode);
    const token = safeCode || String(fallbackToken || 'العملة').trim() || 'العملة';
    return normalizeUsdConvention(usdConvention) === 'usd-base'
      ? `USD/${token}`
      : `${token}/USD`;
  }

  function getUsdPairDirectionOptions(currencyCode){
    const safeCode = normalizeCode(currencyCode);
    return [
      { value: 'currency-base', label: safeCode ? `${safeCode}/USD` : 'العملة/USD', methodTag: 'ضرب' },
      { value: 'usd-base', label: safeCode ? `USD/${safeCode}` : 'USD/العملة', methodTag: 'تقسيم' }
    ];
  }

  function getUsdPairFieldLabel(_currencyCode, _usdConvention, field = 'buy'){
    return field === 'sell'
      ? 'سعر المبيع مقابل الدولار الأمريكي'
      : 'سعر الشراء مقابل الدولار الأمريكي';
  }

  function getDerivedPairFieldLabel(baseCode, quoteCode, field = 'buy'){
    const pairLabel = formatPairCode(baseCode, quoteCode, '—');
    return field === 'sell'
      ? `سعر مبيع الزوج ${pairLabel}`
      : `سعر شراء الزوج ${pairLabel}`;
  }


  function resolveCounterpartCode(rawCode, currencies = []){
    const availableCodes = new Set((Array.isArray(currencies) ? currencies : []).map((currency) => normalizeCode(currency && currency.code)).filter(Boolean));
    const preferredFallback = availableCodes.has(DEFAULT_COUNTERPART_CURRENCY_CODE)
      ? DEFAULT_COUNTERPART_CURRENCY_CODE
      : (availableCodes.has('USD') ? 'USD' : '');
    const normalized = normalizeCode(rawCode || preferredFallback || DEFAULT_COUNTERPART_CURRENCY_CODE);
    if(normalized && availableCodes.has(normalized)) return normalized;
    if(preferredFallback) return preferredFallback;
    const firstCurrency = (Array.isArray(currencies) ? currencies : []).find((currency) => currency && currency.code);
    return normalizeCode(firstCurrency && firstCurrency.code) || preferredFallback || DEFAULT_COUNTERPART_CURRENCY_CODE;
  }

  function getCounterpartDisplayName(counterpart){
    const fallbackCurrency = getDefaultCurrency(DEFAULT_COUNTERPART_CURRENCY_CODE) || getDefaultCurrency('USD');
    const fallbackLabel = String(fallbackCurrency && (fallbackCurrency.name || fallbackCurrency.code) || 'الدولار الأمريكي').trim() || 'الدولار الأمريكي';
    const label = String(counterpart && (counterpart.name || counterpart.code) || fallbackLabel).trim();
    return label || fallbackLabel;
  }

  function getCounterpartHeaderText(counterpart, field = 'buy'){
    const displayName = getCounterpartDisplayName(counterpart);
    return field === 'sell'
      ? `مبيع / ${displayName}`
      : `شراء / ${displayName}`;
  }

  function notifyStateChange(nextState){
    const detail = { state: clone(nextState) };
    const events = TAIF.core && TAIF.core.events;
    if(events && typeof events.emitDomainUpdate === 'function'){
      events.emitDomainUpdate('currency', detail, { source:'currency-management-core' });
      return;
    }
    try{
      window.dispatchEvent(new CustomEvent('taif:currency-domain-updated', { detail }));
    }catch{}
    try{
      window.dispatchEvent(new CustomEvent('taif:currency-management-updated', { detail }));
    }catch{}
  }
  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------
  function formatDynamic(value, maxDecimals = 4){
    if(typeof value === 'string'){
      const preserved = normalizeStoredNumericText(value, { allowDecimal: true, allowNegative: true });
      if(preserved) return preserved;
    }

    const number = toNumber(value, 0);
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals
    }).format(number);
  }

  function renderPairBadgeMarkup(pairLabel){
    const safePairLabel = String(pairLabel || 'USD/USD').trim() || 'USD/USD';
    const parts = safePairLabel.split('/').map((part) => String(part || '').trim()).filter(Boolean);
    if(parts.length !== 2){
      const singleToneClass = safePairLabel.toUpperCase() === 'USD'
        ? 'taif-pair-badge__part--usd'
        : 'taif-pair-badge__part--counterpart';
      return `<span class="taif-pair-badge__part ${singleToneClass}">${escapeHtml(safePairLabel)}</span>`;
    }
    const [leftPart, rightPart] = parts;
    const leftClass = leftPart.toUpperCase() === 'USD'
      ? 'taif-pair-badge__part--usd'
      : 'taif-pair-badge__part--counterpart';
    const rightClass = rightPart.toUpperCase() === 'USD'
      ? 'taif-pair-badge__part--usd'
      : 'taif-pair-badge__part--counterpart';
    return `<span class="taif-pair-badge__part ${leftClass}">${escapeHtml(leftPart)}</span><span class="taif-pair-badge__slash" aria-hidden="true">/</span><span class="taif-pair-badge__part ${rightClass}">${escapeHtml(rightPart)}</span>`;
  }

  function resolveFlagAsset(value, variant = 'circle'){
    const flags = TAIF && TAIF.assets && TAIF.assets.flags;
    const safeVariant = flags && typeof flags.normalizeVariant === 'function'
      ? flags.normalizeVariant(variant)
      : 'circle';
    if(flags && typeof flags.resolveFlagAsset === 'function'){
      return flags.resolveFlagAsset(value, safeVariant);
    }
    const safeCode = normalizeCode(value).slice(0, 2).toLowerCase() || 'xx';
    return {
      currencyCode: normalizeCode(value),
      countryCode: safeCode,
      variant: safeVariant,
      src: `assets/flags/circle/${safeCode}.png`
    };
  }

  function resolveStoredFlagCode(flagValue, fallbackCurrencyCode = ''){
    const flags = TAIF && TAIF.assets && TAIF.assets.flags;
    const direct = flags && typeof flags.resolveCountryCode === 'function'
      ? flags.resolveCountryCode(flagValue)
      : String(flagValue || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if(direct) return direct;
    return resolveFlagAsset(fallbackCurrencyCode || 'xx', 'circle').countryCode || 'xx';
  }

  function getFlagCatalog(variant = 'circle', options = {}){
    const flags = TAIF && TAIF.assets && TAIF.assets.flags;
    if(flags && typeof flags.getFlagCatalog === 'function'){
      return flags.getFlagCatalog(variant, options);
    }
    return [];
  }

  function getFlagPickerDisplay(flagCode){
    const resolvedFlagCode = resolveStoredFlagCode(flagCode || '', '');
    const meta = getFlagMeta(resolvedFlagCode);
    const isPlaceholder = resolvedFlagCode === 'xx';
    return {
      code: resolvedFlagCode,
      meta,
      isPlaceholder,
      displayCode: isPlaceholder ? 'بدون علم' : meta.countryCode,
      displayLabel: isPlaceholder ? 'اختيار العلم' : meta.currencyName
    };
  }

  function getFlagMeta(flagCode){
    const flags = TAIF && TAIF.assets && TAIF.assets.flags;
    if(flags && typeof flags.getFlagMeta === 'function'){
      return flags.getFlagMeta(flagCode || 'xx');
    }
    const asset = resolveFlagAsset(flagCode || 'xx', 'circle');
    return {
      code: asset.countryCode || 'xx',
      countryCode: String(asset.countryCode || 'xx').toUpperCase(),
      currencyName: 'غير محدد',
      srcCircle: asset.src,
      srcRect: asset.src
    };
  }

  function resolveCurrencyFlagAsset(currencyInput, variant = 'circle'){
    if(currencyInput && typeof currencyInput === 'object'){
      const explicitFlagCode = resolveStoredFlagCode(currencyInput.flag || '', currencyInput.code || '');
      if(explicitFlagCode && explicitFlagCode !== 'xx') return resolveFlagAsset(explicitFlagCode, variant);
      return resolveFlagAsset(currencyInput.code || '', variant);
    }
    return resolveFlagAsset(currencyInput, variant);
  }

  function createFlagImageMarkup(currencyInput, { variant = 'circle', className = 'currency-management-flag-image', decorative = true } = {}){
    const asset = resolveCurrencyFlagAsset(currencyInput, variant);
    const safeClassName = String(className || 'currency-management-flag-image').trim() || 'currency-management-flag-image';
    const rawCode = currencyInput && typeof currencyInput === 'object'
      ? (currencyInput.code || asset.countryCode || '')
      : currencyInput;
    const altText = decorative ? '' : `علم ${normalizeCode(rawCode) || String(asset.countryCode || '').toUpperCase()}`.trim();
    return `<img class="${escapeHtml(safeClassName)}" src="${escapeHtml(asset.src)}" alt="${escapeHtml(altText)}" draggable="false" loading="eager" decoding="async" width="512" height="512">`;
  }

  Object.assign(feature, {
    MODULE_KEY, runtime, DEFAULT_CURRENCIES, DEFAULT_COUNTERPART_CURRENCY_CODE, LEGACY_ZERO_DROP_MODE, LEGACY_ZERO_DROP_SHIFT, LEGACY_ZERO_DROP_DIVISOR, CALCULATION_METHOD_OPTIONS, PRICE_UPDATE_MODE_OPTIONS, DECIMAL_PLACES_OPTIONS, SINGLE_CURRENCY_FORM_PICKERS, SINGLE_EDITOR_MODAL_OPTIONS, FALLBACK_FLAGS, BULK_EDITOR_TITLE, TOOLBAR_BUTTONS, writeModuleState, resolveStoredMethod, resolveRateMode, getCalculationMethodOptions, normalizeCode, fallbackFlag, resolveEventElement, isCurrencyManagementSurfaceTarget, isWritableSelectionTarget, clearBrowserTextSelection, bindTextSelectionGuard, getDefaultCurrency, sanitizeCurrency, resolveCounterpartCode, getCounterpartDisplayName, getCounterpartHeaderText, notifyStateChange, formatDynamic, pairId, formatPairCode, normalizeUsdConvention, conventionToLegacyMethod, getUsdPairLabelFromConvention, getUsdPairDirectionOptions, getUsdPairFieldLabel, getDerivedPairFieldLabel, renderPairBadgeMarkup, resolveFlagAsset, resolveStoredFlagCode, getFlagCatalog, getFlagPickerDisplay, getFlagMeta, resolveCurrencyFlagAsset, createFlagImageMarkup
  });
})();
