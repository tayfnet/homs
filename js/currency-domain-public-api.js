(()=>{
  /*
   * TAIF Currency domain public API.
   * Exposes the online business layer without loading the Currency Management view controller.
   */
  const TAIF = window.TAIF || (window.TAIF = {});
  const feature = TAIF.currencyManagementFeature || (TAIF.currencyManagementFeature = {});
  const domain = TAIF.currencyDomain || (TAIF.currencyDomain = {});
  const legacyApi = TAIF.currencyManagement || (TAIF.currencyManagement = {});

  const exposedKeys = [
    'DEFAULT_CURRENCIES',
    'FALLBACK_FLAGS',
    'normalizeStoredNumericText',
    'toNumber',
    'formatCurrencyNumericDisplay',
    'readState',
    'writeState',
    'resetState',
    'computeRows',
    'getCounterpartCurrencyFromState',
    'getCounterpartCurrency',
    'getCounterpartDisplayName',
    'getCounterpartHeaderText',
    'getCounterpartRatioHeaderText',
    'getDollarHeaderText',
    'getCounterpartOptions',
    'getActiveRateBook',
    'getUsdManualQuote',
    'readOperationalQuote',
    'auditState',
    'formatManagementCellValue',
    'createFlagImageMarkup',
    'resolveCurrencyFlagAsset',
    'renderPairBadgeMarkup'
  ];

  exposedKeys.forEach((key) => {
    if(!(key in feature)) return;
    domain[key] = feature[key];
    legacyApi[key] = feature[key];
  });
})();
