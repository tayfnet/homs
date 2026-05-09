(()=>{
  /*
   * TAIF Currency feature number system.
   * Centralizes numeric sanitization, caret-preserving input formatting,
   * and configured decimal display policies for every currency surface.
   */
  const TAIF = window.TAIF;
  const feature = TAIF.currencyManagementFeature || (TAIF.currencyManagementFeature = {});
  const { runCleanupCallbacks } = TAIF.core.utils;

  function normalizeLocalizedNumericText(value){
    return String(value ?? '')
      .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[٫]/g, '.')
      .replace(/[٬،]/g, ',')
      .replace(/\s+/g, '');
  }

  function sanitizeSmartNumericText(value, { allowDecimal = true, allowNegative = false } = {}){
    const normalized = normalizeLocalizedNumericText(value);
    let result = '';
    let hasDecimal = false;
    let hasSign = false;

    for(const character of normalized){
      if(character >= '0' && character <= '9'){
        result += character;
        continue;
      }

      if(allowDecimal && character === '.' && !hasDecimal){
        if(result === '' || result === '-') result += '0';
        result += '.';
        hasDecimal = true;
        continue;
      }

      if(allowNegative && character === '-' && !hasSign && result === ''){
        result = '-';
        hasSign = true;
      }
    }

    return result;
  }

  function formatSmartNumericText(value, { allowDecimal = true, allowNegative = false, preserveTrailingDecimal = false } = {}){
    const sanitized = sanitizeSmartNumericText(value, { allowDecimal, allowNegative });
    if(!sanitized) return '';
    if(sanitized === '-') return sanitized;

    const hasDecimal = allowDecimal && sanitized.includes('.');
    const trailingDecimal = hasDecimal && sanitized.endsWith('.');
    const sign = sanitized.startsWith('-') ? '-' : '';
    const unsigned = sign ? sanitized.slice(1) : sanitized;
    const parts = unsigned.split('.');
    const integerPart = (parts[0] || '0').replace(/^0+(?=\d)/, '') || '0';
    const fractionPart = parts.length > 1 ? parts.slice(1).join('') : '';
    const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    if(hasDecimal){
      if(fractionPart || (preserveTrailingDecimal && trailingDecimal)){
        return `${sign}${groupedInteger}.${fractionPart}`;
      }
      return `${sign}${groupedInteger}`;
    }

    return `${sign}${groupedInteger}`;
  }

  function normalizeStoredNumericText(value, { allowDecimal = true, allowNegative = false } = {}){
    if(value === null || value === undefined) return '';
    const formatted = formatSmartNumericText(String(value).trim(), { allowDecimal, allowNegative, preserveTrailingDecimal: false });
    return formatted === '-' ? '' : formatted;
  }

  function countSmartNumericUnits(value, options = {}){
    return sanitizeSmartNumericText(value, options).length;
  }

  function resolveSmartNumericCaret(formattedValue, units){
    if(!(units > 0)) return 0;
    let seen = 0;
    for(let index = 0; index < formattedValue.length; index += 1){
      const character = formattedValue[index];
      if((character >= '0' && character <= '9') || character === '.' || character === '-'){
        seen += 1;
        if(seen >= units) return index + 1;
      }
    }
    return formattedValue.length;
  }

  function applySmartNumericFormatting(input, { preserveCaret = false, preserveTrailingDecimal = false, allowDecimal = true, allowNegative = false } = {}){
    if(!(input instanceof HTMLInputElement)) return '';

    const rawValue = input.value || '';
    const unitsBeforeCaret = preserveCaret && typeof input.selectionStart === 'number'
      ? countSmartNumericUnits(rawValue.slice(0, input.selectionStart), { allowDecimal, allowNegative })
      : 0;

    const formattedValue = formatSmartNumericText(rawValue, { allowDecimal, allowNegative, preserveTrailingDecimal });
    input.value = formattedValue;

    if(preserveCaret && typeof input.setSelectionRange === 'function'){
      const nextCaret = resolveSmartNumericCaret(formattedValue, unitsBeforeCaret);
      input.setSelectionRange(nextCaret, nextCaret);
    }

    return formattedValue;
  }

  function mountSmartNumericInputs(root, { selector = '[data-smart-number-input]', registerCleanup = null } = {}){
    const scope = root instanceof Element || root instanceof Document ? root : document;
    const inputs = Array.from(scope.querySelectorAll(selector)).filter((input) => input instanceof HTMLInputElement);
    const cleanups = [];

    inputs.forEach((input) => {
      const allowDecimal = input.dataset.smartNumberMode !== 'integer';
      const allowNegative = input.dataset.smartNumberSign === 'signed';
      const handleInput = () => {
        applySmartNumericFormatting(input, {
          preserveCaret: true,
          preserveTrailingDecimal: true,
          allowDecimal,
          allowNegative
        });
      };
      const handleBlur = () => {
        applySmartNumericFormatting(input, {
          preserveCaret: false,
          preserveTrailingDecimal: false,
          allowDecimal,
          allowNegative
        });
      };

      handleBlur();
      input.addEventListener('input', handleInput);
      input.addEventListener('blur', handleBlur);
      input.addEventListener('change', handleBlur);
      cleanups.push(() => {
        input.removeEventListener('input', handleInput);
        input.removeEventListener('blur', handleBlur);
        input.removeEventListener('change', handleBlur);
      });
    });

    const dispose = () => {
      if(typeof runCleanupCallbacks === 'function'){
        runCleanupCallbacks(cleanups, { clearSource:true });
        return;
      }
      cleanups.forEach((cleanup) => {
        try{ cleanup(); }catch{}
      });
      cleanups.length = 0;
    };

    if(typeof registerCleanup === 'function') registerCleanup(dispose);
    return dispose;
  }

  function toNumber(value, fallback = 0){
    const sanitized = sanitizeSmartNumericText(value, { allowDecimal: true, allowNegative: true });
    const number = Number(sanitized);
    return Number.isFinite(number) ? number : fallback;
  }

  function getPositiveRate(value, fallback = 1){
    return Math.max(toNumber(value, fallback), 0.000001);
  }

  function clampDecimals(value){
    const parsed = parseInt(value, 10);
    if(!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(parsed, 6);
  }

  function getNumericTextFractionDigits(value){
    const normalized = normalizeStoredNumericText(value, { allowDecimal: true, allowNegative: true });
    if(!normalized || !normalized.includes('.')) return 0;
    return normalized.split('.')[1].length;
  }

  function formatFixedNumericValue(value, fractionDigits = 0, { useGrouping = true } = {}){
    const number = toNumber(value, Number.NaN);
    if(!Number.isFinite(number)) return '';
    const safeDigits = clampDecimals(fractionDigits);
    return new Intl.NumberFormat('en-US', {
      useGrouping,
      minimumFractionDigits: safeDigits,
      maximumFractionDigits: safeDigits
    }).format(number);
  }

  function resolveAutoFractionDigits(value, { maxAutoDecimals = 6, mode = 'standard' } = {}){
    const safeMax = clampDecimals(maxAutoDecimals);
    const number = Math.abs(toNumber(value, Number.NaN));
    if(!Number.isFinite(number) || number === 0) return 0;

    const fixed = number.toFixed(safeMax);
    const fraction = fixed.includes('.') ? fixed.split('.')[1] : '';
    const trimmed = fraction.replace(/0+$/, '');
    if(!trimmed) return 0;

    if(number >= 1000) return 0;
    if(number >= 100) return Math.min(safeMax, mode === 'rate' ? 2 : 1);
    if(number >= 1) return Math.min(safeMax, mode === 'rate' ? 2 : 2);

    const leadingZerosMatch = trimmed.match(/^0+/);
    const leadingZeros = leadingZerosMatch ? leadingZerosMatch[0].length : 0;
    const significantFractionDigits = mode === 'rate' ? 4 : 3;
    return Math.min(safeMax, Math.max(1, leadingZeros + significantFractionDigits));
  }

  function resolveNumericDisplayFractionDigits(value, {
    decimals = null,
    maxAutoDecimals = 6,
    mode = 'standard',
    respectConfiguredDecimals = true
  } = {}){
    const hasConfiguredDecimals = decimals !== null && decimals !== undefined && decimals !== '';
    if(hasConfiguredDecimals && respectConfiguredDecimals){
      return clampDecimals(decimals);
    }
    return resolveAutoFractionDigits(value, { maxAutoDecimals, mode });
  }

  function formatCurrencyNumericDisplay(value, {
    rawText = '',
    decimals = null,
    maxAutoDecimals = 6,
    mode = 'standard',
    fallback = '—',
    useGrouping = true,
    respectConfiguredDecimals = true
  } = {}){
    const preserved = normalizeStoredNumericText(rawText, { allowDecimal: true, allowNegative: true });
    const hasConfiguredDecimals = decimals !== null && decimals !== undefined && decimals !== '';
    const configuredDigits = hasConfiguredDecimals && respectConfiguredDecimals ? clampDecimals(decimals) : null;

    if(preserved){
      const rawDigits = getNumericTextFractionDigits(preserved);
      const fractionDigits = configuredDigits === null ? rawDigits : Math.max(rawDigits, configuredDigits);
      return formatFixedNumericValue(preserved, fractionDigits, { useGrouping }) || preserved;
    }

    const number = toNumber(value, Number.NaN);
    if(!Number.isFinite(number)) return fallback;

    const fractionDigits = resolveNumericDisplayFractionDigits(number, {
      decimals,
      maxAutoDecimals,
      mode,
      respectConfiguredDecimals
    });

    return formatFixedNumericValue(number, fractionDigits, { useGrouping }) || fallback;
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

  Object.assign(feature, {
    normalizeLocalizedNumericText,
    sanitizeSmartNumericText,
    formatSmartNumericText,
    normalizeStoredNumericText,
    countSmartNumericUnits,
    resolveSmartNumericCaret,
    applySmartNumericFormatting,
    mountSmartNumericInputs,
    toNumber,
    getPositiveRate,
    clampDecimals,
    getNumericTextFractionDigits,
    formatFixedNumericValue,
    resolveAutoFractionDigits,
    resolveNumericDisplayFractionDigits,
    formatCurrencyNumericDisplay,
    resolveCurrencyFieldDecimals
  });
})();
