// TAIF Cloudflare Worker + D1 API
// يحافظ على نفس أسماء عمليات RPC التي تستخدمها الواجهة، لكن التنفيذ بالكامل على Cloudflare D1.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-taif-app-key,accept,cache-control,pragma',
  'access-control-max-age': '86400',
  'vary': 'Origin'
};
const DEFAULT_WORKSPACE_ID = 'default';
const SESSION_DAYS = 30;
const ROLES = new Set(['admin', 'manager', 'cashier', 'viewer']);
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const BOOTSTRAP_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const DOMAIN_SYNC_AUDIT_ENABLED = false;
let bootstrapLastOkAt = 0;
let bootstrapPromise = null;

const DOMAIN_KEYS = Object.freeze({
  chartAccounts:'taif-chart-of-accounts-centers-v3',
  accountSequence:'taif-chart-of-accounts-account-sequence-v1',
  currency:'taif-currency-management-module-v1',
  cashBoxes:'taif-cash-boxes-module-v1',
  customerCard:'taif-customer-card-module-v1',
  entries:'taif-entries-vouchers-module-v1',
  salesPurchase:'taif-sales-purchase-invoice-records-v1'
});
const REFERENCE_STATE_KEYS = new Set([DOMAIN_KEYS.chartAccounts, DOMAIN_KEYS.accountSequence, DOMAIN_KEYS.currency, DOMAIN_KEYS.cashBoxes]);
const RECORD_STATE_KEYS = new Set([DOMAIN_KEYS.customerCard, DOMAIN_KEYS.entries, DOMAIN_KEYS.salesPurchase]);
const DEFAULT_ACCOUNT_BASE_TS = 1700000000000;
const DEFAULT_ACCOUNT_SEEDS = Object.freeze([
  { id:'coa-default-001', accountNo:'001', name:'صندوق محلي اساسي', offsetMs:1080000 },
  { id:'coa-default-003', accountNo:'002', name:'عملات مدفوعة', offsetMs:960000 },
  { id:'coa-default-004', accountNo:'003', name:'عملات محققة', offsetMs:900000 },
  { id:'coa-default-005', accountNo:'004', name:'حوالات لم تسلم', offsetMs:840000 },
  { id:'coa-default-006', accountNo:'005', name:'حسابات القطع الأجنبي', offsetMs:780000 },
  { id:'coa-default-007', accountNo:'006', name:'رأس المال المدفوع', offsetMs:720000 },
  { id:'coa-default-008', accountNo:'007', name:'مصاريف', offsetMs:660000 }
]);
const DEFAULT_ACCOUNT_COUNT = DEFAULT_ACCOUNT_SEEDS.length;

function clonePlain(value) {
  if (value == null || typeof value !== 'object') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch {}
  return Array.isArray(value) ? value.slice() : { ...value };
}
function taifHashText(input) {
  const value = String(input ?? '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function taifPayloadHash(payload) { return taifHashText(stringify(payload)); }

const VOLATILE_COMPARE_KEYS = new Set([
  'updatedAt', 'updated_at', 'modifiedAt', 'modified_at', 'logicalUpdatedAt', 'logical_updated_at',
  'effectiveAt', 'effective_at', '__taifSyncUpdatedAt', 'taifSyncUpdatedAt', '__taifSyncHash',
  'lastPulledAt', 'lastSyncedAt', 'syncedAt'
]);
function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
function stripVolatileForCompare(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripVolatileForCompare);
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    if (VOLATILE_COMPARE_KEYS.has(key)) return;
    output[key] = stripVolatileForCompare(value[key]);
  });
  return output;
}
function canonicalPayloadHash(payload) {
  return taifHashText(stableStringify(stripVolatileForCompare(payload)));
}
function numericTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function recordTime(record) {
  const raw = record && typeof record === 'object' ? record : {};
  return Math.max(
    numericTime(raw.__taifSyncUpdatedAt),
    numericTime(raw.taifSyncUpdatedAt),
    numericTime(raw.updatedAt),
    numericTime(raw.updated_at),
    numericTime(raw.modifiedAt),
    numericTime(raw.modified_at),
    numericTime(raw.createdAt),
    numericTime(raw.created_at),
    numericTime(raw.date)
  );
}
function recordIdentity(record, index = 0) {
  const raw = record && typeof record === 'object' ? record : {};
  const candidates = [
    raw.id, raw.recordId, raw.uuid, raw.number, raw.voucherNumber, raw.invoiceNumber,
    raw.invoiceNo, raw.code, raw.accountNo, raw.sourceSalesPurchaseRecordId, raw.sourceSalesPurchaseNumber
  ].map(text).filter(Boolean);
  return candidates[0] || `hash:${taifPayloadHash(raw)}:${index}`;
}
function normalizeDeletedMap(value) {
  const result = {};
  const source = value && typeof value === 'object' ? value : {};
  Object.entries(source).forEach(([id, stamp]) => {
    const safeId = text(id);
    const numeric = Number(stamp);
    if (safeId && Number.isFinite(numeric) && numeric > 0) result[safeId] = Math.max(Number(result[safeId]) || 0, numeric);
  });
  return result;
}
function payloadDeletedMap(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  return {
    ...normalizeDeletedMap(raw.__taifSync && raw.__taifSync.deleted),
    ...normalizeDeletedMap(raw.taifSyncDeleted),
    ...normalizeDeletedMap(raw.__taifDeleted)
  };
}
function mergeDeletedMaps(...maps) {
  const result = {};
  maps.forEach((map) => {
    Object.entries(normalizeDeletedMap(map)).forEach(([id, stamp]) => {
      result[id] = Math.max(Number(result[id]) || 0, Number(stamp) || 0);
    });
  });
  return result;
}
function attachDeletedMap(payload, deletedMap) {
  const output = payload && typeof payload === 'object' && !Array.isArray(payload) ? clonePlain(payload) : {};
  const clean = normalizeDeletedMap(deletedMap);
  const currentSync = output.__taifSync && typeof output.__taifSync === 'object' ? clonePlain(output.__taifSync) : {};
  if (Object.keys(clean).length) output.__taifSync = { ...currentSync, deleted: clean };
  else if (output.__taifSync) {
    delete currentSync.deleted;
    if (Object.keys(currentSync).length) output.__taifSync = currentSync;
    else delete output.__taifSync;
  }
  delete output.__taifDeleted;
  delete output.taifSyncDeleted;
  return output;
}
function mergeRecordArraysServer(existingRecords, incomingRecords, deletedMap = {}, identity = recordIdentity) {
  const map = new Map();
  const order = [];
  const tombstones = normalizeDeletedMap(deletedMap);
  function put(record, source, index) {
    if (!record || typeof record !== 'object') return;
    const id = text(identity(record, index));
    if (!id) return;
    const next = clonePlain(record);
    const nextTime = recordTime(next);
    const deletedAt = Number(tombstones[id]) || 0;
    if (deletedAt && deletedAt >= nextTime) return;
    if (!map.has(id)) order.push(id);
    const previous = map.get(id);
    if (!previous) { map.set(id, next); return; }
    const previousTime = recordTime(previous);
    if (nextTime > previousTime || (nextTime === previousTime && source === 'incoming')) {
      map.set(id, { ...clonePlain(previous), ...next });
    }
  }
  (Array.isArray(existingRecords) ? existingRecords : []).forEach((record, index) => put(record, 'existing', index));
  (Array.isArray(incomingRecords) ? incomingRecords : []).forEach((record, index) => put(record, 'incoming', index));
  return order.map((id) => map.get(id)).filter(Boolean);
}
function mergeCounterObjects(existingCounters, incomingCounters, records) {
  const result = { ...(existingCounters && typeof existingCounters === 'object' ? existingCounters : {}) };
  Object.entries(incomingCounters && typeof incomingCounters === 'object' ? incomingCounters : {}).forEach(([key, value]) => {
    const numericIncoming = Number(value);
    const numericExisting = Number(result[key]);
    if (Number.isFinite(numericIncoming)) result[key] = Math.max(Number.isFinite(numericExisting) ? numericExisting : 0, numericIncoming);
    else if (!(key in result)) result[key] = value;
  });
  (Array.isArray(records) ? records : []).forEach((record) => {
    const numberText = text(record?.number || record?.voucherNumber || record?.invoiceNumber || record?.invoiceNo);
    const match = numberText.match(/^([A-Za-z]+)[-\s]*([0-9]+)/);
    if (!match) return;
    const prefix = match[1].toUpperCase();
    const nextNumber = Number(match[2]) + 1;
    if (Number.isFinite(nextNumber) && nextNumber > 0) result[prefix] = Math.max(Number(result[prefix]) || 1, nextNumber);
  });
  return result;
}
function collectionId(prefix, record, index = 0, candidates = []) {
  const raw = record && typeof record === 'object' ? record : {};
  const value = candidates.map((key) => raw[key]).map(text).find(Boolean) || recordIdentity(raw, index);
  return `${prefix}:${String(value || '').toUpperCase()}`;
}
function mergeCollectionPayload(existingPayload, incomingPayload, specs) {
  const existing = existingPayload && typeof existingPayload === 'object' && !Array.isArray(existingPayload) ? clonePlain(existingPayload) : {};
  const incoming = incomingPayload && typeof incomingPayload === 'object' && !Array.isArray(incomingPayload) ? clonePlain(incomingPayload) : {};
  const deleted = mergeDeletedMaps(payloadDeletedMap(existing), payloadDeletedMap(incoming));
  let output = { ...existing, ...incoming };
  specs.forEach((spec) => {
    const existingRecords = Array.isArray(existing[spec.prop]) ? existing[spec.prop] : [];
    const incomingRecords = Array.isArray(incoming[spec.prop]) ? incoming[spec.prop] : [];
    output[spec.prop] = mergeRecordArraysServer(existingRecords, incomingRecords, deleted, (record, index) => collectionId(spec.prefix, record, index, spec.candidates || []));
  });
  output.updatedAt = Math.max(numericTime(existing.updatedAt), numericTime(incoming.updatedAt), Date.now());
  return attachDeletedMap(output, deleted);
}
function defaultAccountRecords() {
  return DEFAULT_ACCOUNT_SEEDS.map(({ offsetMs, ...seed }) => ({
    accountNo:'', name:'', centerType:'main', centerTypeLocked:false, country:'', city:'', phone:'',
    currencies:'', currencySelectionMode:'all', currencyCodes:[], address:'', imageDataUrl:'', deleted:false,
    ...seed,
    createdAt:DEFAULT_ACCOUNT_BASE_TS - offsetMs,
    updatedAt:DEFAULT_ACCOUNT_BASE_TS - offsetMs
  }));
}
function chartRecordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.records)) return payload.records;
    if (Array.isArray(payload.dataset)) return payload.dataset;
  }
  return [];
}
function ensureDefaultAccountsPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? clonePlain(payload) : { records: chartRecordsFromPayload(payload) };
  const records = chartRecordsFromPayload(source).map((record) => record && typeof record === 'object' ? clonePlain(record) : null).filter(Boolean);
  const byId = new Set(records.map((record) => text(record.id)).filter(Boolean));
  const byAccountNo = new Set(records.map((record) => text(record.accountNo || record.account_no)).filter(Boolean));
  let changed = false;
  defaultAccountRecords().forEach((record) => {
    const id = text(record.id);
    const accountNo = text(record.accountNo);
    if (byId.has(id) || byAccountNo.has(accountNo)) return;
    records.push(record);
    byId.add(id);
    byAccountNo.add(accountNo);
    changed = true;
  });
  records.sort((left, right) => (text(left.accountNo).localeCompare(text(right.accountNo), 'en')) || (recordTime(left) - recordTime(right)));
  return {
    ...source,
    records,
    updatedAt: changed ? Date.now() : (Number(source.updatedAt) || 0),
    __taifOnlineSeed:true
  };
}
function normalizeSequencePayload(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload };
  const numeric = Math.max(Number(raw.value ?? raw.next ?? raw.sequence ?? 0) || 0, DEFAULT_ACCOUNT_COUNT);
  return { ...raw, value:numeric, updatedAt:Math.max(numericTime(raw.updatedAt), 0), __taifOnlineSeed:true };
}
function normalizeDomainStatePayloadForStorage(key, incomingPayload, existingPayload = null) {
  const safeKey = text(key);
  const incoming = incomingPayload && typeof incomingPayload === 'object' ? clonePlain(incomingPayload) : {};
  const existing = existingPayload && typeof existingPayload === 'object' ? clonePlain(existingPayload) : null;
  if (safeKey === DOMAIN_KEYS.chartAccounts) {
    const merged = existing ? mergeCollectionPayload(existing, { records:chartRecordsFromPayload(incoming), ...incoming }, [{ prop:'records', prefix:'centers', candidates:['id','accountNo','account_no','code','name'] }]) : incoming;
    return ensureDefaultAccountsPayload(merged);
  }
  if (safeKey === DOMAIN_KEYS.accountSequence) {
    const existingValue = normalizeSequencePayload(existing || {});
    const incomingValue = normalizeSequencePayload(incoming || {});
    return normalizeSequencePayload({ ...existingValue, ...incomingValue, value:Math.max(Number(existingValue.value) || 0, Number(incomingValue.value) || 0) });
  }
  if (safeKey === DOMAIN_KEYS.currency) {
    return existing ? mergeCollectionPayload(existing, incoming, [
      { prop:'currencies', prefix:'currencies', candidates:['code','currencyCode','currency_code','id'] },
      { prop:'rateBooks', prefix:'rateBooks', candidates:['code','bookCode','book_code','id'] },
      { prop:'pairRegistry', prefix:'pairRegistry', candidates:['id','pairId','pair_id','baseCode','quoteCode'] },
      { prop:'rateRecords', prefix:'rateRecords', candidates:['id','pairId','pair_id','bookCode','book_code'] }
    ]) : incoming;
  }
  if (safeKey === DOMAIN_KEYS.cashBoxes) {
    return existing ? mergeCollectionPayload(existing, incoming, [
      { prop:'boxes', prefix:'boxes', candidates:['id','linkedAccountNo','linked_account_no','accountNo','account_no','code'] }
    ]) : incoming;
  }
  if (safeKey === DOMAIN_KEYS.customerCard || safeKey === DOMAIN_KEYS.entries || safeKey === DOMAIN_KEYS.salesPurchase) {
    if (!existing) return incoming;
    const deleted = mergeDeletedMaps(payloadDeletedMap(existing), payloadDeletedMap(incoming));
    const records = mergeRecordArraysServer(existing.records, incoming.records, deleted);
    const maxRecordSequence = records.reduce((max, record) => Math.max(max, Number(record?.sequence) || 0), 0);
    return attachDeletedMap({
      ...existing,
      ...incoming,
      records,
      counters:mergeCounterObjects(existing.counters, incoming.counters, records),
      sequence:Math.max(Number(existing.sequence) || 0, Number(incoming.sequence) || 0, maxRecordSequence),
      updatedAt:Math.max(numericTime(existing.updatedAt), numericTime(incoming.updatedAt), Date.now())
    }, deleted);
  }
  return incoming;
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'taif-cloudflare-d1', at: nowIso() });
      }
      const match = url.pathname.match(/^\/api\/rpc\/([^/]+)$/);
      if (!match) return json({ ok: false, message: 'Not found' }, 404);
      if (!env.DB) return json({ ok: false, message: 'Cloudflare D1 binding DB غير موجود.' }, 500);
      const name = decodeURIComponent(match[1] || '').trim();
      if (request.method === 'GET' && name === 'taif_public_price_display_state') {
        assertAppKey(request, env);
        await ensureBootstrapGuarded(env.DB);
        const payload = {};
        url.searchParams.forEach((value, key) => { payload[key] = value; });
        const result = await dispatchRpc(env.DB, name, payload || {});
        return json(result ?? { ok: true });
      }
      if (request.method !== 'POST') return json({ ok: false, message: 'Not found' }, 404);
      assertAppKey(request, env);
      await ensureBootstrapGuarded(env.DB);
      const payload = await readJson(request);
      const result = await dispatchRpc(env.DB, name, payload || {});
      return json(result ?? { ok: true });
    } catch (error) {
      const safeError = /** @type {any} */ (error || {});
      const status = Number(safeError.status) || 500;
      return json({ ok: false, message: safeError.message || 'تعذر تنفيذ العملية.', code: safeError.code || '' }, status);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS } });
}
function fail(message, status = 400, code = '') {
  const error = /** @type {any} */ (new Error(message));
  error.status = status;
  error.code = code;
  throw error;
}
function nowIso() { return new Date().toISOString(); }
function addDays(date, days) { return new Date(date.getTime() + days * 86400000).toISOString(); }
function text(value) { return String(value ?? '').trim(); }
function normUsername(value) { return text(value).toLowerCase(); }
function workspaceId(value) { return text(value || DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID; }
function boolInt(value) { return value === true || value === 1 || value === '1' ? 1 : 0; }
function parseJson(raw, fallback = null) { try { return raw ? JSON.parse(String(raw)) : fallback; } catch { return fallback; } }
function stringify(value) { return JSON.stringify(value ?? null); }
async function readJson(request) { const raw = await request.text(); return raw ? JSON.parse(raw) : {}; }
function assertAppKey(request, env) {
  const required = text(env.TAIF_APP_KEY || '');
  if (!required) return;
  const header = text(request.headers.get('authorization')).replace(/^Bearer\s+/i, '') || text(request.headers.get('x-taif-app-key'));
  if (header !== required) fail('مفتاح تطبيق Cloudflare غير صحيح.', 401, 'INVALID_APP_KEY');
}
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password) {
  const salt = crypto.randomUUID().replace(/-/g, '');
  const hash = await sha256Hex(`${salt}:${password}`);
  return `taif$sha256$${salt}$${hash}`;
}
async function verifyPassword(password, stored) {
  const parts = text(stored).split('$');
  if (parts.length === 4 && parts[0] === 'taif' && parts[1] === 'sha256') {
    return await sha256Hex(`${parts[2]}:${password}`) === parts[3];
  }
  return false;
}
function userToJson(row) {
  if (!row) return null;
  const displayName = text(row.display_name || row.displayName || row.username);
  return {
    id: text(row.id),
    userId: text(row.id),
    user_id: text(row.id),
    username: text(row.username),
    displayName,
    display_name: displayName,
    fullName: displayName,
    full_name: displayName,
    name: displayName,
    label: displayName || text(row.username),
    role: text(row.role || 'viewer') || 'viewer',
    active: row.active !== 0 && row.active !== false,
    mustChangePassword: row.must_change_password === 1 || row.must_change_password === true,
    must_change_password: row.must_change_password === 1 || row.must_change_password === true,
    lastLoginAt: text(row.last_login_at),
    last_login_at: text(row.last_login_at),
    createdAt: text(row.created_at),
    created_at: text(row.created_at),
    updatedAt: text(row.updated_at),
    updated_at: text(row.updated_at)
  };
}
function stateToJson(row) {
  if (!row) return null;
  const payload = parseJson(row.payload_json, {});
  return {
    workspaceId: text(row.workspace_id), workspace_id: text(row.workspace_id),
    stateKey: text(row.state_key), state_key: text(row.state_key),
    stateKind: text(row.state_kind), state_kind: text(row.state_kind),
    payload,
    payloadHash: text(row.payload_hash), payload_hash: text(row.payload_hash),
    revision: Number(row.revision) || 0,
    logicalUpdatedAt: text(row.logical_updated_at), logical_updated_at: text(row.logical_updated_at),
    updatedBy: text(row.updated_by), updated_by: text(row.updated_by),
    updatedByUsername: text(row.updated_by_username), updated_by_username: text(row.updated_by_username),
    updatedByName: text(row.updated_by_name), updated_by_name: text(row.updated_by_name),
    sourceClientId: text(row.source_client_id), source_client_id: text(row.source_client_id),
    createdAt: text(row.created_at), created_at: text(row.created_at),
    updatedAt: text(row.updated_at), updated_at: text(row.updated_at)
  };
}
function stateMetaToJson(row) {
  if (!row) return null;
  return {
    workspaceId: text(row.workspace_id), workspace_id: text(row.workspace_id),
    stateKey: text(row.state_key), state_key: text(row.state_key),
    stateKind: text(row.state_kind), state_kind: text(row.state_kind),
    payloadHash: text(row.payload_hash), payload_hash: text(row.payload_hash),
    revision: Number(row.revision) || 0,
    logicalUpdatedAt: text(row.logical_updated_at), logical_updated_at: text(row.logical_updated_at),
    sourceClientId: text(row.source_client_id), source_client_id: text(row.source_client_id),
    updatedAt: text(row.updated_at), updated_at: text(row.updated_at)
  };
}
function backupToJson(row, includeSnapshot = false) {
  if (!row) return null;
  return {
    id: text(row.id), workspaceId: text(row.workspace_id), workspace_id: text(row.workspace_id),
    name: text(row.backup_name), backupName: text(row.backup_name), backup_name: text(row.backup_name),
    stateCount: Number(row.state_count) || 0, state_count: Number(row.state_count) || 0,
    createdBy: text(row.created_by), created_by: text(row.created_by),
    createdByUsername: text(row.created_by_username), created_by_username: text(row.created_by_username),
    createdByName: text(row.created_by_name), created_by_name: text(row.created_by_name),
    createdAt: text(row.created_at), created_at: text(row.created_at),
    snapshot: includeSnapshot ? parseJson(row.snapshot_json, {}) : null
  };
}
function auditToJson(row) {
  if (!row) return null;
  return {
    id: text(row.id), workspaceId: text(row.workspace_id), workspace_id: text(row.workspace_id),
    actorId: text(row.actor_id), actor_id: text(row.actor_id),
    actorUsername: text(row.actor_username), actor_username: text(row.actor_username),
    actorName: text(row.actor_name), actor_name: text(row.actor_name),
    action: text(row.action), entityType: text(row.entity_type), entity_type: text(row.entity_type),
    entityId: text(row.entity_id), entity_id: text(row.entity_id),
    createdAt: text(row.created_at), created_at: text(row.created_at),
    details: parseJson(row.details_json, null)
  };
}
async function ensureBootstrapGuarded(db) {
  const current = Date.now();
  if (bootstrapLastOkAt && current - bootstrapLastOkAt < BOOTSTRAP_REFRESH_INTERVAL_MS) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = Promise.resolve()
    .then(() => ensureBootstrap(db))
    .then(() => { bootstrapLastOkAt = Date.now(); })
    .finally(() => { bootstrapPromise = null; });
  return bootstrapPromise;
}

async function ensureBootstrap(db) {
  const row = await db.prepare('select count(*) as count from taif_app_users').first();
  if ((Number(row?.count) || 0) <= 0) {
    const id = crypto.randomUUID();
    const at = nowIso();
    const passwordHash = await hashPassword('admin12345');
    await db.prepare(`insert into taif_app_users(id, username, display_name, role, password_hash, active, must_change_password, created_at, updated_at)
      values(?,?,?,?,?,?,?,?,?)`).bind(id, 'admin', 'مدير النظام', 'admin', passwordHash, 1, 1, at, at).run();
    await insertAudit(db, { workspaceId: DEFAULT_WORKSPACE_ID, actor: null, action: 'bootstrap_admin', entityType: 'user', entityId: id, details: { username: 'admin', temporaryPassword: 'admin12345' } });
  }
  await ensureDefaultWorkspaceDomainState(db, DEFAULT_WORKSPACE_ID);
}

async function ensureDefaultWorkspaceDomainState(db, wid = DEFAULT_WORKSPACE_ID) {
  const safeWid = workspaceId(wid);
  await ensureDefaultDomainStateRow(db, safeWid, DOMAIN_KEYS.chartAccounts, 'reference', ensureDefaultAccountsPayload({ records: [] }));
  await ensureDefaultDomainStateRow(db, safeWid, DOMAIN_KEYS.accountSequence, 'reference', normalizeSequencePayload({ value: DEFAULT_ACCOUNT_COUNT, updatedAt: 0 }));
}

async function ensureDefaultDomainStateRow(db, wid, key, kind, defaultPayload) {
  const existing = await db.prepare('select * from taif_domain_state where workspace_id = ? and state_key = ?').bind(wid, key).first();
  const existingPayload = existing ? parseJson(existing.payload_json, {}) : null;
  const finalPayload = key === DOMAIN_KEYS.chartAccounts
    ? ensureDefaultAccountsPayload(existingPayload || defaultPayload)
    : (key === DOMAIN_KEYS.accountSequence
      ? normalizeSequencePayload(existingPayload || defaultPayload)
      : normalizeDomainStatePayloadForStorage(key, defaultPayload, existingPayload));
  const finalJson = stringify(finalPayload);
  if (existing && String(existing.payload_json || '') === finalJson) return;
  const at = nowIso();
  const payloadHash = taifPayloadHash(finalPayload);
  if (existing) {
    await db.prepare(`update taif_domain_state set state_kind = ?, payload_json = ?, payload_hash = ?, revision = revision + 1,
      logical_updated_at = ?, updated_by = ?, updated_by_username = ?, updated_by_name = ?, source_client_id = ?, updated_at = ?
      where workspace_id = ? and state_key = ?`).bind(kind, finalJson, payloadHash, at, '', 'system', 'system', 'cloudflare-default-seed', at, wid, key).run();
  } else {
    await db.prepare(`insert into taif_domain_state(workspace_id, state_key, state_kind, payload_json, payload_hash, revision, logical_updated_at, updated_by, updated_by_username, updated_by_name, source_client_id, created_at, updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(wid, key, kind, finalJson, payloadHash, 1, at, '', 'system', 'system', 'cloudflare-default-seed', at, at).run();
  }
}
async function getUserBySession(db, token, { required = true } = {}) {
  const sessionToken = text(token);
  if (!sessionToken) {
    if (required) fail('الجلسة غير موجودة. سجل الدخول أولًا.', 401, 'MISSING_SESSION');
    return null;
  }
  const row = await db.prepare(`select u.*, s.session_token, s.expires_at
    from taif_sessions s join taif_app_users u on u.id = s.user_id
    where s.session_token = ? limit 1`).bind(sessionToken).first();
  if (!row || row.active === 0 || new Date(text(row.expires_at)).getTime() <= Date.now()) {
    try { await db.prepare('delete from taif_sessions where session_token = ?').bind(sessionToken).run(); } catch {}
    if (required) fail('انتهت الجلسة. سجل الدخول من جديد.', 401, 'INVALID_SESSION');
    return null;
  }
  const lastSeenMs = numericTime(row.last_seen_at);
  if (!lastSeenMs || Date.now() - lastSeenMs > SESSION_TOUCH_INTERVAL_MS) {
    await db.prepare('update taif_sessions set last_seen_at = ? where session_token = ?').bind(nowIso(), sessionToken).run();
  }
  return row;
}
function requireAdmin(user) { if (text(user?.role) !== 'admin') fail('هذه العملية تحتاج صلاحية مدير.', 403, 'ADMIN_REQUIRED'); }
function requireAuditReader(user) { if (!['admin', 'manager'].includes(text(user?.role))) fail('سجل العمليات متاح للمدير والمشرف فقط.', 403, 'AUDIT_FORBIDDEN'); }
/**
 * @param {any} db
 * @param {any} audit
 */
async function insertAudit(db, audit = {}) {
  const { workspaceId: wid = DEFAULT_WORKSPACE_ID, actor, action, entityType, entityId, details = null } = /** @type {any} */ (audit || {});
  const at = nowIso();
  await db.prepare(`insert into taif_audit_log(id, workspace_id, actor_id, actor_username, actor_name, action, entity_type, entity_id, details_json, created_at)
    values(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), workspaceId(wid), text(actor?.id), text(actor?.username), text(actor?.display_name || actor?.displayName || actor?.username), text(action), text(entityType), text(entityId), stringify(details || null), at).run();
}
async function dispatchRpc(db, name, p) {
  switch (name) {
    case 'taif_login_username': return login(db, p);
    case 'taif_current_session': return currentSession(db, p);
    case 'taif_logout_username': return logout(db, p);
    case 'taif_change_my_password': return changeMyPassword(db, p);
    case 'taif_list_app_users': return listUsers(db, p);
    case 'taif_create_app_user': return createUser(db, p);
    case 'taif_update_app_user': return updateUser(db, p);
    case 'taif_reset_app_user_password': return resetUserPassword(db, p);
    case 'taif_list_domain_state': return listDomainState(db, p);
    case 'taif_list_domain_state_meta': return listDomainStateMeta(db, p);
    case 'taif_get_domain_state': return getDomainState(db, p);
    case 'taif_upsert_domain_state': return upsertDomainState(db, p);
    case 'taif_upsert_domain_state_batch': return upsertDomainStateBatch(db, p);
    case 'taif_factory_reset_workspace': return factoryResetWorkspace(db, p);
    case 'taif_list_backups': return listBackups(db, p);
    case 'taif_create_backup': return createBackup(db, p);
    case 'taif_restore_backup': return restoreBackup(db, p);
    case 'taif_delete_backup': return deleteBackup(db, p);
    case 'taif_list_audit_log': return listAudit(db, p);
    case 'taif_public_price_display_state': return publicPriceDisplayState(db, p);
    default: fail(`عملية غير معروفة: ${name}`, 404, 'UNKNOWN_RPC');
  }
}
async function publicPriceDisplayState(db, p) {
  const wid = workspaceId(p.p_workspace_id || p.target_workspace || p.workspaceId || p.workspace_id || DEFAULT_WORKSPACE_ID);
  const requestedKey = text(p.p_state_key || p.stateKey || p.state_key || DOMAIN_KEYS.currency) || DOMAIN_KEYS.currency;
  const safeStateKey = requestedKey === DOMAIN_KEYS.currency ? DOMAIN_KEYS.currency : DOMAIN_KEYS.currency;
  const keys = [DOMAIN_KEYS.currency, DOMAIN_KEYS.chartAccounts, DOMAIN_KEYS.cashBoxes];
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db.prepare(`select * from taif_domain_state where workspace_id = ? and state_key in (${placeholders})`)
    .bind(wid, ...keys).all();
  const states = (rows.results || []).map(stateToJson);
  const currencyState = states.find((state) => text(state?.stateKey || state?.state_key) === safeStateKey) || null;
  const payload = currencyState && currencyState.payload && typeof currencyState.payload === 'object' && !Array.isArray(currencyState.payload)
    ? currencyState.payload
    : null;
  const publicState = payload ? {
    ...payload,
    __taifDisplayRevision: Number(currencyState.revision) || 0,
    __taifDomainRevision: Number(currencyState.revision) || 0,
    __taifDisplayPayloadHash: text(currencyState.payloadHash || currencyState.payload_hash),
    __taifDisplayUpdatedAt: text(currencyState.updatedAt || currencyState.updated_at || currencyState.logicalUpdatedAt || currencyState.logical_updated_at),
    revision: Number(currencyState.revision) || 0,
    payloadHash: text(currencyState.payloadHash || currencyState.payload_hash),
    payload_hash: text(currencyState.payloadHash || currencyState.payload_hash),
    updatedAt: text(currencyState.updatedAt || currencyState.updated_at || currencyState.logicalUpdatedAt || currencyState.logical_updated_at),
    updated_at: text(currencyState.updatedAt || currencyState.updated_at || currencyState.logicalUpdatedAt || currencyState.logical_updated_at)
  } : null;
  return {
    ok: true,
    workspaceId: wid,
    workspace_id: wid,
    stateKey: safeStateKey,
    state_key: safeStateKey,
    state: publicState,
    payload: publicState,
    revision: publicState ? Number(publicState.revision) || 0 : 0,
    payloadHash: publicState ? text(publicState.payloadHash || publicState.payload_hash) : '',
    payload_hash: publicState ? text(publicState.payloadHash || publicState.payload_hash) : '',
    updatedAt: publicState ? text(publicState.updatedAt || publicState.updated_at) : '',
    updated_at: publicState ? text(publicState.updatedAt || publicState.updated_at) : '',
    states,
    count: states.length,
    at: nowIso()
  };
}
async function login(db, p) {
  const username = normUsername(p.p_username || p.username);
  const password = String(p.p_password ?? p.password ?? '');
  if (!username || !password) return { ok: false, reason: 'missing_credentials', message: 'اكتب اسم المستخدم وكلمة السر.' };
  const user = await db.prepare('select * from taif_app_users where username = ? limit 1').bind(username).first();
  if (!user || user.active === 0 || !(await verifyPassword(password, user.password_hash))) {
    return { ok: false, reason: 'invalid_credentials', message: 'اسم المستخدم أو كلمة السر غير صحيحة.' };
  }
  const token = crypto.randomUUID();
  const at = nowIso();
  const expires = addDays(new Date(), SESSION_DAYS);
  await db.prepare('insert into taif_sessions(session_token, user_id, created_at, last_seen_at, expires_at) values(?,?,?,?,?)').bind(token, user.id, at, at, expires).run();
  await db.prepare('update taif_app_users set last_login_at = ?, updated_at = ? where id = ?').bind(at, at, user.id).run();
  const fresh = await db.prepare('select * from taif_app_users where id = ?').bind(user.id).first();
  return { ok: true, sessionToken: token, session_token: token, token, expiresAt: expires, expires_at: expires, user: userToJson(fresh) };
}
async function currentSession(db, p) {
  const token = text(p.p_session_token || p.sessionToken || p.token);
  const user = await getUserBySession(db, token, { required: false });
  if (!user) return { ok: false, reason: 'invalid_session', message: 'انتهت الجلسة. سجل الدخول من جديد.' };
  return { ok: true, sessionToken: token, session_token: token, token, expiresAt: text(user.expires_at), expires_at: text(user.expires_at), user: userToJson(user) };
}
async function logout(db, p) {
  const token = text(p.p_session_token || p.sessionToken || p.token);
  if (token) await db.prepare('delete from taif_sessions where session_token = ?').bind(token).run();
  return { ok: true };
}
async function changeMyPassword(db, p) {
  const token = text(p.p_session_token);
  const user = await getUserBySession(db, token);
  const oldPassword = String(p.p_old_password ?? '');
  const newPassword = String(p.p_new_password ?? '');
  if (newPassword.length < 6) return { ok: false, reason: 'weak_password', message: 'كلمة السر الجديدة يجب أن تكون 6 أحرف على الأقل.' };
  if (!(await verifyPassword(oldPassword, user.password_hash))) return { ok: false, reason: 'invalid_current_password', message: 'كلمة السر الحالية غير صحيحة.' };
  const at = nowIso();
  await db.prepare('update taif_app_users set password_hash = ?, must_change_password = 0, updated_at = ? where id = ?').bind(await hashPassword(newPassword), at, user.id).run();
  const fresh = await db.prepare('select * from taif_app_users where id = ?').bind(user.id).first();
  await insertAudit(db, { actor: user, action: 'change_my_password', entityType: 'user', entityId: user.id });
  return { ok: true, user: userToJson(fresh) };
}
async function listUsers(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const rows = await db.prepare('select * from taif_app_users order by created_at asc').all();
  return { ok: true, users: (rows.results || []).map(userToJson), user: userToJson(admin) };
}
async function createUser(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const username = normUsername(p.p_username || p.username);
  const displayName = text(p.p_display_name || p.displayName || username);
  const role = text(p.p_role || 'viewer');
  const password = String(p.p_password ?? '');
  if (!username) fail('اسم المستخدم مطلوب.', 400);
  if (!ROLES.has(role)) fail('الدور غير صالح.', 400);
  if (password.length < 6) fail('كلمة السر يجب أن تكون 6 أحرف على الأقل.', 400);
  const id = crypto.randomUUID(); const at = nowIso();
  await db.prepare(`insert into taif_app_users(id, username, display_name, role, password_hash, active, must_change_password, created_at, updated_at)
    values(?,?,?,?,?,?,?,?,?)`).bind(id, username, displayName, role, await hashPassword(password), 1, boolInt(p.p_must_change_password !== false), at, at).run();
  const fresh = await db.prepare('select * from taif_app_users where id = ?').bind(id).first();
  await insertAudit(db, { actor: admin, action: 'create_user', entityType: 'user', entityId: id, details: { username, role } });
  return { ok: true, user: userToJson(fresh) };
}
async function updateUser(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const userId = text(p.p_user_id || p.userId || p.id);
  const row = await db.prepare('select * from taif_app_users where id = ?').bind(userId).first();
  if (!row) fail('المستخدم غير موجود.', 404);
  const displayName = text(p.p_display_name ?? row.display_name) || row.display_name;
  const role = text(p.p_role ?? row.role) || row.role;
  const active = p.p_active === undefined ? row.active : boolInt(p.p_active);
  const mustChange = p.p_must_change_password === undefined ? row.must_change_password : boolInt(p.p_must_change_password);
  if (!ROLES.has(role)) fail('الدور غير صالح.', 400);
  if (row.id === admin.id && active !== 1) fail('لا يمكن إيقاف حساب المدير الحالي.', 400);
  const activeAdminCount = await db.prepare('select count(*) as count from taif_app_users where role = ? and active = 1 and id <> ?').bind('admin', row.id).first();
  if (row.role === 'admin' && role !== 'admin' && (Number(activeAdminCount?.count) || 0) < 1) fail('يجب أن يبقى مدير واحد نشط على الأقل.', 400);
  if (row.role === 'admin' && active !== 1 && (Number(activeAdminCount?.count) || 0) < 1) fail('يجب أن يبقى مدير واحد نشط على الأقل.', 400);
  const at = nowIso();
  await db.prepare('update taif_app_users set display_name = ?, role = ?, active = ?, must_change_password = ?, updated_at = ? where id = ?').bind(displayName, role, active, mustChange, at, row.id).run();
  const fresh = await db.prepare('select * from taif_app_users where id = ?').bind(row.id).first();
  await insertAudit(db, { actor: admin, action: 'update_user', entityType: 'user', entityId: row.id, details: { role, active } });
  return { ok: true, user: userToJson(fresh) };
}
async function resetUserPassword(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const userId = text(p.p_user_id || p.userId || p.id);
  const password = String(p.p_new_password ?? p.newPassword ?? '');
  if (password.length < 6) fail('كلمة السر الجديدة يجب أن تكون 6 أحرف على الأقل.', 400);
  const at = nowIso();
  const result = await db.prepare('update taif_app_users set password_hash = ?, must_change_password = ?, updated_at = ? where id = ?').bind(await hashPassword(password), boolInt(p.p_must_change_password !== false), at, userId).run();
  if (!result.success) fail('تعذر تحديث كلمة السر.', 500);
  const fresh = await db.prepare('select * from taif_app_users where id = ?').bind(userId).first();
  if (!fresh) fail('المستخدم غير موجود.', 404);
  await insertAudit(db, { actor: admin, action: 'reset_user_password', entityType: 'user', entityId: userId });
  return { ok: true, user: userToJson(fresh) };
}
async function listDomainState(db, p) {
  const user = await getUserBySession(db, p.p_session_token);
  const wid = workspaceId(p.p_workspace_id);
  const rows = await db.prepare('select * from taif_domain_state where workspace_id = ? order by state_key asc').bind(wid).all();
  return { ok: true, workspaceId: wid, workspace_id: wid, states: (rows.results || []).map(stateToJson), count: (rows.results || []).length, user: userToJson(user) };
}
async function listDomainStateMeta(db, p) {
  const user = await getUserBySession(db, p.p_session_token);
  const wid = workspaceId(p.p_workspace_id);
  const rows = await db.prepare(`select workspace_id, state_key, state_kind, payload_hash, revision, logical_updated_at, source_client_id, updated_at
    from taif_domain_state where workspace_id = ? order by state_key asc`).bind(wid).all();
  const states = (rows.results || []).map(stateMetaToJson);
  return { ok: true, workspaceId: wid, workspace_id: wid, states, count: states.length, user: userToJson(user) };
}
async function getDomainState(db, p) {
  const user = await getUserBySession(db, p.p_session_token);
  const wid = workspaceId(p.p_workspace_id);
  const key = text(p.p_state_key || p.stateKey || p.state_key);
  const row = await db.prepare('select * from taif_domain_state where workspace_id = ? and state_key = ?').bind(wid, key).first();
  return { ok: true, state: row ? stateToJson(row) : null, user: userToJson(user) };
}
async function upsertOneState(db, user, input, sourceClientId) {
  const wid = workspaceId(input.p_workspace_id || input.workspaceId || input.workspace_id);
  const key = text(input.p_state_key || input.stateKey || input.state_key);
  const kind = text(input.p_state_kind || input.stateKind || input.state_kind || 'domain') || 'domain';
  if (!key) fail('مفتاح الحالة مطلوب.', 400);
  const incomingPayload = input.p_payload ?? input.payload ?? {};
  const at = nowIso();
  const existing = await db.prepare('select * from taif_domain_state where workspace_id = ? and state_key = ?').bind(wid, key).first();
  const existingPayload = existing ? parseJson(existing.payload_json, {}) : null;
  const finalPayload = normalizeDomainStatePayloadForStorage(key, incomingPayload, existingPayload);
  const payloadJson = stringify(finalPayload);
  const payloadHash = taifPayloadHash(finalPayload);
  if (existing && existingPayload && canonicalPayloadHash(existingPayload) === canonicalPayloadHash(finalPayload)) {
    return stateToJson(existing);
  }
  if (existing) {
    await db.prepare(`update taif_domain_state set state_kind = ?, payload_json = ?, payload_hash = ?, revision = revision + 1,
      logical_updated_at = ?, updated_by = ?, updated_by_username = ?, updated_by_name = ?, source_client_id = ?, updated_at = ?
      where workspace_id = ? and state_key = ?`).bind(kind, payloadJson, payloadHash, at, user.id, user.username, user.display_name, sourceClientId, at, wid, key).run();
  } else {
    await db.prepare(`insert into taif_domain_state(workspace_id, state_key, state_kind, payload_json, payload_hash, revision, logical_updated_at, updated_by, updated_by_username, updated_by_name, source_client_id, created_at, updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(wid, key, kind, payloadJson, payloadHash, 1, at, user.id, user.username, user.display_name, sourceClientId, at, at).run();
  }
  const fresh = await db.prepare('select * from taif_domain_state where workspace_id = ? and state_key = ?').bind(wid, key).first();
  if (DOMAIN_SYNC_AUDIT_ENABLED) {
    await insertAudit(db, { workspaceId: wid, actor: user, action: existing ? 'upsert' : 'insert', entityType: 'domain_state', entityId: key, details: { stateKind: kind } });
  }
  return stateToJson(fresh);
}
async function upsertDomainState(db, p) {
  const user = await getUserBySession(db, p.p_session_token);
  const state = await upsertOneState(db, user, p, text(p.p_source_client_id || p.sourceClientId || p.source_client_id));
  return { ok: true, state, user: userToJson(user) };
}
async function upsertDomainStateBatch(db, p) {
  const user = await getUserBySession(db, p.p_session_token);
  const wid = workspaceId(p.p_workspace_id);
  const sourceClientId = text(p.p_source_client_id || p.sourceClientId || p.source_client_id);
  const items = Array.isArray(p.p_items) ? p.p_items : [];
  const states = [];
  for (const item of items) states.push(await upsertOneState(db, user, { ...item, p_workspace_id: wid }, sourceClientId));
  return { ok: true, states, count: states.length, workspaceId: wid, workspace_id: wid, user: userToJson(user) };
}
async function factoryResetWorkspace(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const wid = workspaceId(p.p_workspace_id);
  await db.prepare('delete from taif_domain_state where workspace_id = ?').bind(wid).run();
  await insertAudit(db, { workspaceId: wid, actor: admin, action: 'factory_reset', entityType: 'workspace', entityId: wid });
  return { ok: true, workspaceId: wid, workspace_id: wid, user: userToJson(admin) };
}
async function listBackups(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const wid = workspaceId(p.p_workspace_id); const limit = Math.max(1, Math.min(Number(p.p_limit) || 50, 200));
  const rows = await db.prepare('select * from taif_backups where workspace_id = ? order by created_at desc limit ?').bind(wid, limit).all();
  return { ok: true, backups: (rows.results || []).map((r) => backupToJson(r)), user: userToJson(admin) };
}
async function createBackup(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const wid = workspaceId(p.p_workspace_id); const name = text(p.p_backup_name || p.backupName || `نسخة احتياطية ${nowIso()}`);
  const rows = await db.prepare('select * from taif_domain_state where workspace_id = ? order by state_key asc').bind(wid).all();
  const states = (rows.results || []).map(stateToJson);
  const id = crypto.randomUUID(); const at = nowIso();
  await db.prepare(`insert into taif_backups(id, workspace_id, backup_name, snapshot_json, state_count, created_by, created_by_username, created_by_name, created_at)
    values(?,?,?,?,?,?,?,?,?)`).bind(id, wid, name, stringify({ states }), states.length, admin.id, admin.username, admin.display_name, at).run();
  await insertAudit(db, { workspaceId: wid, actor: admin, action: 'create_backup', entityType: 'backup', entityId: id, details: { name, stateCount: states.length } });
  const fresh = await db.prepare('select * from taif_backups where id = ?').bind(id).first();
  return { ok: true, backup: backupToJson(fresh, true), user: userToJson(admin) };
}
async function restoreBackup(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const id = text(p.p_backup_id || p.backupId || p.id);
  const backup = await db.prepare('select * from taif_backups where id = ?').bind(id).first();
  if (!backup) fail('النسخة الاحتياطية غير موجودة.', 404);
  const wid = workspaceId(backup.workspace_id);
  const snapshot = parseJson(backup.snapshot_json, {});
  const states = Array.isArray(snapshot?.states) ? snapshot.states : [];
  await db.prepare('delete from taif_domain_state where workspace_id = ?').bind(wid).run();
  for (const state of states) {
    await db.prepare(`insert into taif_domain_state(workspace_id, state_key, state_kind, payload_json, payload_hash, revision, logical_updated_at, updated_by, updated_by_username, updated_by_name, source_client_id, created_at, updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(wid, text(state.stateKey || state.state_key), text(state.stateKind || state.state_kind || 'domain'), stringify(state.payload || {}), text(state.payloadHash || state.payload_hash), Number(state.revision) || 1, nowIso(), admin.id, admin.username, admin.display_name, 'backup-restore', nowIso(), nowIso()).run();
  }
  await insertAudit(db, { workspaceId: wid, actor: admin, action: 'restore_backup', entityType: 'backup', entityId: id, details: { stateCount: states.length } });
  return { ok: true, restored: states.length, workspaceId: wid, workspace_id: wid, user: userToJson(admin) };
}
async function deleteBackup(db, p) {
  const admin = await getUserBySession(db, p.p_session_token); requireAdmin(admin);
  const id = text(p.p_backup_id || p.backupId || p.id);
  await db.prepare('delete from taif_backups where id = ?').bind(id).run();
  await insertAudit(db, { actor: admin, action: 'delete_backup', entityType: 'backup', entityId: id });
  return { ok: true, user: userToJson(admin) };
}
async function listAudit(db, p) {
  const user = await getUserBySession(db, p.p_session_token); requireAuditReader(user);
  const wid = workspaceId(p.p_workspace_id); const limit = Math.max(1, Math.min(Number(p.p_limit) || 120, 500));
  const rows = await db.prepare('select * from taif_audit_log where workspace_id = ? order by created_at desc limit ?').bind(wid, limit).all();
  return { ok: true, logs: (rows.results || []).map(auditToJson), user: userToJson(user) };
}
