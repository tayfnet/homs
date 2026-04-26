(()=>{
  'use strict';

  const config = window.TAIF_PUBLIC_PRICE_BOARD_CONFIG || {};
  const sourceConfig = config.dataSource || config.supabase || {};
  const compatibility = config.compatibility || {};
  const engine = window.TAIFPublicPriceEngine;

  if(!engine){
    throw new Error('TAIFPublicPriceEngine is missing. Check public-price-board/js/public-price-engine.js.');
  }

  const {
    STORAGE_KEY,
    escapeHtml,
    wrapControlTextMarkup,
    normalizeCode,
    sanitizeState,
    computeRows,
    getCounterpartCurrency,
    formatManagementCellValue,
    resolveCurrencyFlagAsset,
    renderPairBadgeMarkup,
    unwrapCurrencyStatePayload
  } = engine;

  const runtime = {
    panel: document.querySelector('[data-public-price-panel]'),
    lastRawValue: '',
    lastState: null,
    lastSource: '',
    refreshTimer: 0,
    loading: true,
    refreshInFlight: false
  };

  function shouldShowCurrencyDisplayRow(row){
    if(!(row && typeof row === 'object')) return false;
    const code = normalizeCode(row.code);
    return Boolean(code) && code !== 'USD' && !row.isUsd;
  }

  function getVisibleRows(rows){
    return (Array.isArray(rows) ? rows : []).filter(shouldShowCurrencyDisplayRow);
  }

  function isCounterpartDisplayRow(row, counterpart){
    const rowCode = normalizeCode(row && row.code);
    const counterpartCode = normalizeCode(counterpart && counterpart.code);
    return Boolean(rowCode && counterpartCode && rowCode === counterpartCode && rowCode !== 'USD');
  }

  function isLegacyZeroDropDisplayRow(row){
    if(!(row && typeof row === 'object')) return false;
    return String(row.rateMode || '').trim() === 'legacy-zero-drop' || Number(row.legacyZeroShift || 0) > 0;
  }

  function shouldDashUsdDisplay(row, counterpart){
    return Boolean(isCounterpartDisplayRow(row, counterpart) || isLegacyZeroDropDisplayRow(row));
  }

  function createSingleLineHeaderLabel(text){
    return `<span class="taif-singleline-fit taif-singleline-fit--price-head">${escapeHtml(text)}</span>`;
  }

  function renderUsdDashMarkup(){
    return '<span class="price-screen__usd-dash" aria-label="شرطة"><span class="price-screen__usd-dash-text" aria-hidden="true">—</span></span>';
  }

  function renderPriceNumberMarkup(row, field, counterpart){
    if((field === 'dollarBuy' || field === 'dollarSell') && shouldDashUsdDisplay(row, counterpart)){
      return renderUsdDashMarkup();
    }
    return wrapControlTextMarkup(escapeHtml(formatManagementCellValue(row, field, 6)), 'taif-control-text--ltr');
  }

  function rowMarkup(row, counterpart){
    const localFlag = resolveCurrencyFlagAsset(row, 'circle');
    const counterpartFlag = resolveCurrencyFlagAsset(counterpart, 'circle');
    const usdFlag = resolveCurrencyFlagAsset({ code:'USD', flag:'us' }, 'circle');
    const counterpartName = counterpart && (counterpart.name || counterpart.code) ? (counterpart.name || counterpart.code) : 'الدولار الأمريكي';
    const buySellFlag = row.isUsd ? counterpartFlag : localFlag;
    const buySellFlagTitle = row.isUsd ? counterpartName : (row.name || row.code);
    const isCounterpartRow = isCounterpartDisplayRow(row, counterpart);
    const dashUsdDisplay = shouldDashUsdDisplay(row, counterpart);
    const dollarColumnFlag = dashUsdDisplay ? usdFlag : localFlag;
    const dollarColumnFlagTitle = dashUsdDisplay ? 'الدولار الأمريكي' : (row.name || row.code);

    return `
      <div class="price-screen__row${row.isUsd ? ' price-screen__row--usd' : ''}${isCounterpartRow ? ' price-screen__row--counterpart' : ''}${dashUsdDisplay ? ' price-screen__row--usd-dash' : ''}" data-code="${escapeHtml(row.code)}">
        <div class="price-screen__code" dir="ltr">${wrapControlTextMarkup(escapeHtml(row.code), 'taif-control-text--ltr')}</div>
        <div class="price-screen__name">
          <div class="price-screen__name-main">${escapeHtml(row.name || row.code)}</div>
        </div>
        <div class="price-screen__num price-screen__num--buy">${wrapControlTextMarkup(escapeHtml(formatManagementCellValue(row, 'buy', 6)), 'taif-control-text--ltr')}</div>
        <div class="price-screen__flag" title="${escapeHtml(buySellFlagTitle)}" aria-hidden="true">
          <img class="price-screen__flag-image" src="${escapeHtml(buySellFlag.src)}" alt="" draggable="false" loading="eager" decoding="async" width="512" height="512">
        </div>
        <div class="price-screen__num price-screen__num--sell">${wrapControlTextMarkup(escapeHtml(formatManagementCellValue(row, 'sell', 6)), 'taif-control-text--ltr')}</div>
        <div class="price-screen__pair-col">
          <div class="price-screen__pair-badge" dir="ltr">${wrapControlTextMarkup(renderPairBadgeMarkup(row.usdPairLabel || row.usdPairId || 'USD/USD'), 'taif-control-text--ltr taif-control-text--pair')}</div>
        </div>
        <div class="price-screen__num price-screen__num--dollar-buy">${renderPriceNumberMarkup(row, 'dollarBuy', counterpart)}</div>
        <div class="price-screen__usd-flag" title="${escapeHtml(dollarColumnFlagTitle)}" aria-hidden="true">
          <img class="price-screen__flag-image" src="${escapeHtml(dollarColumnFlag.src)}" alt="" draggable="false" loading="eager" decoding="async" width="512" height="512">
        </div>
        <div class="price-screen__num price-screen__num--dollar-sell">${renderPriceNumberMarkup(row, 'dollarSell', counterpart)}</div>
      </div>
    `;
  }

  function renderPriceScreen(){
    const panel = runtime.panel;
    if(!(panel instanceof HTMLElement)) return;

    if(runtime.loading && !runtime.lastState){
      panel.innerHTML = '<div class="taif-public-price-loading">جارٍ تحميل شاشة الأسعار...</div>';
      return;
    }

    if(!runtime.lastState){
      panel.innerHTML = '<div class="taif-public-price-error">لا توجد بيانات أسعار متاحة للعرض حالياً.</div>';
      return;
    }

    const state = sanitizeState(runtime.lastState);
    const rows = computeRows(state);
    const counterpart = getCounterpartCurrency(state);
    const visibleRows = getVisibleRows(rows);
    const counterpartName = counterpart && (counterpart.name || counterpart.code)
      ? (counterpart.name || counterpart.code)
      : 'الدولار الأمريكي';

    panel.innerHTML = `
      <section class="price-screen price-screen--display-only" aria-label="شاشة الأسعار" data-price-source="${escapeHtml(runtime.lastSource || 'unknown')}">
        <div class="price-screen__board-head" aria-hidden="true">
          <div>${createSingleLineHeaderLabel('كود العملة')}</div>
          <div class="price-screen__board-head-name">${createSingleLineHeaderLabel('اسم العملة')}</div>
          <div>${createSingleLineHeaderLabel(`شراء / ${counterpartName}`)}</div>
          <div>${createSingleLineHeaderLabel('العلم')}</div>
          <div>${createSingleLineHeaderLabel(`مبيع / ${counterpartName}`)}</div>
          <div>${createSingleLineHeaderLabel('أزواج العملات')}</div>
          <div>${createSingleLineHeaderLabel('شراء / الدولار الأمريكي')}</div>
          <div>${createSingleLineHeaderLabel('العلم')}</div>
          <div>${createSingleLineHeaderLabel('مبيع / الدولار الأمريكي')}</div>
        </div>

        <div class="price-screen__mobile-head" aria-hidden="true">
          <div class="price-screen__mobile-head-cell price-screen__mobile-head-cell--identity">اسم العملة</div>
          <div class="price-screen__mobile-head-cell price-screen__mobile-head-cell--counterpart">شراء / مبيع مقابل ${escapeHtml(counterpartName)}</div>
          <div class="price-screen__mobile-head-cell price-screen__mobile-head-cell--usd">شراء / مبيع مقابل الدولار</div>
        </div>

        <div class="price-screen__board-body" aria-label="جدول الأسعار">
          ${visibleRows.length ? `<div class="price-screen__list">${visibleRows.map((row) => rowMarkup(row, counterpart)).join('')}</div>` : '<div class="price-screen__empty">لا توجد عملات متاحة للعرض حالياً.</div>'}
        </div>
      </section>
    `;
  }

  function candidateTimestamp(state, fallbackUpdatedAt){
    const stateUpdatedAt = Number(state && state.updatedAt);
    if(Number.isFinite(stateUpdatedAt) && stateUpdatedAt > 0) return stateUpdatedAt;
    const parsedUpdatedAt = Date.parse(String(fallbackUpdatedAt || ''));
    return Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0;
  }

  function createStateCandidate(rawValue, source, updatedAt = ''){
    const raw = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue || {});
    const state = unwrapCurrencyStatePayload(raw || rawValue);
    if(!state) return null;
    const sanitized = sanitizeState(state);
    if(!getVisibleRows(computeRows(sanitized)).length) return null;
    return {
      rawValue: raw,
      state: sanitized,
      source: String(source || 'unknown'),
      timestamp: candidateTimestamp(sanitized, updatedAt)
    };
  }

  function bestCandidate(candidates){
    const valid = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
    if(!valid.length) return null;
    return valid.sort((left, right) => {
      const byTime = Number(right.timestamp || 0) - Number(left.timestamp || 0);
      if(byTime) return byTime;
      const remoteScore = (candidate) => String(candidate.source || '').startsWith('supabase:') ? 2 : (String(candidate.source || '').startsWith('cache:') ? 1 : 0);
      return remoteScore(right) - remoteScore(left);
    })[0] || null;
  }

  function getStorage(){
    try{ return window.localStorage || null; }
    catch{ return null; }
  }

  function readCachedCandidate(){
    const storage = getStorage();
    const cacheKey = String(config.cacheKey || 'taif-public-price-board-cache-v1').trim();
    if(!storage || !cacheKey) return null;
    try{
      const raw = storage.getItem(cacheKey);
      return raw ? createStateCandidate(raw, `cache:${cacheKey}`) : null;
    }catch{
      return null;
    }
  }

  function persistCachedSnapshot(rawValue){
    const storage = getStorage();
    const cacheKey = String(config.cacheKey || 'taif-public-price-board-cache-v1').trim();
    if(!storage || !cacheKey || !rawValue) return;
    try{ storage.setItem(cacheKey, rawValue); }catch{}
  }

  function readSameDomainLocalStorageCandidate(){
    if(compatibility.readSameDomainLocalStorage === false) return null;
    const storage = getStorage();
    if(!storage) return null;
    const candidates = [];
    const storageKey = String(sourceConfig.storageKey || STORAGE_KEY).trim();
    const wantedKeys = new Set([STORAGE_KEY, storageKey].filter(Boolean));

    function consider(key){
      if(!key) return;
      let raw = '';
      try{ raw = storage.getItem(key) || ''; }catch{ raw = ''; }
      if(!raw) return;
      const candidate = createStateCandidate(raw, `localStorage:${key}`);
      if(candidate) candidates.push(candidate);
    }

    wantedKeys.forEach(consider);

    try{
      for(let index = 0; index < storage.length; index += 1){
        const key = storage.key(index);
        if(!key) continue;
        if(wantedKeys.has(key) || key.endsWith(`::${storageKey}`) || key.includes(storageKey)) consider(key);
      }
    }catch{}

    return bestCandidate(candidates);
  }

  function buildRestUrl(tableName, { storageKey = '', broad = false } = {}){
    const projectUrl = String(sourceConfig.projectUrl || '').replace(/\/+$/, '');
    if(!projectUrl) return '';
    const table = encodeURIComponent(String(tableName || sourceConfig.table || 'taif_currency_management_state'));
    const workspace = encodeURIComponent(String(sourceConfig.workspaceCode || 'main-production'));
    const params = [
      'select=workspace_code,storage_key,raw_value,payload,updated_at,version',
      `workspace_code=eq.${workspace}`,
      'order=updated_at.desc',
      broad ? 'limit=25' : 'limit=1'
    ];
    const key = String(storageKey || sourceConfig.storageKey || STORAGE_KEY).trim();
    if(!broad && key) params.push(`storage_key=eq.${encodeURIComponent(key)}`);
    return `${projectUrl}/rest/v1/${table}?${params.join('&')}`;
  }

  async function fetchJson(url){
    const anonKey = String(sourceConfig.anonKey || '').trim();
    if(!url || !anonKey) throw new Error('إعدادات Supabase ناقصة داخل public-price-board/js/config.js.');
    const timeoutMs = Math.max(1000, Number(config.requestTimeoutMs) || 3500);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;

    let response;
    try{
      response = await fetch(url, {
        method:'GET',
        cache:'no-store',
        signal:controller ? controller.signal : undefined,
        headers:{
          apikey:anonKey,
          Authorization:`Bearer ${anonKey}`,
          Accept:'application/json',
          'Accept-Profile':String(sourceConfig.schema || 'public')
        }
      });
    }finally{
      if(timeoutId) window.clearTimeout(timeoutId);
    }

    if(!response.ok){
      const text = await response.text().catch(() => '');
      throw new Error(`Supabase REST ${response.status}: ${text}`.trim());
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  function recordToCandidate(record, sourcePrefix){
    if(!record || typeof record !== 'object') return null;
    const rawValue = typeof record.raw_value === 'string'
      ? record.raw_value
      : (record.payload !== undefined && record.payload !== null ? JSON.stringify(record.payload) : JSON.stringify(record));
    const storageKey = String(record.storage_key || '').trim();
    const expectedKey = String(sourceConfig.storageKey || STORAGE_KEY).trim();
    const keyLooksCompatible = !storageKey || storageKey === expectedKey || storageKey.endsWith(`::${expectedKey}`) || storageKey.includes(expectedKey);
    if(!keyLooksCompatible && rawValue && !rawValue.includes('currencies')) return null;
    return createStateCandidate(rawValue, `${sourcePrefix}:${storageKey || 'record'}`, record.updated_at);
  }

  async function collectRemoteCandidatesForTable(table, broad = false){
    const candidates = [];
    const storageKeys = Array.from(new Set([
      String(sourceConfig.storageKey || STORAGE_KEY).trim(),
      STORAGE_KEY
    ].filter(Boolean)));

    if(broad){
      const rows = await fetchJson(buildRestUrl(table, { broad:true }));
      rows.forEach((record) => {
        const candidate = recordToCandidate(record, `supabase:${table}:broad`);
        if(candidate) candidates.push(candidate);
      });
      return candidates;
    }

    for(const storageKey of storageKeys){
      const rows = await fetchJson(buildRestUrl(table, { storageKey, broad:false }));
      rows.forEach((record) => {
        const candidate = recordToCandidate(record, `supabase:${table}`);
        if(candidate) candidates.push(candidate);
      });
    }
    return candidates;
  }

  async function fetchRemoteCandidate(){
    const primaryTable = String(sourceConfig.table || 'taif_currency_management_state').trim();
    const fallbackTables = Array.isArray(compatibility.fallbackTables) ? compatibility.fallbackTables : [];
    const tables = Array.from(new Set([primaryTable, ...fallbackTables].map((table) => String(table || '').trim()).filter(Boolean)));
    const candidates = [];

    for(const table of tables){
      try{
        candidates.push(...await collectRemoteCandidatesForTable(table, false));
      }catch(error){
        console.warn(`[TAIF Public Price Board] skipped exact lookup ${table}:`, error);
      }
      if(candidates.length) break;
    }

    if(!candidates.length && compatibility.allowBroadLookup !== false){
      for(const table of tables){
        try{
          candidates.push(...await collectRemoteCandidatesForTable(table, true));
        }catch(error){
          console.warn(`[TAIF Public Price Board] skipped compatibility lookup ${table}:`, error);
        }
        if(candidates.length) break;
      }
    }

    return bestCandidate(candidates);
  }

  function applyCandidate(candidate){
    if(!candidate) return false;
    const changed = candidate.rawValue !== runtime.lastRawValue || candidate.source !== runtime.lastSource;
    runtime.lastRawValue = candidate.rawValue;
    runtime.lastState = candidate.state;
    runtime.lastSource = candidate.source;
    runtime.loading = false;
    if(candidate.source.startsWith('supabase:')) persistCachedSnapshot(candidate.rawValue);
    if(changed) renderPriceScreen();
    return true;
  }

  function renderError(message){
    const panel = runtime.panel;
    if(!(panel instanceof HTMLElement)) return;
    if(runtime.lastState){
      renderPriceScreen();
      return;
    }
    panel.innerHTML = `<div class="taif-public-price-error">تعذر تحميل شاشة الأسعار.<br>${escapeHtml(message || 'فشل الاتصال بقاعدة البيانات.')}</div>`;
  }

  async function refresh(){
    if(runtime.refreshInFlight) return;
    runtime.refreshInFlight = true;

    const cacheCandidate = readCachedCandidate();
    const localCandidate = readSameDomainLocalStorageCandidate();
    const earlyCandidate = bestCandidate([cacheCandidate, localCandidate]);
    if(earlyCandidate && !runtime.lastState) applyCandidate(earlyCandidate);

    try{
      const remoteCandidate = await fetchRemoteCandidate();
      const selected = bestCandidate([remoteCandidate, cacheCandidate, localCandidate]);
      runtime.loading = false;
      if(selected){
        applyCandidate(selected);
      }else if(!runtime.lastState){
        renderError('لا توجد بيانات أسعار صالحة داخل مصدر البيانات المحدد.');
      }else{
        renderPriceScreen();
      }
    }catch(error){
      runtime.loading = false;
      console.warn('[TAIF Public Price Board] refresh failed:', error);
      if(earlyCandidate){
        applyCandidate(earlyCandidate);
      }else{
        renderError(error && error.message ? error.message : 'فشل غير معروف.');
      }
    }finally{
      runtime.refreshInFlight = false;
    }
  }

  function startAutoRefresh(){
    window.clearInterval(runtime.refreshTimer);
    const interval = Math.max(2500, Number(config.refreshIntervalMs) || 5000);
    runtime.refreshTimer = window.setInterval(refresh, interval);
  }

  function applyResponsiveMode(){
    const breakpoint = Math.max(320, Number(config.mobileBreakpointPx) || 860);
    document.body.classList.toggle('taif-mobile-mode', window.innerWidth <= breakpoint);
  }

  window.addEventListener('resize', applyResponsiveMode, { passive:true });
  window.addEventListener('storage', (event) => {
    const key = String(event && event.key || '').trim();
    const cacheKey = String(config.cacheKey || 'taif-public-price-board-cache-v1').trim();
    const storageKey = String(sourceConfig.storageKey || STORAGE_KEY).trim();
    if(key === cacheKey || key === storageKey || key.endsWith(`::${storageKey}`) || key.includes(storageKey)) refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible') refresh();
  });

  applyResponsiveMode();
  renderPriceScreen();
  refresh();
  startAutoRefresh();
})();
