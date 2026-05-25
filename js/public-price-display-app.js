(()=>{
  'use strict';

  const root = window;
  const TAIF = root.TAIF || (root.TAIF = {});
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');

  const DEFAULT_RPC_NAME = 'taif_public_price_display_state';
  const DEFAULT_STATE_KEY = 'taif-currency-management-module-v1';

  let initialized = false;
  let pollTimer = 0;
  let consecutiveFailures = 0;
  let lastStateSignature = '';
  let refreshInFlight = false;
  let refreshQueued = false;
  let lastRefreshAt = '';
  let stopped = false;

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function toText(value){
    return String(value ?? '').trim();
  }

  function normalizeUrl(url){
    return toText(url).replace(/\/+$/,'');
  }

  function getApiBaseUrl(){
    return normalizeUrl(config.API_BASE_URL || config.apiBaseUrl || config.CLOUDFLARE_API_URL || config.cloudflareApiUrl || '');
  }

  function getWorkspaceId(){
    return toText(config.WORKSPACE_ID || config.workspaceId || config.ORG_ID || 'default') || 'default';
  }

  function getStateKey(){
    return toText(config.STATE_KEY || config.stateKey || DEFAULT_STATE_KEY) || DEFAULT_STATE_KEY;
  }

  function buildRpcUrl(rpcName){
    const base = getApiBaseUrl();
    if(!base) throw new Error('رابط Cloudflare Worker غير مضبوط في js/config.js');
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${base}/api/rpc/${encodeURIComponent(toText(rpcName))}?_taifPublicDisplayTs=${encodeURIComponent(nonce)}`;
  }

  function stableStringify(value){
    if(value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function stateSignature(state){
    if(!state || typeof state !== 'object') return '';
    const rev = state.__taifDisplayRevision ?? state.__taifDomainRevision ?? state.revision;
    const hash = state.__taifDisplayPayloadHash ?? state.payloadHash ?? state.payload_hash;
    const updated = state.updatedAt ?? state.updated_at ?? state.__taifDisplayUpdatedAt;
    if(rev || hash || updated) return `${rev || ''}:${hash || ''}:${updated || ''}`;
    return stableStringify(state);
  }

  function isPlainObject(value){
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function hasCurrencyPayload(value){
    return isPlainObject(value) && Array.isArray(value.currencies);
  }

  function attachEnvelopeMeta(payload, envelope = {}){
    if(!hasCurrencyPayload(payload)) return null;
    const output = { ...payload };
    const revision = envelope.revision ?? envelope.__taifDisplayRevision ?? envelope.__taifDomainRevision;
    const hash = envelope.payloadHash ?? envelope.payload_hash ?? envelope.__taifDisplayPayloadHash;
    const updated = envelope.updatedAt ?? envelope.updated_at ?? envelope.logicalUpdatedAt ?? envelope.logical_updated_at ?? envelope.__taifDisplayUpdatedAt;
    if(revision !== undefined && revision !== null && revision !== ''){
      output.__taifDisplayRevision = Number(revision) || 0;
      output.__taifDomainRevision = Number(revision) || 0;
      output.revision = Number(revision) || output.revision || 0;
    }
    if(hash !== undefined && hash !== null){
      output.__taifDisplayPayloadHash = toText(hash);
      output.payloadHash = toText(hash);
      output.payload_hash = toText(hash);
    }
    if(updated !== undefined && updated !== null){
      output.__taifDisplayUpdatedAt = toText(updated);
      output.updatedAt = output.updatedAt || toText(updated);
      output.updated_at = output.updated_at || toText(updated);
    }
    return output;
  }

  function pickStateRowFromArray(states){
    if(!Array.isArray(states)) return null;
    const wantedKey = getStateKey();
    const matching = states.find((item) => {
      const key = toText(item?.stateKey || item?.state_key || item?.key || item?.state_key_name);
      return key === wantedKey;
    });
    if(matching) return matching;
    return states.find((item) => hasCurrencyPayload(item?.payload) || hasCurrencyPayload(item?.state) || hasCurrencyPayload(item)) || null;
  }

  function unwrapStateEnvelope(value, depth = 0){
    if(depth > 6 || !isPlainObject(value)) return null;
    if(value.ok === false) return null;

    if(Array.isArray(value.states)){
      const row = pickStateRowFromArray(value.states);
      if(row){
        const payload = hasCurrencyPayload(row.payload) ? row.payload : (hasCurrencyPayload(row.state) ? row.state : row);
        return attachEnvelopeMeta(payload, {
          revision: row.revision ?? value.revision,
          payloadHash: row.payloadHash ?? row.payload_hash ?? value.payloadHash ?? value.payload_hash,
          updatedAt: row.updatedAt ?? row.updated_at ?? row.logicalUpdatedAt ?? row.logical_updated_at ?? value.updatedAt ?? value.updated_at
        });
      }
    }

    if(hasCurrencyPayload(value.state)){
      return attachEnvelopeMeta(value.state, value);
    }
    if(hasCurrencyPayload(value.payload)){
      return attachEnvelopeMeta(value.payload, value);
    }
    if(hasCurrencyPayload(value.data)){
      return attachEnvelopeMeta(value.data, value);
    }
    if(hasCurrencyPayload(value)){
      return attachEnvelopeMeta(value, value);
    }
    if(isPlainObject(value.data)) return unwrapStateEnvelope(value.data, depth + 1);
    if(isPlainObject(value.result)) return unwrapStateEnvelope(value.result, depth + 1);
    return null;
  }

  async function callRpc(rpcName){
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = Math.max(5000, Number(config.REQUEST_TIMEOUT_MS || config.requestTimeoutMs || 12000));
    const timeoutId = controller ? root.setTimeout(() => controller.abort(), timeoutMs) : 0;
    const headers = {
      'Content-Type':'application/json',
      'Accept':'application/json',
      'Cache-Control':'no-store, no-cache, max-age=0',
      'Pragma':'no-cache'
    };
    const appKey = toText(config.APP_KEY || config.appKey || '');
    if(appKey) headers.Authorization = `Bearer ${appKey}`;
    const workspaceId = getWorkspaceId();
    const stateKey = getStateKey();
    const body = {
      target_workspace: workspaceId,
      p_workspace_id: workspaceId,
      workspaceId,
      p_state_key: stateKey,
      stateKey,
      publicDisplay: true
    };

    try{
      const response = await fetch(buildRpcUrl(rpcName), {
        method:'POST',
        headers,
        body:JSON.stringify(body),
        cache:'no-store',
        credentials:'omit',
        keepalive:false,
        signal:controller ? controller.signal : undefined
      });
      const text = await response.text();
      let data = null;
      if(text){
        try{ data = JSON.parse(text); }catch{ data = text; }
      }
      if(!response.ok){
        const message = toText(data?.message || data?.error || data) || `فشل الاتصال (${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.details = data;
        throw error;
      }
      return data;
    }catch(error){
      if(error && error.name === 'AbortError'){
        throw new Error('انتهت مهلة الاتصال بخدمة Cloudflare.');
      }
      throw error;
    }finally{
      if(timeoutId) try{ root.clearTimeout(timeoutId); }catch{}
    }
  }

  async function fetchState(){
    const rpcName = toText(config.RPC_NAME || config.rpcName || DEFAULT_RPC_NAME) || DEFAULT_RPC_NAME;
    return unwrapStateEnvelope(await callRpc(rpcName));
  }

  function sanitizeFetchedState(value){
    const state = unwrapStateEnvelope(value) || value;
    if(!state || typeof state !== 'object') return null;
    if(Array.isArray(state)) return null;
    if(!Array.isArray(state.currencies)) return null;
    if(!Array.isArray(state.rateBooks)) state.rateBooks = [];
    if(!Array.isArray(state.pairRegistry)) state.pairRegistry = [];
    if(!Array.isArray(state.rateRecords)) state.rateRecords = [];
    return state;
  }

  function renderPriceScreen(force = false){
    if(!panel || !TAIF.__viewRenderers || typeof TAIF.__viewRenderers['price-screen'] !== 'function') return;
    try{
      TAIF.__viewRenderers['price-screen']({ panel, force });
      initialized = true;
    }catch(error){
      console.error('[TAIF public display] render failed', error);
      showStatus('تعذر عرض شاشة الأسعار', true);
    }
  }

  function currentBaseInterval(){
    return Math.max(2500, Number(config.POLL_INTERVAL_MS || config.pollIntervalMs || 4000));
  }

  function nextDelay(){
    if(!consecutiveFailures) return currentBaseInterval();
    return Math.min(30000, currentBaseInterval() * Math.max(2, consecutiveFailures));
  }

  function scheduleNextPoll(delay = nextDelay()){
    if(stopped) return;
    if(pollTimer) root.clearTimeout(pollTimer);
    pollTimer = root.setTimeout(() => refresh('poll'), Math.max(500, Number(delay) || currentBaseInterval()));
  }

  async function refresh(reason = 'poll'){
    if(stopped) return;
    if(refreshInFlight){
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    try{
      const rawState = await fetchState();
      const nextState = sanitizeFetchedState(rawState);
      if(nextState){
        const signature = stateSignature(nextState);
        if(signature && signature === lastStateSignature && initialized){
          consecutiveFailures = 0;
          lastRefreshAt = new Date().toISOString();
          showStatus('');
          return;
        }
        lastStateSignature = signature || stableStringify(nextState);
        root.__TAIF_PUBLIC_STATE__ = nextState;
        consecutiveFailures = 0;
        lastRefreshAt = new Date().toISOString();
        showStatus('');
        renderPriceScreen(reason === 'first');
        TAIF.core?.events?.emit?.('taif:currency-domain-updated', { state: nextState, source:'public-display-cloudflare', reason });
        return;
      }
      if(!initialized) showStatus('لا توجد بيانات أسعار منشورة بعد', true);
    }catch(error){
      consecutiveFailures += 1;
      console.warn('[TAIF public display] refresh failed', error);
      if(consecutiveFailures >= 2){
        showStatus('تعذر تحديث الأسعار من Cloudflare، سيتم إعادة المحاولة تلقائيًا', true);
      }
    }finally{
      refreshInFlight = false;
      if(refreshQueued){
        refreshQueued = false;
        root.setTimeout(() => refresh('queued'), 120);
      }else{
        scheduleNextPoll();
      }
    }
  }

  function start(){
    showStatus('جاري تحميل أسعار طيف...', Boolean(config.SHOW_STATUS));
    refresh('first');
    root.addEventListener('online', () => refresh('online'));
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') refresh('visible');
    });
    root.addEventListener('focus', () => refresh('focus'));
    root.addEventListener('pageshow', () => refresh('pageshow'));
    root.addEventListener('beforeunload', () => {
      stopped = true;
      if(pollTimer) root.clearTimeout(pollTimer);
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    });
  }

  TAIF.publicPriceDisplay = Object.assign(TAIF.publicPriceDisplay || {}, {
    refresh:() => refresh('manual'),
    diagnostics:() => ({
      initialized,
      consecutiveFailures,
      apiBaseUrl:getApiBaseUrl(),
      workspaceId:getWorkspaceId(),
      stateKey:getStateKey(),
      stateSignature:lastStateSignature,
      lastRefreshAt,
      inFlight:refreshInFlight
    })
  });

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();
