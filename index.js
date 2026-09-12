// EcomModa — Stylebox Price Sync (v1.1.0)
// skills: worker-builder v3.0.0 · constants v1.1.0 — 12-09-2026

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'stylebox_price_sync';

// بيرجع من ?action=get_config — الواجهة بتقارنه بـ MIN_WORKER_VERSION عندها،
// فـ Promote ناقص أو rollback بيبان بدل ما يفضل صامت.
const WORKER_VERSION = '1.1.0';

// ⚠️ TEMPORARY — bulk_sync_all (أضيفت [تاريخ اليوم]) لمرة واحدة/دورية لعمل
// سحب شامل على كل الـ variants في شوبيفاي بدل ما ننتظر الويبهوك واحد واحد.
// عايزين نسيبها موجودة (بعكس backfill_batch اللي اتشالت) لأن الأداة هتستخدمها
// أكتر من مرة في المستقبل — لكن هي محمية بنفس WORKER_SECRET بتاع كل حاجة تانية.
const BULK_SYNC_PAGE_SIZE = 40; // عدد الـ variants اللي بيتقروا من شوبيفاي في كل نداء (مش بالضرورة كلهم مربوطين بـ WooCommerce)

// ══════════════════════════════════════════════════════
// §CORS — Option B (write tool, strict allowlist)
// ملاحظة: الـ CORS بيحمي فقط الـ endpoints الإدارية (get_logs، إلخ) لو
// اتفتحت من متصفح — مسار الويبهوك (/webhook) بييجي من سيرفر Shopify
// مش من متصفح، فمش بيعتمد على CORS أساساً.
// ══════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];
function getCORS(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// ── §HELPERS::safeEqual ──
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── §HELPERS::verifyShopifyHmac ──
// ⚠️ الويبهوك ده متسجّل عن طريق Webhook Control Center (webhookSubscriptionCreate
// عبر الـ GraphQL API) — يعني السر اللي بيوقّع بيه هو CLIENT_SECRET بتاع الـ app،
// مش SHOPIFY_WEBHOOK_SECRET (ده بس للويبهوكس المسجّلة من Admin UI القديمة).
// راجع shopify-webhook-helper skill — Step 9.
async function verifyShopifyHmac(secret, rawBody, headerHmac) {
  if (!secret || !headerHmac) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const digest = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return safeEqual(digest, headerHmac);
}

// ── §HELPERS::money ──
// تقريب لأقرب قرشين وتنسيق ثابت "0.00" — بيقفل أي مشاكل floating point
// قبل ما القيمة تتبعت لـ WooCommerce.
function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ── §HELPERS::findMetafield ──
// بيدوّر جوه array الـ metafields اللي بييجي في الويبهوك payload (namespace/key/value)
// — القيمة ممكن تيجي String أو Number حسب الـ REST-payload type coercion
// (راجع shopify-webhook-helper §6e) — دايماً بنرجّعها String هنا عشان نقارن بأمان.
function findMetafield(metafieldsArr, namespace, key) {
  if (!Array.isArray(metafieldsArr)) return null;
  const mf = metafieldsArr.find(m => m.namespace === namespace && m.key === key);
  if (!mf || mf.value === null || mf.value === undefined || mf.value === '') return null;
  return String(mf.value);
}

// ── §HELPERS::getPriceDiff ── (مصدر واحد — يُستخدم من الويبهوك ومن bulk_sync_all)
function getPriceDiff(env) {
  const p = parseFloat(env.PRICE_DIFFERENCE);
  return Number.isFinite(p) ? p : 0;
}

// ══════════════════════════════════════════════════════
// §SHOPIFY — مطلوبة فقط لـ bulk_sync_all (الويبهوك نفسه بيستقبل من شوبيفاي،
// مش بيكلمها). راجع shopify-graphql-helper Step 1 + Step 4.
// ⚠️ يحتاج env.CLIENT_ID + env.SHOP_DOMAIN مضافين في Dashboard Variables —
// env.CLIENT_SECRET موجود بالفعل (مستخدم في التحقق من HMAC فوق).
// ══════════════════════════════════════════════════════
async function getAccessToken(env) {
  const resp = await fetch(
    `https://${env.SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    }
  );
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in response');
  return data.access_token;
}

// 🔴 النسخة المعتمدة (worker-builder Step 5A ①) — بترمي على: فشل شبكة ·
//    HTTP status · رد مش JSON · data.errors · data فاضية، + إعادة محاولة على
//    THROTTLED. النسخة القديمة كانت `return resp.json()` وبس، يعني 401/429/5xx
//    من شوبيفاي كانت بتعدّي كأنها رد سليم وأي throttle بيقتل صفحة كاملة من
//    المزامنة الشاملة برسالة مبهمة.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ══════════════════════════════════════════════════════
// SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// Copy this block VERBATIM into every Worker — no modifications
// ══════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();
  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username).run().catch(() => {});
  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin) throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');
  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee ?? null,
    entry.orderId ?? null,
    entry.orderName ?? null,
    entry.sku ?? null,
    entry.productTitle ?? null,
    entry.delta ?? null,
    entry.valueBefore ?? null,
    entry.valueAfter ?? null,
    entry.notes ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه، فمفيش SQL
 * مكرر يتعتّق في واحدة منهم ويسيب التانية.
 *
 * employees[] / types[] → قوايم (multi-select إلزامي في أي شاشة فيها جدول،
 * والسجل جدول). employee / type المفردين لسه مقبولين للتوافق الرجعي.
 *
 * ⚠️ **انحراف مقصود عن نسخة المهارة:** النسخة القياسية بتبحث في `order_name`
 * — والأداة دي مالهاش أوردرات خالص (بتزامن أسعار variants)، فعمود الهوية هنا
 * هو `sku`. و`searchNotes` منفصل عن `search` عشان الواجهة فيها مربعين بحث
 * (SKU · الملحوظات) — مربع واحد للاتنين كان بيخلي البحث بالـ SKU يرجّع صفوف
 * الملحوظات بس فيها النص.
 *
 * ⚠️ dateFrom / dateTo بيتقارنوا بـ substr(timestamp,1,10) — يعني **UTC**،
 * والعرض بتوقيت القاهرة (UTC+3/+2). فرق الساعات ممكن يحط عملية بعد ٩ مساءً
 * بتوقيت القاهرة في يوم UTC اللي بعده. مقبول لفلتر بالأيام — **بس مكتوب**،
 * عشان مايتكتشفش كباج بعدين.
 *
 * login/logout مستثنيين في SQL دايمًا — مش client-side.
 */
function buildLogFilterSQL(select, {
  tool        = null,
  employee    = null, employees   = null,
  type        = null, types       = null,
  search      = null, searchNotes = null,
  dateFrom    = null, dateTo      = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) { sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps); }
  if (typs.length) { sql += ` AND type IN (${typs.map(() => '?').join(',')})`;     b.push(...typs); }
  if (search)      { sql += ' AND sku LIKE ?';                 b.push(`%${search}%`); }
  if (searchNotes) { sql += ' AND notes LIKE ?';               b.push(`%${searchNotes}%`); }
  if (dateFrom)    { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)      { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا** — مفتاح مش في
//    القايمة بيرجع للافتراضي في صمت، فالعمود يبان إنه اترتّب وهو مااترتّبش.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee',
  type: 'type', sku: 'sku', result: `json_extract(extra, '$.result')`,
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

/**
 * صفحة واحدة للعرض — server-side filtering + pagination. السقف 100/صفحة
 * مفروض هنا، فأي `limit` أكبر بيترجع 100 **من غير ما الواجهة تعرف** — عشان
 * كده الواجهة لازم تستخدم pagination مش limit كبير.
 */
async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

/** العدّ الكلي المطابق للفلتر — بيتنادى بالتوازي مع getLogs ومع getLogsExport. */
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * كل السجل المطابق للتصدير — لحد LOG_EXPORT_MAX.
 * ⚠️ الدالة دي **بتقص في السكوت** بطبيعتها. المسؤولية اللي جنبها إلزامية:
 * الـ endpoint لازم يرجّع `cap` و`total` و`truncated` كمان.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // ⚠️ التصدير والعدّ بيتجاهلوا الترتيب عن قصد — العدّ مالوش ترتيب، والتصدير
  //    بياخد ترتيب السيرفر الافتراضي.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * بيقرا فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=synced,sku_mismatch).
 * مصدر **واحد** بتستخدمه التلات endpoints، فمفيش endpoint بيفلتر بشكل مختلف
 * عن اللي جنبه (وده بالظبط اللي بيخلي التصدير ينزّل غير المعروض).
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees:   employees.length ? employees : null,
    employee:    url.searchParams.get('employee')    || null,
    types:       types.length ? types : null,
    type:        url.searchParams.get('type')        || null,
    search:      url.searchParams.get('search')      || null,
    searchNotes: url.searchParams.get('searchNotes') || null,
    dateFrom:    url.searchParams.get('dateFrom')    || null,
    dateTo:      url.searchParams.get('dateTo')      || null,
  };
}
// ══════════════════════════════════════════════════════
// END SHARED BLOCK
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// §WOOCOMMERCE
// ⚠️ الـ endpoint ده (variation-price) لسه مش موجود على WordPress —
// لازم يتضاف على نفس الـ plugin/mu-plugin اللي فيه variation-stock حالياً
// قبل ما الأداة دي تشتغل. الشكل المتوقع تحت (GET بيرجع regular_price +
// sale_price + sku + gtin، POST بياخد نفس الحقول ويحدّثهم).
// ══════════════════════════════════════════════════════
async function wcGetVariationPrice(env, variationId) {
  const res = await fetch(
    `${env.WP_BASE_URL.replace(/\/$/, '')}/wp-json/ecommoda/v1/variation-price/${variationId}`,
    { headers: { 'X-Sync-Header-Secret': env.SYNC_SECRET } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WP GET failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function wcUpdateVariationPrice(env, variationId, regularPrice, salePrice) {
  const res = await fetch(
    `${env.WP_BASE_URL.replace(/\/$/, '')}/wp-json/ecommoda/v1/variation-price/${variationId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Header-Secret': env.SYNC_SECRET },
      body: JSON.stringify({ regular_price: regularPrice, sale_price: salePrice }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WP POST failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ══════════════════════════════════════════════════════
// §PRICE-SYNC-STATE
// جدول حالة صغير لكل variant — بغرضين:
// 1) Ordering guard: منع حدث قديم (retry/late delivery) من الكتابة فوق
//    قيمة أحدث، لأن Shopify مش بتضمن ترتيب تسليم الويبهوكات.
// 2) Cache: تجنّب نداء WordPress من غير داعي لما الـ PRODUCTS_UPDATE
//    بييجي بسبب تعديل مالوش علاقة بالسعر (عنوان، وصف، إلخ) — الفلتر
//    الحالي على مستوى المنتج (metafields.key:wordpress_id) فبيسمح
//    بأي تعديل على المنتج، مش بس تعديل السعر.
//
// شغّل مرة واحدة في D1 Console قبل أول استخدام (سطر واحد، من غير أي
// تعليقات جوه الاستعلام نفسه):
//
// CREATE TABLE IF NOT EXISTS stylebox_price_sync_state (variant_id TEXT PRIMARY KEY, last_triggered_at TEXT, last_synced_regular_price TEXT, last_synced_sale_price TEXT, updated_at TEXT);
// ══════════════════════════════════════════════════════

// ── §PRICE-SYNC-STATE::claimIfNewer ──
// عملية atomic واحدة (INSERT .. ON CONFLICT .. WHERE) — لو مفيش سطر
// لنفس الـ variant_id بيتعمله INSERT عادي. لو موجود، التحديث بيحصل بس
// لو triggered_at الجديد أحدث من المخزّن — لو الشرط فشل، res.meta.changes
// بترجع 0 يعني الحدث ده قديم ولازم يتجاهل.
async function claimIfNewer(db, variantId, triggeredAt) {
  const now = new Date().toISOString();
  const res = await db.prepare(`
    INSERT INTO stylebox_price_sync_state (variant_id, last_triggered_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(variant_id) DO UPDATE SET
      last_triggered_at = excluded.last_triggered_at,
      updated_at         = excluded.updated_at
    WHERE excluded.last_triggered_at > stylebox_price_sync_state.last_triggered_at
  `).bind(variantId, triggeredAt, now).run();
  return (res.meta?.changes ?? 0) > 0;
}

async function getLastSyncedPrice(db, variantId) {
  return db.prepare(
    'SELECT last_synced_regular_price, last_synced_sale_price FROM stylebox_price_sync_state WHERE variant_id = ?'
  ).bind(variantId).first();
}

// 🔴 upsert مش UPDATE: الصف بيتعمله INSERT جوّه claimIfNewer **بس** — واللي
// بتتخطّى بالكامل في مسار no_triggered_at_header (الهيدر مش موجود). ساعتها
// الـ UPDATE كان بيأثّر على **صفر صفوف في صمت**، فالكاش عمره ما يتكتب و
// no_price_change_skipped عمرها ما تتحقق: WooCommerce بياخد نداء كتابة في كل
// حدث. (جردة 12-09-2026 — W-06)
async function updateLastSyncedPrice(db, variantId, regularPrice, salePrice) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO stylebox_price_sync_state
      (variant_id, last_synced_regular_price, last_synced_sale_price, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(variant_id) DO UPDATE SET
      last_synced_regular_price = excluded.last_synced_regular_price,
      last_synced_sale_price    = excluded.last_synced_sale_price,
      updated_at                = excluded.updated_at
  `).bind(variantId, regularPrice, salePrice ?? '', now).run();
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // 1. CORS Preflight — ALWAYS first
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCORS(request) });
    }

    // ─── §WEBHOOK ─── (Shopify calls this — لا يوجد Authorization: Bearer
    // هنا، Shopify بتوقّع بالـ HMAC بتاعها. الفرع ده لازم يشتغل قبل
    // WORKER_SECRET gate تحت.)
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleShopifyWebhook(request, env, ctx);
    }

    // 2. WORKER_SECRET check — ALWAYS second (كل حاجة تانية في الـ Worker ده،
    // بما فيها bulk_sync_all تحت — نفس مستوى الحماية زي باقي الإدارة)
    // 🔴 حارس السر الغايب — **قبل** فحص الـ auth بالظبط. القالب تحت بينتج
    //    السلسلة الحرفية "Bearer undefined" لو السر مش مضبوط (سر اتضاف من غير
    //    Promote · اتمسح بالغلط · Worker شبح)، يعني أي طلب بالهيدر ده **بيعدّي**
    //    على أداة بتكتب أسعار وبتقرا السجل كله. الحالة اللي المفروض تبقى
    //    "كل حاجة 401" كانت بتتحوّل لـ "الحماية اتشالت". (worker-builder Step 8)
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim()) {
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker — ضِفه من Settings → Variables وبعدها Promote', step: 'env' }, 500, request);
    }

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401, request);
    }

    try {
      // ─── §AUTH ────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);
        await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` });
        return json({ ok: true, displayName }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, { tool: TOOL_NAME, type: 'logout', employee: username, notes: `خروج: ${username.replace(/_/g, ' ')}` });
        }
        return json({ ok: true }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      // ─── §BULK-SYNC ─────────────────────────────────────────
      // صفحة واحدة لكل نداء — الـ HTML بينده تاني بالـ cursor الراجع
      // لحد ما hasMore: false. مبني فوق processVariant() نفسها اللي
      // بيستخدمها الويبهوك — مفيش منطق سعر مكرر.
      if (action === 'bulk_sync_all') {
        const cursor = url.searchParams.get('cursor') || null;
        const result = await runBulkSyncPage(env, cursor);
        return json({ ok: true, ...result }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      // ─── §CONFIG-ENDPOINT ─────────────────────────────────
      // الواجهة بتقارن النسخة دي بـ MIN_WORKER_VERSION عندها — بيكشف Promote
      // ناقص أو rollback، اللي بيخلّي الأداة "شغّالة" وهي بترجّع عقد قديم.
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────
      // التلاتة بيقروا الفلاتر من **مصدر واحد** (logParamsFrom)، فمفيش
      // endpoint بيفلتر بشكل مختلف عن اللي جنبه.
      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        // 🔴 parseInt('abc') → NaN · Math.min(NaN,100) → NaN → بيوصل لـ D1 كـ
        //    bind ويرجّع خطأ غامض. الحراسة إلزامية، مش تجميل.
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

        const entries = await getLogs(env.DB, {
          ...p, limit, offset,
          sortBy:  url.searchParams.get('sortBy'),
          sortDir: url.searchParams.get('sortDir'),
        });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // 🔴 عقد إلزامي: الصفوف **والحقيقة** مع بعض. getLogsExport بتقصّ عند
      //    LOG_EXPORT_MAX في السكوت، فمن غير cap/total/truncated الواجهة بتقول
      //    "تم تصدير N عملية ✓" على **ملف ناقص**. (html-builder Standards #30)
      //    والعدّ بيتنادى **بنفس فلاتر التصدير بالظبط** — فلاتر مختلفة بتطلّع
      //    نسبة كذّابة، وهي أسوأ من مفيش رقم.
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),
        ]);
        return json({
          ok: true, entries,
          cap: LOG_EXPORT_MAX, total, truncated: total > LOG_EXPORT_MAX,
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      return json({ ok: false, error: 'action غير معروف' }, 400, request);

    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 500, request);
    }
  },
};

// ══════════════════════════════════════════════════════
// §WEBHOOK — handleShopifyWebhook بس بيتحقق من التوقيع ويرد فوراً.
// كل الشغل الفعلي (loop على الـ variants + WooCommerce calls) بيحصل
// في processProductWebhook جوه ctx.waitUntil عشان منتخطاش الـ 5 ثواني.
// ══════════════════════════════════════════════════════
async function handleShopifyWebhook(request, env, ctx) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');
  const webhookId = request.headers.get('X-Shopify-Webhook-Id');
  const eventId = request.headers.get('X-Shopify-Event-Id') || webhookId;
  const triggeredAt = request.headers.get('X-Shopify-Triggered-At');

  // ── §WEBHOOK::verify ── (CLIENT_SECRET — الويبهوك ده متسجّل عن طريق
  // Webhook Control Center، يعني API-created subscription — راجع §HELPERS
  // فوق وشرح shopify-webhook-helper Step 9)
  const secret = env.CLIENT_SECRET;
  const valid = await verifyShopifyHmac(secret, rawBody, hmacHeader);
  if (!valid) {
    ctx.waitUntil(writeLog(env.DB, {
      tool: TOOL_NAME,
      type: 'hmac_failed',
      notes: 'فشل التحقق من HMAC — سر التوقيع غلط (تأكد إنه CLIENT_SECRET مش SHOPIFY_WEBHOOK_SECRET) أو الـ body اتغيّر',
      extra: {
        webhookId, eventId, triggeredAt,
        hmacHeaderPresent: !!hmacHeader,
        bodyBytes: rawBody.length,
        secretPresent: !!env.CLIENT_SECRET,
        envKeys: Object.keys(env),
      },
    }).catch(() => {}));
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = {};
  }

  // ── §WEBHOOK::respondThenProcess ──
  ctx.waitUntil(
    processProductWebhook(env, payload, { webhookId, eventId, triggeredAt }).catch((e) =>
      writeLog(env.DB, {
        tool: TOOL_NAME,
        type: 'unexpected_error',
        notes: e.message || String(e),
        extra: { webhookId, eventId, triggeredAt },
      }).catch(() => {})
    )
  );

  return new Response('OK (accepted)', { status: 200 });
}

// ── §WEBHOOK::processProductWebhook ──
// بيلف على كل variant جوه المنتج، ويعمل sync للسعر لو عنده
// custom.wordpress_variation_id metafield. كل نتيجة (نجاح أو تخطي)
// بتتسجل في D1 لأن ده الطريقة الوحيدة لمراقبة Worker بلا واجهة.
async function processProductWebhook(env, payload, meta) {
  const { webhookId, eventId, triggeredAt } = meta;
  const diff = getPriceDiff(env);

  // ── §WEBHOOK::emptyPayloadGuard ──
  if (!payload || !Array.isArray(payload.variants) || payload.variants.length === 0) {
    await writeLog(env.DB, {
      tool: TOOL_NAME,
      type: 'empty_payload_bug',
      notes: 'Payload وصل من غير variants — تعذّر معرفة أي variant اتغير',
      extra: { webhookId, eventId, triggeredAt },
    });
    return;
  }

  for (const variant of payload.variants) {
    await processVariant(env, variant, { webhookId, eventId, triggeredAt, diff });
  }
}

// ── §WEBHOOK::processVariant ──
// ⚠️ الدالة دي مصدر الحقيقة الوحيد لحساب السعر والـ triple-check — بتُستخدم
// من الويبهوك (شكل REST payload) ومن bulk_sync_all (شكل GraphQL مُعاد تشكيله
// لنفس البنية جوه runBulkSyncPage تحت). أي تعديل هنا بينطبق على الاتنين.
async function processVariant(env, variant, ctx) {
  const { webhookId, eventId, triggeredAt, diff } = ctx;

  const variantGid = variant.admin_graphql_api_id || '';
  const variantId = variantGid.split('/').pop();
  const sku = variant.sku || null;

  if (!variantId) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'invalid_variant', sku,
      notes: 'variant من غير admin_graphql_api_id — تعذّر تحديد الـ variant ID',
      extra: { webhookId, eventId, variant },
    });
    return;
  }

  // ── §WEBHOOK::linkGuard ──
  const wordpressVariationId = findMetafield(variant.metafields, 'custom', 'wordpress_variation_id');
  if (!wordpressVariationId) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'not_linked_yet', sku,
      notes: 'الـ variant ده لسه من غير custom.wordpress_variation_id metafield',
      extra: { variantId, webhookId, eventId },
    });
    return;
  }

  // ── §WEBHOOK::orderingGuard ──
  // نفس الـ triggered_at بينطبق على كل الـ variants جوه نفس الحدث —
  // ده مقصود: الهدف منع حدث (delivery) قديم يكتب فوق حدث أحدث لنفس الـ
  // variant، مش تتبع توقيت كل variant لوحده.
  if (triggeredAt) {
    const claimed = await claimIfNewer(env.DB, variantId, triggeredAt);
    if (!claimed) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'stale_event_skipped', sku,
        notes: 'الحدث ده أقدم من (أو مساوي لـ) آخر حدث اتعالج لنفس الـ variant — تم التجاهل',
        extra: { variantId, webhookId, eventId, triggeredAt },
      });
      return;
    }
  } else {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'no_triggered_at_header', sku,
      notes: 'X-Shopify-Triggered-At مش موجود — تم التنفيذ من غير ordering guard',
      extra: { variantId, webhookId, eventId },
    });
  }

  // ── §WEBHOOK::computePrices ──
  const shopifyPrice = parseFloat(variant.price);
  if (!Number.isFinite(shopifyPrice)) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'invalid_price', sku,
      notes: `price غير صالح من Shopify: "${variant.price}"`,
      extra: { variantId, webhookId, eventId },
    });
    return;
  }

  const compareRaw = variant.compare_at_price;
  const hasCompare = compareRaw !== null && compareRaw !== undefined && compareRaw !== '';
  const shopifyCompare = hasCompare ? parseFloat(compareRaw) : null;

  let regularPrice, salePrice;
  if (hasCompare && Number.isFinite(shopifyCompare) && shopifyCompare > shopifyPrice) {
    // فيه خصم فعلي على شوبيفاي: compare_at (السعر الأصلي) + price (سعر البيع)
    regularPrice = money(shopifyCompare + diff);
    salePrice = money(shopifyPrice + diff);
  } else {
    // مفيش خصم فعلي — السعر العادي بس، وأي sale_price قديم على WooCommerce بيتشال
    regularPrice = money(shopifyPrice + diff);
    salePrice = '';
  }

  // ── §WEBHOOK::noChangeGuard ── (تجنّب نداء WordPress من غير داعي)
  const lastSynced = await getLastSyncedPrice(env.DB, variantId);
  if (
    lastSynced &&
    lastSynced.last_synced_regular_price === regularPrice &&
    (lastSynced.last_synced_sale_price || '') === (salePrice || '')
  ) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'no_price_change_skipped', sku,
      notes: 'السعر المحسوب مطابق لآخر قيمة اتزامنت — لا داعي لنداء WordPress',
      extra: { variantId, webhookId, eventId, regularPrice, salePrice },
    });
    return;
  }

  try {
    // ── §WEBHOOK::fetchWpVariation ──
    const wp = await wcGetVariationPrice(env, wordpressVariationId);
    if (!wp) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'wp_variation_not_found', sku,
        notes: `WordPress Variation Id (${wordpressVariationId}) مش موجود على WordPress`,
        extra: { variantId, wordpressVariationId, webhookId, eventId },
      });
      return;
    }

    // ── §WEBHOOK::tripleCheck ── (SKU + GTIN — نفس منطق stock-sync)
    const skuMatch = String(sku || '').trim() === String(wp.sku || '').trim();
    const gtinMatch = String(wp.gtin || '').trim() === String(variantId || '').trim();

    if (!skuMatch) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'sku_mismatch', sku,
        notes: `SKU مختلف — Shopify: "${sku}" | WordPress: "${wp.sku}"`,
        extra: { variantId, wordpressVariationId, webhookId, eventId },
      });
      return;
    }
    if (!gtinMatch) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'gtin_mismatch', sku,
        notes: `GTIN لا يطابق Variant ID — WordPress GTIN: "${wp.gtin}" | متوقع: "${variantId}"`,
        extra: { variantId, wordpressVariationId, webhookId, eventId },
      });
      return;
    }

    // ── §WEBHOOK::syncPrice ──
    try {
      const result = await wcUpdateVariationPrice(env, wordpressVariationId, regularPrice, salePrice);
      await updateLastSyncedPrice(env.DB, variantId, regularPrice, salePrice);
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'synced', sku,
        valueBefore: `regular:${wp.regular_price} / sale:${wp.sale_price || '-'}`,
        valueAfter: `regular:${regularPrice} / sale:${salePrice || '-'}`,
        notes: 'تمّت مزامنة السعر بنجاح',
        extra: {
          variantId, wordpressVariationId, webhookId, eventId,
          shopifyPrice, shopifyCompare, priceDifference: diff, wcResult: result,
        },
      });
    } catch (wpErr) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'wp_update_failed', sku,
        valueBefore: `regular:${wp.regular_price} / sale:${wp.sale_price || '-'}`,
        valueAfter: `regular:${regularPrice} / sale:${salePrice || '-'}`,
        notes: `فشل تحديث WordPress: ${wpErr.message}`,
        extra: { variantId, wordpressVariationId, webhookId, eventId },
      });
    }

  } catch (e) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'unexpected_error', sku,
      notes: e.message || String(e),
      extra: { variantId, wordpressVariationId, webhookId, eventId },
    });
  }
}

// ══════════════════════════════════════════════════════
// §BULK-SYNC — runBulkSyncPage
// صفحة واحدة (BULK_SYNC_PAGE_SIZE variant) من كل الكتالوج — مش بس المربوطين.
// بيقرا metafield custom.wordpress_variation_id مباشرة مع الصفحة (نداء واحد،
// مفيش N+1)، وبيعيد تشكيل كل variant لنفس بنية الويبهوك عشان processVariant()
// تشتغل من غير أي تكرار في منطق السعر.
// ══════════════════════════════════════════════════════
async function runBulkSyncPage(env, cursor) {
  const token = await getAccessToken(env);

  const query = `
    query($cursor: String) {
      productVariants(first: ${BULK_SYNC_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            price
            compareAtPrice
            metafield(namespace: "custom", key: "wordpress_variation_id") { value }
          }
        }
      }
    }
  `;
  const data = await shopifyGQL(env, token, query, { cursor }, 'productVariants');
  const conn = data?.data?.productVariants;
  if (!conn) {
    throw new Error('productVariants query failed: ' + JSON.stringify(data?.errors || data));
  }

  const triggeredAt = new Date().toISOString(); // نفس اللحظة لكل الصفحة — كافي لـ ordering guard هنا
  const batchTag = `bulk_sync_${triggeredAt}`;
  const diff = getPriceDiff(env);

  let scanned = 0;
  let linked = 0;

  for (const edge of conn.edges) {
    scanned++;
    const node = edge.node;
    const wordpressVariationId = node.metafield?.value;

    // مش مربوط بـ WooCommerce — تخطي صامت (من غير D1 log) عشان منغرقش
    // الـ log بآلاف سطور "not_linked_yet" لكل الكتالوج اللي مالوش علاقة
    if (!wordpressVariationId) continue;
    linked++;

    const shaped = {
      admin_graphql_api_id: node.id,
      sku: node.sku,
      price: node.price,
      compare_at_price: node.compareAtPrice,
      metafields: [{ namespace: 'custom', key: 'wordpress_variation_id', value: wordpressVariationId }],
    };

    await processVariant(env, shaped, {
      webhookId: batchTag,
      eventId: batchTag,
      triggeredAt,
      diff,
    });
  }

  return {
    scanned,
    linked,
    hasMore: conn.pageInfo.hasNextPage,
    nextCursor: conn.pageInfo.endCursor,
  };
}
