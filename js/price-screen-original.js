(()=>{

  const TAIF = window.TAIF;
  const { escapeHtml, runCleanupSlot, wrapControlTextMarkup, createAnimationFrameScheduler } = TAIF.core.utils;
  const domain = TAIF.currencyDomain || {};

  const runtime = {
    panel: null,
    interactionCleanup: null,
    listenersBound: false,
    refreshScheduler: null,
    currencyEventsCleanup: null
  };

  const SHORT_CURRENCY_NAMES = Object.freeze({
    USD: 'دولار',
    EUR: 'يورو',
    SYP: 'سوري',
    TRY: 'تركي',
    SAR: 'ريال',
    AED: 'درهم',
    JOD: 'دينار',
    GBP: 'استرليني',
    CHF: 'فرنك',
    CAD: 'كندي',
    AUD: 'أسترالي',
    SEK: 'كرون',
    NOK: 'كرون',
    DKK: 'كرون',
    KWD: 'دينار',
    QAR: 'ريال',
    BHD: 'دينار',
    OMR: 'ريال',
    EGP: 'جنيه',
    IQD: 'دينار',
    LBP: 'لبناني',
    LYD: 'دينار',
    MAD: 'درهم',
    DZD: 'دينار',
    TND: 'دينار',
    RUB: 'روبل',
    CNY: 'يوان',
    JPY: 'ين'
  });

  function readCurrencyManagementRows(){
    if(typeof domain.readState === 'function' && typeof domain.computeRows === 'function'){
      const state = domain.readState();
      const rows = domain.computeRows(state);
      const counterpart = typeof domain.getCounterpartCurrency === 'function'
        ? domain.getCounterpartCurrency(state)
        : { code: 'USD', name: 'الدولار الأمريكي', flag: 'us' };
      return {
        state,
        counterpart,
        rows: Array.isArray(rows) ? rows : []
      };
    }

    return { state: { updatedAt: Date.now(), currencies: [] }, counterpart: { code: 'USD', name: 'الدولار الأمريكي', flag: 'us' }, rows: [] };
  }

  function normalizeCurrencyCode(value){
    return String(value || '').trim().toUpperCase();
  }

  function getVisibleRows(rows){
    if(!Array.isArray(rows)) return [];
    return rows.filter((row) => {
      if(!row || typeof row !== 'object') return false;
      return normalizeCurrencyCode(row.code) !== 'USD';
    });
  }

  function findCurrencyRow(rows, code){
    const safeCode = normalizeCurrencyCode(code);
    if(!safeCode || !Array.isArray(rows)) return null;
    return rows.find((row) => normalizeCurrencyCode(row && row.code) === safeCode) || null;
  }

  function isCounterpartCurrencyRow(row, counterpart){
    const rowCode = normalizeCurrencyCode(row && row.code);
    const counterpartCode = normalizeCurrencyCode(counterpart && counterpart.code);
    return Boolean(rowCode && counterpartCode && rowCode === counterpartCode);
  }

  function getCounterpartRow(rows, counterpart){
    const counterpartCode = normalizeCurrencyCode(counterpart && counterpart.code);
    if(!counterpartCode || !Array.isArray(rows)) return null;
    return rows.find((row) => row && (row.isCounterpart || normalizeCurrencyCode(row.code) === counterpartCode)) || null;
  }

  function formatRowCellValue(row, field, maxAutoDecimals = 6){
    if(typeof domain.formatManagementCellValue === 'function'){
      return domain.formatManagementCellValue(row, field, maxAutoDecimals);
    }
    const safeValue = row && Object.prototype.hasOwnProperty.call(row, field) ? row[field] : '';
    return String(safeValue ?? '—');
  }

  function safeControlText(content, extraClass = 'taif-control-text--ltr'){
    return wrapControlTextMarkup(escapeHtml(content), extraClass);
  }

  function getDisplayCurrencyName(row){
    const safeRow = row && typeof row === 'object' ? row : {};
    return String(safeRow.name || safeRow.code || '—').trim() || '—';
  }


  function getShortCurrencyName(rowOrCode){
    const code = normalizeCurrencyCode(rowOrCode && typeof rowOrCode === 'object' ? rowOrCode.code : rowOrCode);
    if(SHORT_CURRENCY_NAMES[code]) return SHORT_CURRENCY_NAMES[code];
    const rawName = String(rowOrCode && typeof rowOrCode === 'object' ? (rowOrCode.name || rowOrCode.code || '') : rowOrCode || '').trim();
    if(!rawName) return code || '—';
    return rawName
      .replace(/^العملة\s+/u, '')
      .replace(/^الليرة\s+/u, '')
      .replace(/^الدولار\s+/u, 'دولار ')
      .replace(/^الريال\s+/u, 'ريال ')
      .replace(/^اليورو$/u, 'يورو')
      .replace(/\s+الأمريكي$/u, '')
      .replace(/\s+السعودي$/u, '')
      .replace(/\s+السورية$/u, '')
      .replace(/\s+السوري$/u, '')
      .trim() || code || '—';
  }

  function getDesktopFlagAsset(rowOrCode){
    const row = rowOrCode && typeof rowOrCode === 'object' ? rowOrCode : null;
    const code = normalizeCurrencyCode(row ? row.code : rowOrCode);
    const flag = resolveRowFlagAsset(row || { code }, 'circle');
    return flag && flag.src ? flag.src : 'assets/flags/circle/xx.png';
  }

  function flagMarkup(rowOrCode, label){
    const title = label || getShortCurrencyName(rowOrCode);
    return `<span class="price-screen__desktop-flag" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><img class="price-screen__desktop-flag-image" src="${escapeHtml(getDesktopFlagAsset(rowOrCode))}" alt="" draggable="false" loading="eager" decoding="async"></span>`;
  }

  const resolveRowFlagAsset = typeof domain.resolveCurrencyFlagAsset === 'function'
    ? domain.resolveCurrencyFlagAsset
    : (rowOrCurrency, variant = 'circle') => {
      const flags = TAIF.assets && TAIF.assets.flags;
      const safeRow = rowOrCurrency && typeof rowOrCurrency === 'object' ? rowOrCurrency : {};
      const explicitFlag = String(safeRow.flag || '').trim();
      const fallbackCode = String(safeRow.code || '').trim();
      if(flags && typeof flags.resolveFlagAsset === 'function'){
        return flags.resolveFlagAsset(explicitFlag || fallbackCode || 'xx', variant);
      }
      return { src: 'assets/flags/circle/xx.png', countryCode: 'xx' };
    };


  function cleanupInteractions(){
    runCleanupSlot(runtime, 'interactionCleanup');
  }

  function scheduleRefresh(){
    if(!(runtime.panel instanceof HTMLElement) || runtime.panel.dataset.view !== 'price-screen') return;
    if(typeof createAnimationFrameScheduler === 'function'){
      if(!runtime.refreshScheduler){
        runtime.refreshScheduler = createAnimationFrameScheduler(() => {
          if(runtime.panel && runtime.panel.dataset.view === 'price-screen') renderPriceScreen(runtime.panel);
        });
      }
      runtime.refreshScheduler.schedule();
      return;
    }
    renderPriceScreen(runtime.panel);
  }

  function makePairCardFromRow(row, source){
    if(!row) return null;
    const counterpartRow = getCounterpartRow(source.rows, source.counterpart) || source.counterpart;
    const baseCode = normalizeCurrencyCode(row.code);
    const quoteCode = normalizeCurrencyCode(counterpartRow && counterpartRow.code) || 'USD';
    if(!baseCode || baseCode === quoteCode) return null;
    return {
      baseCode,
      quoteCode,
      sourceCurrencyCode: baseCode,
      baseRow: row,
      quoteRow: counterpartRow,
      title: `${getShortCurrencyName(row)} / ${getShortCurrencyName(counterpartRow)}`,
      row,
      interactive: Boolean(
        isCounterpartCurrencyRow(row, source.counterpart)
        || (baseCode === 'USD' && quoteCode === normalizeCurrencyCode(source.counterpart && source.counterpart.code))
        || (quoteCode === 'USD' && baseCode === normalizeCurrencyCode(source.counterpart && source.counterpart.code))
      )
    };
  }

  function isLegacyZeroDropRow(row){
    if(!row || typeof row !== 'object') return false;
    return String(row.rateMode || '').trim() === 'legacy-zero-drop'
      || Boolean(row.legacyZeroShift)
      || Boolean(row.legacySourceCode);
  }

  function makeUsdCardFromRow(row, source, options = {}){
    if(!row || !source) return null;
    const usdRow = findCurrencyRow(source.rows, 'USD') || { code: 'USD', name: 'دولار', flag: 'us' };
    const currencyCode = normalizeCurrencyCode(row.code);
    if(!currencyCode || currencyCode === 'USD') return null;

    return {
      baseCode: 'USD',
      quoteCode: currencyCode,
      sourceCurrencyCode: currencyCode,
      baseRow: usdRow,
      quoteRow: row,
      title: `دولار / ${getDisplayCurrencyName(row)}`,
      row: {
        ...row,
        displayBuy: row.displayDollarBuy,
        displaySell: row.displayDollarSell,
        displayBuyText: row.displayDollarBuyText || '',
        displaySellText: row.displayDollarSellText || '',
        fieldDecimals: {
          ...(row.fieldDecimals || {}),
          buy: row.fieldDecimals && Object.prototype.hasOwnProperty.call(row.fieldDecimals, 'dollarBuy') ? row.fieldDecimals.dollarBuy : row.decimals,
          sell: row.fieldDecimals && Object.prototype.hasOwnProperty.call(row.fieldDecimals, 'dollarSell') ? row.fieldDecimals.dollarSell : row.decimals
        }
      },
      interactive: options.interactive === true
    };
  }

  function buildDesktopCards(source){
    const visibleRows = getVisibleRows(source.rows);
    const counterpartCode = normalizeCurrencyCode(source.counterpart && source.counterpart.code);
    const counterpartRow = getCounterpartRow(source.rows, source.counterpart);
    const baseCards = [];
    const pairKeys = new Set();
    const usedSourceCodes = new Set();

    const pushCard = (card) => {
      if(!card) return false;
      const pairKey = `${normalizeCurrencyCode(card.baseCode)}/${normalizeCurrencyCode(card.quoteCode)}`;
      const sourceCode = normalizeCurrencyCode(card.sourceCurrencyCode || (card.baseRow && card.baseRow.code) || (card.quoteRow && card.quoteRow.code));
      if(pairKeys.has(pairKey) || (sourceCode && usedSourceCodes.has(sourceCode))) return false;
      pairKeys.add(pairKey);
      if(sourceCode) usedSourceCodes.add(sourceCode);
      baseCards.push(card);
      return true;
    };

    if(counterpartRow && counterpartCode && counterpartCode !== 'USD'){
      pushCard(makeUsdCardFromRow(counterpartRow, source, { interactive: true }));
    }

    const zeroDropRow = visibleRows.find((row) => {
      const code = normalizeCurrencyCode(row && row.code);
      if(!code || code === counterpartCode) return false;
      return isLegacyZeroDropRow(row);
    });
    if(zeroDropRow){
      pushCard(makeUsdCardFromRow(zeroDropRow, source));
    }

    visibleRows.forEach((row) => {
      if(baseCards.length >= 6) return;
      const code = normalizeCurrencyCode(row && row.code);
      if(!code || code === counterpartCode) return;
      if(zeroDropRow && code === normalizeCurrencyCode(zeroDropRow.code)) return;
      pushCard(makePairCardFromRow(row, source));
    });

    while(baseCards.length < 6){
      baseCards.push(null);
    }

    return baseCards.slice(0, 6);
  }

  function orderDesktopCardsForGrid(cards){
    const safeCards = Array.isArray(cards) ? cards.slice(0, 6) : [];
    while(safeCards.length < 6){
      safeCards.push(null);
    }
    return [
      safeCards[1] ?? null, safeCards[0] ?? null,
      safeCards[3] ?? null, safeCards[2] ?? null,
      safeCards[5] ?? null, safeCards[4] ?? null
    ];
  }

  function desktopCardMarkup(card, index){
    if(!card){
      return `
        <article class="price-screen__desktop-card price-screen__desktop-card--empty" aria-label="بطاقة سعر فارغة">
          <header class="price-screen__desktop-card-head"><span>—</span></header>
          <div class="price-screen__desktop-rate-grid">
            <div class="price-screen__desktop-rate-cell"><span>مبيع</span><strong>—</strong></div>
            <div class="price-screen__desktop-rate-cell"><span>شراء</span><strong>—</strong></div>
          </div>
        </article>
      `;
    }

    const buyValue = formatRowCellValue(card.row, 'buy', 6);
    const sellValue = formatRowCellValue(card.row, 'sell', 6);
    const interactiveAttrs = card.interactive
      ? ' data-price-screen-counterpart-card="true" role="button" tabindex="0" aria-label="تعديل سعر عملة التسعير" title="تعديل سعر عملة التسعير"'
      : '';

    return `
      <article class="price-screen__desktop-card${card.interactive ? ' price-screen__desktop-card--interactive' : ''}" data-price-card-index="${index}"${interactiveAttrs}>
        <header class="price-screen__desktop-card-head">
          ${flagMarkup(card.baseRow, getDisplayCurrencyName(card.baseRow))}
          <strong class="price-screen__desktop-pair-title">${escapeHtml(card.title)}</strong>
          ${flagMarkup(card.quoteRow, getDisplayCurrencyName(card.quoteRow))}
        </header>
        <div class="price-screen__desktop-rate-grid" aria-label="${escapeHtml(card.title)}">
          <div class="price-screen__desktop-rate-cell price-screen__desktop-rate-cell--sell">
            <span>مبيع</span>
            <strong dir="ltr">${safeControlText(sellValue)}</strong>
          </div>
          <div class="price-screen__desktop-rate-cell price-screen__desktop-rate-cell--buy">
            <span>شراء</span>
            <strong dir="ltr">${safeControlText(buyValue)}</strong>
          </div>
        </div>
      </article>
    `;
  }

  function desktopBrandMarkup(){
    return `
      <aside class="price-screen__desktop-brand" aria-label="بطاقة جانبية تحتوي شعار طيف ورمز واتساب">
        <div class="price-screen__desktop-brand-inner">
          <div class="price-screen__desktop-brand-stack" aria-hidden="true">
            <div class="price-screen__desktop-brand-slot price-screen__desktop-brand-slot--image price-screen__desktop-brand-slot--top-logo">
              <div class="price-screen__desktop-brand-slot-inner price-screen__desktop-brand-slot-inner--image price-screen__desktop-brand-slot-inner--top-logo">
                <img class="price-screen__desktop-brand-slot-image price-screen__desktop-brand-slot-image--top-logo" src="assets/branding/taif-price-top-logo.png" alt="" draggable="false" loading="eager" decoding="async">
              </div>
            </div>
            <div class="price-screen__desktop-brand-slot price-screen__desktop-brand-slot--image">
              <div class="price-screen__desktop-brand-slot-inner price-screen__desktop-brand-slot-inner--image">
                <img class="price-screen__desktop-brand-slot-image" src="assets/branding/taif-price-whatsapp-qr.jpg" alt="" draggable="false" loading="eager" decoding="async">
              </div>
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  function renderDesktopPriceBoard(source){
    const cards = buildDesktopCards(source);
    const orderedCards = orderDesktopCardsForGrid(cards);
    return `
      <section class="price-screen price-screen--desktop-board" aria-label="شاشة الأسعار الجديدة للديسكتوب">
        <div class="price-screen__desktop-title">شركة طيف للصرافة و الحوالات المالية</div>
        <div class="price-screen__desktop-body">
          <div class="price-screen__desktop-cards" aria-label="بطاقات أسعار العملات">
            ${orderedCards.map((card, index) => desktopCardMarkup(card, index)).join('')}
          </div>
          ${desktopBrandMarkup()}
        </div>
        <div class="price-screen__desktop-footer">كافة الخدمات والحوالات المالية السريعة متاحة الآن</div>
      </section>
    `;
  }

  function mobileCardMarkup(card, index){
    if(!card){
      return `
        <article class="price-screen__mobile-card price-screen__mobile-card--empty" aria-label="بطاقة سعر فارغة">
          <header class="price-screen__mobile-card-head"><span>—</span></header>
          <div class="price-screen__mobile-rate-grid">
            <div class="price-screen__mobile-rate-cell"><span>مبيع</span><strong>—</strong></div>
            <div class="price-screen__mobile-rate-cell"><span>شراء</span><strong>—</strong></div>
          </div>
        </article>
      `;
    }

    const buyValue = formatRowCellValue(card.row, 'buy', 6);
    const sellValue = formatRowCellValue(card.row, 'sell', 6);
    const interactiveAttrs = card.interactive
      ? ' data-price-screen-counterpart-card="true" role="button" tabindex="0" aria-label="تعديل سعر عملة التسعير" title="تعديل سعر عملة التسعير"'
      : '';

    return `
      <article class="price-screen__mobile-card${card.interactive ? ' price-screen__mobile-card--interactive' : ''}" data-price-card-index="${index}"${interactiveAttrs}>
        <header class="price-screen__mobile-card-head">
          ${flagMarkup(card.baseRow, getDisplayCurrencyName(card.baseRow))}
          <strong class="price-screen__mobile-pair-title">${escapeHtml(card.title)}</strong>
          ${flagMarkup(card.quoteRow, getDisplayCurrencyName(card.quoteRow))}
        </header>
        <div class="price-screen__mobile-rate-grid" aria-label="${escapeHtml(card.title)}">
          <div class="price-screen__mobile-rate-cell price-screen__mobile-rate-cell--sell">
            <span>مبيع</span>
            <strong dir="ltr">${safeControlText(sellValue)}</strong>
          </div>
          <div class="price-screen__mobile-rate-cell price-screen__mobile-rate-cell--buy">
            <span>شراء</span>
            <strong dir="ltr">${safeControlText(buyValue)}</strong>
          </div>
        </div>
      </article>
    `;
  }

  function mobileBrandMarkup(){
    return `
      <aside class="price-screen__mobile-brand" aria-label="بطاقة سفلية تحتوي شعار طيف ورمز واتساب">
        <div class="price-screen__mobile-brand-inner">
          <div class="price-screen__mobile-brand-slot price-screen__mobile-brand-slot--image price-screen__mobile-brand-slot--top-logo">
            <div class="price-screen__mobile-brand-slot-inner price-screen__mobile-brand-slot-inner--image price-screen__mobile-brand-slot-inner--top-logo">
              <img class="price-screen__mobile-brand-slot-image price-screen__mobile-brand-slot-image--top-logo" src="assets/branding/taif-price-top-logo.png" alt="" draggable="false" loading="eager" decoding="async">
            </div>
          </div>
          <div class="price-screen__mobile-brand-slot price-screen__mobile-brand-slot--image">
            <div class="price-screen__mobile-brand-slot-inner price-screen__mobile-brand-slot-inner--image">
              <img class="price-screen__mobile-brand-slot-image" src="assets/branding/taif-price-whatsapp-qr.jpg" alt="" draggable="false" loading="eager" decoding="async">
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  function renderMobilePriceBoard(source){
    const cards = buildDesktopCards(source);
    const orderedCards = orderDesktopCardsForGrid(cards);
    return `
      <section class="price-screen price-screen--mobile-board" aria-label="شاشة الأسعار للموبايل">
        <div class="price-screen__mobile-title">شركة طيف للصرافة و الحوالات المالية</div>
        <div class="price-screen__mobile-body">
          <div class="price-screen__mobile-cards" aria-label="بطاقات أسعار العملات">
            ${orderedCards.map((card, index) => mobileCardMarkup(card, index)).join('')}
          </div>
          ${mobileBrandMarkup()}
        </div>
        <div class="price-screen__mobile-footer">كافة الخدمات والحوالات المالية السريعة متاحة الآن</div>
      </section>
    `;
  }

  function openCounterpartRateEditorFromPriceScreen(){
    const manager = TAIF.currencyManagement || {};
    const featureManager = TAIF.currencyManagementFeature || {};
    const opener = typeof manager.openCounterpartRateEditor === 'function'
      ? manager.openCounterpartRateEditor
      : featureManager.openCounterpartRateEditor;

    if(typeof opener === 'function'){
      opener({ source: 'price-screen' });
      return;
    }

    if(typeof featureManager.showToast === 'function'){
      featureManager.showToast('تعذر فتح نافذة تعديل سعر عملة التسعير حاليًا.', 'danger');
    }
  }

  function bindInteractions(panel){
    cleanupInteractions();
    if(!(panel instanceof HTMLElement)) return;

    const handleClick = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const card = target ? target.closest('[data-price-screen-counterpart-card="true"]') : null;
      if(!card || !panel.contains(card)) return;
      event.preventDefault();
      event.stopPropagation();
      openCounterpartRateEditorFromPriceScreen();
    };

    const handleKeyDown = (event) => {
      if(event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target instanceof Element ? event.target : null;
      const card = target ? target.closest('[data-price-screen-counterpart-card="true"]') : null;
      if(!card || !panel.contains(card)) return;
      event.preventDefault();
      event.stopPropagation();
      openCounterpartRateEditorFromPriceScreen();
    };

    panel.addEventListener('click', handleClick);
    panel.addEventListener('keydown', handleKeyDown);
    runtime.interactionCleanup = () => {
      panel.removeEventListener('click', handleClick);
      panel.removeEventListener('keydown', handleKeyDown);
    };
  }

  function renderPriceScreen(panel){
    cleanupInteractions();
    runtime.panel = panel;
    const source = readCurrencyManagementRows();

    panel.innerHTML = `
      ${renderDesktopPriceBoard(source)}
      ${renderMobilePriceBoard(source)}
    `;

    bindInteractions(panel);
  }

  function handleCurrencyManagementUpdate(){
    scheduleRefresh();
  }

  function bindGlobalListeners(){
    if(runtime.listenersBound) return;
    runtime.listenersBound = true;
    const events = TAIF.core && TAIF.core.events;
    runtime.currencyEventsCleanup = events && typeof events.on === 'function'
      ? events.on(events.EVENT_NAMES.CURRENCY_UPDATED, handleCurrencyManagementUpdate)
      : null;
    if(!runtime.currencyEventsCleanup){
      window.addEventListener('taif:currency-domain-updated', handleCurrencyManagementUpdate);
    }
  }

  function unbindGlobalListeners(){
    if(!runtime.listenersBound) return;
    if(typeof runtime.currencyEventsCleanup === 'function'){
      runtime.currencyEventsCleanup();
      runtime.currencyEventsCleanup = null;
    }else{
      window.removeEventListener('taif:currency-domain-updated', handleCurrencyManagementUpdate);
    }
    runtime.listenersBound = false;
  }

  function cleanupView(){
    cleanupInteractions();
    runtime.refreshScheduler?.cancel?.();
    runtime.refreshScheduler = null;
    runtime.panel = null;
    unbindGlobalListeners();
  }

  TAIF.registerViewCleanup('price-screen', cleanupView);
  TAIF.registerViewRenderer('price-screen', ({ panel }) => {
    bindGlobalListeners();
    renderPriceScreen(panel);
  });
})();
