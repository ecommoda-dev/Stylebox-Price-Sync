// EcomModa — Stylebox Price Sync (v1.2.0)
// skills: worker-builder v3.0.0 · constants v1.1.0 — 12-09-2026

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'stylebox_price_sync';

// بيرجع من ?action=get_config — الواجهة بتقارنه بـ MIN_WORKER_VERSION عندها،
// فـ Promote ناقص أو rollback بيبان بدل ما يفضل صامت.
const WORKER_VERSION = '1.2.0';

// ⚠️ TEMPORARY — bulk_sync_all (أضيفت [تاريخ اليوم]) لمرة واحدة/دورية لعمل
// سحب شامل على كل الـ variants في شوبيفاي بدل ما ننتظر الويبهوك واحد واحد.
// عايزين نسيبها موجودة (بعكس backfill_batch اللي اتشالت) لأن الأداة هتستخدمها
// أكتر من مرة في المستقبل — لكن هي محمية بنفس WORKER_SECRET بتاع كل حاجة تانية.
// ─── سلسلة السقوف التلاتة — التلاتة مع بعض، ولا واحد يتغيّر لوحده ───
// (worker-builder Step 5A ⑪ — ممنوع يتقال رقم منهم لوحده)
// ① الواجهة       مفيش CHUNK هنا: الواجهة بتنده **صفحة واحدة** في كل نداء
//                 والـ cursor بيمسك المكان، فالـ pagination نفسه هو التقسيم.
// ② الـ Worker    BULK_SYNC_PAGE_SIZE = 40 ← حارس **وقت**: ٤٠ variant، والمربوط
//                 منهم بياخد نداء WooCommerce أو اتنين، لازم يخلّصوا جوّه مهلة
//                 الواجهة (API_TIMEOUT_MS = 90 ث).
// ③ شوبيفاي       تكلفة الاستعلام: productVariants(first:40) + metafield واحد
//                 ≈ ٤٤ نقطة، والميزانية الآمنة ٧٠٠ (constants §1). يعني الحد
//                 الفعلي هنا **وقت WooCommerce**، مش تكلفة شوبيفاي.
//                 التكلفة الحقيقية بترجع في diag من throttleStatus.
const BULK_SYNC_PAGE_SIZE = 40;

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

// ── §HELPERS::safeWriteLog ──
// 🔴 فشل D1 مايتبلعش. `.catch(() => {})` معناها إن العملية حصلت (أو اترفضت)
//    ومفيش أي أثر خالص. مفيش مكان تاني نسجّل فيه فشل السجل نفسه، فبيروح على
//    console — observability مفعّلة في wrangler.toml — وبيرجّع false عشان
//    المنادي يقدر يرجّعه للواجهة كـ logged:false. (Step 5A ⑦)
async function safeWriteLog(db, entry) {
  try { await writeLog(db, entry); return true; }
  catch (e) {
    console.error('[writeLog FAILED]', entry.tool, entry.type, entry.sku || '', e.message);
    return false;
  }
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

// ── §HELPERS::assertEnv ──
// متغير ناقص لازم يوقف العملية **برسالة باسمه**. قبل كده WP_BASE_URL الناقص
// كان بيرمي TypeError مبهم (`.replace of undefined`) وبيتسجّل unexpected_error،
// وSYNC_SECRET الناقص كان بيبعت هيدر undefined وWordPress بيرد 401 فيتسجّل
// wp_update_failed — الاتنين تشخيصهم غلط. (Step 5A ⑧)
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
  woo:     ['WP_BASE_URL', 'SYNC_SECRET'],
};

function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
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
// ✅ الـ endpoint (variation-price) **موجود وشغّال على WordPress** — اتأكد من
// صفوف D1 حية (type='synced' · extra.wcResult.success:true). التعليق القديم
// هنا كان بيقول إنه "لسه مش موجود" وكان فات أوانه، واتسيّب وقت النقل لـ git
// عن قصد (نقل بايت ببايت) — اتصحّح في جردة 12-09-2026 لأنه بقى مصيدة لأي حد
// يفتح الملف.
// الشكل: GET بيرجع regular_price + sale_price + sku + gtin · POST بياخد
// regular_price + sale_price ويحدّثهم. الهيدر X-Sync-Header-Secret (مش
// X-EcomModa-Secret القياسي — سلوك قائم متعمّد، راجع CLAUDE.md).
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
// 🔴 الشرط null-safe إلزامي: في SQLite أي مقارنة مع NULL بترجّع NULL (falsy)،
// فصف `last_triggered_at = NULL` — بيحصل بعد releaseClaim، أو من صف اتعمله
// upsert في مسار no_triggered_at_header — كان هيخلّي الحجز **يفشل للأبد**
// والـ variant يترفض بـ stale_event_skipped على كل حدث جديد.
// عملية atomic واحدة (INSERT .. ON CONFLICT .. WHERE) — لو مفيش سطر
// لنفس الـ variant_id بيتعمله INSERT عادي. لو موجود، التحديث بيحصل بس
// لو triggered_at الجديد أحدث من المخزّن — لو الشرط فشل، res.meta.changes
// بترجع 0 يعني الحدث ده قديم ولازم يتجاهل.
async function claimIfNewer(db, variantId, triggeredAt) {
  const now = new Date().toISOString();
  // القيمة القديمة بتتقرا **قبل** الحجز عشان نقدر نرجّعها لو الشغل فشل
  // (releaseClaim تحت). القراءة دي مش جزء من الذرّية — الحارس الذرّي هو
  // الـ WHERE في الـ INSERT تحت؛ دي بس بتجيب قيمة التراجع.
  const prevRow = await db.prepare(
    'SELECT last_triggered_at FROM stylebox_price_sync_state WHERE variant_id = ?'
  ).bind(variantId).first();

  const res = await db.prepare(`
    INSERT INTO stylebox_price_sync_state (variant_id, last_triggered_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(variant_id) DO UPDATE SET
      last_triggered_at = excluded.last_triggered_at,
      updated_at         = excluded.updated_at
    WHERE stylebox_price_sync_state.last_triggered_at IS NULL
       OR excluded.last_triggered_at > stylebox_price_sync_state.last_triggered_at
  `).bind(variantId, triggeredAt, now).run();

  return {
    claimed:  (res.meta?.changes ?? 0) > 0,
    previous: prevRow?.last_triggered_at ?? null,
  };
}

// 🔴 الحجز بيترفع لما الشغل يفشل — من غير كده أي إعادة تسليم لنفس الحدث بترجع
//    stale_event_skipped (المقارنة `>` صارمة)، فإعادة المحاولة على نفس الحدث
//    **مستحيلة**. بيتنادى في مسارات الفشل الحقيقي بس (فشل الكتابة على
//    WooCommerce · خطأ غير متوقع) — مش في الرفض ولا في already.
async function releaseClaim(db, variantId, previous) {
  const now = new Date().toISOString();
  if (previous === null) {
    // مكانش فيه صف قبل الحدث ده — نشيل الطابع بس ونسيب الكاش (لو اتكتب)
    await db.prepare(
      'UPDATE stylebox_price_sync_state SET last_triggered_at = NULL, updated_at = ? WHERE variant_id = ?'
    ).bind(now, variantId).run();
    return;
  }
  await db.prepare(
    'UPDATE stylebox_price_sync_state SET last_triggered_at = ?, updated_at = ? WHERE variant_id = ?'
  ).bind(previous, now, variantId).run();
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

      // ─── §DIAG ────────────────────────────────────────────
      // فحص ذاتي **بدون أي كتابة**. ⚠️ ممنوع يرجّع قيمة أي سر — أسماء وأطوال
      // بس. (Step 5A ⑨ · الشكل المعتمد: مصفوفة [{ok,label,detail}])
      if (action === 'diag') {
        const checks = [];
        const add = (ok, label, detail) => checks.push({ ok, label, detail });

        // ① المتغيّرات — الطول بيكشف المسافة المخفية في القيمة، والاسم بيكشف
        //    binding متسمّي غلط (envKeys)
        const SECRET_KEYS = ['WORKER_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'SYNC_SECRET'];
        for (const k of SECRET_KEYS) {
          const v = env[k];
          const ok = typeof v === 'string' && v.trim().length > 0;
          add(ok, k, ok ? `مضبوط (${v.length} حرف)` : 'ناقص أو فاضي');
        }
        add(!!env.DB, 'DB (D1 binding)', env.DB ? 'موجود' : 'ناقص — الكتابة في السجل هتفشل بالكامل');
        add(!!env.SHOP_DOMAIN, 'SHOP_DOMAIN', env.SHOP_DOMAIN || 'ناقص');
        add(!!env.WP_BASE_URL, 'WP_BASE_URL', env.WP_BASE_URL || 'ناقص');

        // ② PRICE_DIFFERENCE — **قيمتها بتتعرض عن قصد**: دي var مش سر، وهي
        //    الفخ الموثّق في CLAUDE.md — لو ضاعت، الأداة بتفضل تكتب synced
        //    بصمت **بسعر من غير أي فرق**، والفحص ده هو الطريقة الوحيدة تشوفها.
        const rawDiff = env.PRICE_DIFFERENCE;
        const diffOk = Number.isFinite(parseFloat(rawDiff));
        add(diffOk, 'PRICE_DIFFERENCE',
          diffOk ? `${parseFloat(rawDiff)} (الفرق المضاف على كل سعر)`
                 : `غايبة أو مش رقم ("${rawDiff}") — الأداة هتزامن بفرق 0 في صمت`);

        add(true, 'envKeys', Object.keys(env).join(', '));
        add(true, 'Origin', request.headers.get('Origin') || '(بلا)');
        add(true, 'WORKER_VERSION', WORKER_VERSION);

        // ③ D1 — قراءة فقط: الجدولين اللي الأداة بتعتمد عليهم
        try {
          const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM logs WHERE tool = ?').bind(TOOL_NAME).first();
          add(true, 'D1 logs', `متصل — ${r?.n ?? 0} صف للأداة دي`);
        } catch (e) { add(false, 'D1 logs', `فشل: ${e.message}`); }
        try {
          const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM stylebox_price_sync_state').first();
          add(true, 'D1 state table', `موجود — ${r?.n ?? 0} variant متتبَّع`);
        } catch (e) { add(false, 'D1 state table', `فشل: ${e.message} — الـ ordering guard والكاش مش شغالين`); }

        // ④ شوبيفاي — OAuth + الصلاحيات + تكلفة الاستعلام
        try {
          const token = await getAccessToken(env);
          const d = await shopifyGQL(env, token,
            '{ currentAppInstallation { accessScopes { handle } } }', {}, 'diagScopes');
          const scopes = (d?.data?.currentAppInstallation?.accessScopes || []).map(x => x.handle);
          add(true, 'Shopify OAuth', 'التوكن اتجاب بنجاح');
          add(scopes.includes('read_products'), 'accessScopes',
            scopes.length ? scopes.join(', ') : '(فاضية — الأداة محتاجة read_products على الأقل)');
          const t = d?.extensions?.cost?.throttleStatus;
          if (t) add(true, 'throttleStatus',
            `متاح ${t.currentlyAvailable} من ${t.maximumAvailable} · استرجاع ${t.restoreRate}/ث`);
        } catch (e) { add(false, 'Shopify', `فشل: ${e.message}`); }

        // ⑤ WooCommerce — GET على variation مش موجود: **مفيش أي كتابة**.
        //    404 = الـ endpoint شغّال والسر مقبول · 401/403 = السر غلط
        try {
          const probeUrl = `${String(env.WP_BASE_URL || '').replace(/\/$/, '')}/wp-json/ecommoda/v1/variation-price/0`;
          const res = await fetch(probeUrl, { headers: { 'X-Sync-Header-Secret': env.SYNC_SECRET || '' } });
          if (res.status === 404) add(true, 'WooCommerce endpoint', '404 على variation وهمي = الـ endpoint شغّال والسر مقبول');
          else if (res.status === 401 || res.status === 403) add(false, 'WooCommerce endpoint', `${res.status} — SYNC_SECRET مرفوض من WordPress`);
          else add(true, 'WooCommerce endpoint', `HTTP ${res.status} (المتوقع 404 على variation وهمي)`);
        } catch (e) { add(false, 'WooCommerce endpoint', `تعذّر الوصول: ${e.message}`); }

        return json({ ok: checks.every(c => c.ok), checks }, 200, request);
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
  // الموضوع والمتجر بيتسجّلوا في كل صف — الأول لتتبع شكل الـ payload، والتاني
  // حارس متجر: حدث من دومين تاني معناه تسجيل ويبهوك غلط، مش بيانات غلط.
  const topic = request.headers.get('X-Shopify-Topic') || null;
  const shopDomain = request.headers.get('X-Shopify-Shop-Domain') || null;

  // ── §WEBHOOK::verify ── (CLIENT_SECRET — الويبهوك ده متسجّل عن طريق
  // Webhook Control Center، يعني API-created subscription — راجع §HELPERS
  // فوق وشرح shopify-webhook-helper Step 9)
  const secret = env.CLIENT_SECRET;
  const valid = await verifyShopifyHmac(secret, rawBody, hmacHeader);
  if (!valid) {
    ctx.waitUntil(safeWriteLog(env.DB, {
      tool: TOOL_NAME,
      type: 'hmac_failed',
      notes: 'فشل التحقق من HMAC — سر التوقيع غلط (تأكد إنه CLIENT_SECRET مش SHOPIFY_WEBHOOK_SECRET) أو الـ body اتغيّر',
      extra: {
        result: 'error', stage: 'lookup',
        webhookId, eventId, triggeredAt, topic, shopDomain,
        hmacHeaderPresent: !!hmacHeader,
        bodyBytes: rawBody.length,
        secretPresent: !!env.CLIENT_SECRET,
        envKeys: Object.keys(env),   // بيكشف اسم binding متسمّي غلط من أول فشل
      },
    }));
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
    processProductWebhook(env, payload, { webhookId, eventId, triggeredAt, topic, shopDomain }).catch((e) =>
      safeWriteLog(env.DB, {
        tool: TOOL_NAME,
        type: 'unexpected_error',
        notes: e.message || String(e),
        extra: { result: 'error', stage: 'lookup', webhookId, eventId, triggeredAt, topic, shopDomain },
      })
    )
  );

  return new Response('OK (accepted)', { status: 200 });
}

// ── §WEBHOOK::processProductWebhook ──
// بيلف على كل variant جوه المنتج، ويعمل sync للسعر لو عنده
// custom.wordpress_variation_id metafield. كل نتيجة (نجاح أو تخطي)
// بتتسجل في D1 لأن ده الطريقة الوحيدة لمراقبة Worker بلا واجهة.
async function processProductWebhook(env, payload, meta) {
  const { webhookId, eventId, triggeredAt, topic, shopDomain } = meta;
  const diff = getPriceDiff(env);

  // ── §WEBHOOK::emptyPayloadGuard ──
  if (!payload || !Array.isArray(payload.variants) || payload.variants.length === 0) {
    await safeWriteLog(env.DB, {
      tool: TOOL_NAME,
      type: 'empty_payload_bug',
      notes: 'Payload وصل من غير variants — تعذّر معرفة أي variant اتغير',
      extra: { result: 'rejected', stage: 'lookup', webhookId, eventId, triggeredAt, topic, shopDomain },
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
//
// 🔴 **بترجّع نتيجة العملية** — واحدة من مفردات extra.result المقفولة
//    (constants §12): success · warning · error · rejected · already.
//    الرجوع ده هو اللي بيخلّي bulk_sync_all يعرف يقول للواجهة إيه اللي حصل
//    فعلاً، بدل ما تعرض «✅ خلصت» على صفحة كل صفوفها فشلت. (Step 5A ④)
//
// ⚠️ **قاعدة عدم الضياع:** لكل variant صف واحد بالظبط في D1 — مفيش مسار
//    بيخرج من غير writeLog. (Step 5A ⑭)
async function processVariant(env, variant, ctx) {
  const { webhookId, eventId, triggeredAt, diff } = ctx;

  const variantGid = variant.admin_graphql_api_id || '';
  const variantId = variantGid.split('/').pop();
  const sku = variant.sku || null;
  let logged = true;

  // كل صف بياخد result (إيه اللي حصل) و stage (اتوقف فين):
  //   lookup = وقت الاستعلام/الفحص · write = وقت الكتابة على WooCommerce
  const log = async (entry) => {
    const ok = await safeWriteLog(env.DB, { tool: TOOL_NAME, sku, ...entry });
    if (!ok) logged = false;
    return ok;
  };

  if (!variantId) {
    await log({
      type: 'invalid_variant',
      notes: 'variant من غير admin_graphql_api_id — تعذّر تحديد الـ variant ID',
      extra: { result: 'rejected', stage: 'lookup', webhookId, eventId, variant },
    });
    return 'rejected';
  }

  // ── §WEBHOOK::linkGuard ──
  const wordpressVariationId = findMetafield(variant.metafields, 'custom', 'wordpress_variation_id');
  if (!wordpressVariationId) {
    await log({
      type: 'not_linked_yet',
      notes: 'الـ variant ده لسه من غير custom.wordpress_variation_id metafield',
      extra: { result: 'rejected', stage: 'lookup', variantId, webhookId, eventId },
    });
    return 'rejected';
  }

  // ── §WEBHOOK::orderingGuard ──
  // نفس الـ triggered_at بينطبق على كل الـ variants جوه نفس الحدث — ده مقصود:
  // الهدف منع حدث (delivery) قديم يكتب فوق حدث أحدث لنفس الـ variant، مش تتبع
  // توقيت كل variant لوحده.
  let claimPrevious = null;
  let claimTaken = false;
  if (triggeredAt) {
    const { claimed, previous } = await claimIfNewer(env.DB, variantId, triggeredAt);
    if (!claimed) {
      await log({
        type: 'stale_event_skipped',
        notes: 'الحدث ده أقدم من (أو مساوي لـ) آخر حدث اتعالج لنفس الـ variant — تم التجاهل',
        extra: { result: 'rejected', stage: 'lookup', variantId, webhookId, eventId, triggeredAt },
      });
      return 'rejected';
    }
    claimPrevious = previous;
    claimTaken = true;
  } else {
    // ⚠️ الصف ده **معلوماتي** ومالوش result — العملية بتكمّل بعده وبتكتب صفها
    //    الخاص. ده الاستثناء الوحيد من «صف واحد لكل variant».
    await log({
      type: 'no_triggered_at_header',
      notes: 'X-Shopify-Triggered-At مش موجود — تم التنفيذ من غير ordering guard',
      extra: { stage: 'lookup', variantId, webhookId, eventId },
    });
  }

  // بيرجّع الحجز لو الشغل فشل، عشان إعادة تسليم نفس الحدث تتعالج تاني
  const release = async () => {
    if (claimTaken) { try { await releaseClaim(env.DB, variantId, claimPrevious); } catch { /* أسوأ حالة: الحدث يتخطّى */ } }
  };

  // ── §WEBHOOK::computePrices ──
  const shopifyPrice = parseFloat(variant.price);
  if (!Number.isFinite(shopifyPrice)) {
    await log({
      type: 'invalid_price',
      notes: `price غير صالح من Shopify: "${variant.price}"`,
      extra: { result: 'rejected', stage: 'lookup', variantId, webhookId, eventId },
    });
    await release();
    return 'rejected';
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
  // 🔴 دي result='already' مش رفض ومش فشل: الحالة المستهدفة موجودة أصلاً
  //    ومفيش حاجة كانت مطلوبة. وهي **أكتر نوع صف في سجل الأداة دي**، فلو
  //    اتحسبت فشل أو تحذير، أكتر رسالة بتظهر تبقى أقلها إفادة. (constants §12)
  const lastSynced = await getLastSyncedPrice(env.DB, variantId);
  if (
    lastSynced &&
    lastSynced.last_synced_regular_price === regularPrice &&
    (lastSynced.last_synced_sale_price || '') === (salePrice || '')
  ) {
    await log({
      type: 'no_price_change_skipped',
      notes: 'السعر المحسوب مطابق لآخر قيمة اتزامنت — لا داعي لنداء WordPress',
      extra: { result: 'already', stage: 'lookup', variantId, webhookId, eventId, regularPrice, salePrice },
    });
    return 'already';
  }

  try {
    // متغيّر ناقص يوقف العملية باسمه، قبل أي نداء على WordPress (Step 5A ⑧)
    assertEnv(env, 'woo');

    // ── §WEBHOOK::fetchWpVariation ──
    const wp = await wcGetVariationPrice(env, wordpressVariationId);
    if (!wp) {
      await log({
        type: 'wp_variation_not_found',
        notes: `WordPress Variation Id (${wordpressVariationId}) مش موجود على WordPress`,
        extra: { result: 'rejected', stage: 'lookup', variantId, wordpressVariationId, webhookId, eventId },
      });
      await release();
      return 'rejected';
    }

    // ── §WEBHOOK::tripleCheck ── (SKU + GTIN — نفس منطق stock-sync)
    const skuMatch = String(sku || '').trim() === String(wp.sku || '').trim();
    const gtinMatch = String(wp.gtin || '').trim() === String(variantId || '').trim();

    if (!skuMatch) {
      await log({
        type: 'sku_mismatch',
        notes: `SKU مختلف — Shopify: "${sku}" | WordPress: "${wp.sku}"`,
        extra: { result: 'rejected', stage: 'lookup', variantId, wordpressVariationId, webhookId, eventId },
      });
      await release();
      return 'rejected';
    }
    if (!gtinMatch) {
      await log({
        type: 'gtin_mismatch',
        notes: `GTIN لا يطابق Variant ID — WordPress GTIN: "${wp.gtin}" | متوقع: "${variantId}"`,
        extra: { result: 'rejected', stage: 'lookup', variantId, wordpressVariationId, webhookId, eventId },
      });
      await release();
      return 'rejected';
    }

    // ── §WEBHOOK::syncPrice ──
    try {
      const result = await wcUpdateVariationPrice(env, wordpressVariationId, regularPrice, salePrice);
      await updateLastSyncedPrice(env.DB, variantId, regularPrice, salePrice);
      await log({
        type: 'synced',
        valueBefore: `regular:${wp.regular_price} / sale:${wp.sale_price || '-'}`,
        valueAfter: `regular:${regularPrice} / sale:${salePrice || '-'}`,
        notes: 'تمّت مزامنة السعر بنجاح',
        extra: {
          result: 'success', stage: 'write',
          variantId, wordpressVariationId, webhookId, eventId,
          shopifyPrice, shopifyCompare, priceDifference: diff, wcResult: result,
        },
      });
      // الكتابة تمّت بس السجل فشل — الواجهة لازم تعرف الفرق
      return logged ? 'success' : 'warning';
    } catch (wpErr) {
      // 🔴 error مش rejected: النداء **وصل** لـ WooCommerce واترفض (constants §12)
      await log({
        type: 'wp_update_failed',
        valueBefore: `regular:${wp.regular_price} / sale:${wp.sale_price || '-'}`,
        valueAfter: `regular:${regularPrice} / sale:${salePrice || '-'}`,
        notes: `فشل تحديث WordPress: ${wpErr.message}`,
        extra: { result: 'error', stage: 'write', variantId, wordpressVariationId, webhookId, eventId },
      });
      await release();
      return 'error';
    }

  } catch (e) {
    await log({
      type: 'unexpected_error',
      notes: e.message || String(e),
      extra: { result: 'error', stage: 'lookup', variantId, wordpressVariationId, webhookId, eventId },
    });
    await release();
    return 'error';
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
  assertEnv(env, 'shopify');           // متغيّر ناقص يوقف العملية باسمه
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
  // الفحص التالت: شوبيفاي ردّت 200 وبـ data، بس بلا الحمولة اللي طلبناها
  if (!conn) {
    throw new Error('productVariants: شوبيفاي ما رجّعتش productVariants — ' + JSON.stringify(data?.errors || data).slice(0, 200));
  }

  const triggeredAt = new Date().toISOString(); // نفس اللحظة لكل الصفحة — كافي لـ ordering guard هنا
  const batchTag = `bulk_sync_${triggeredAt}`;
  const diff = getPriceDiff(env);

  let scanned = 0;
  let linked = 0;
  // 🔴 عدّادات النتايج — من غيرها الواجهة بتعرض «✅ خلصت» حتى لو كل الصفوف
  //    فشلت. المفردات مقفولة (constants §12). (Step 5A ④ · html-builder 3C)
  const results = { success: 0, warning: 0, error: 0, rejected: 0, already: 0 };

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

    const r = await processVariant(env, shaped, {
      webhookId: batchTag,
      eventId: batchTag,
      triggeredAt,
      diff,
    });
    if (r && results[r] !== undefined) results[r]++;
  }

  return {
    scanned,
    linked,
    results,
    // تكلفة الاستعلام معروضة — الاقتراب من سقف النقط مابيبانش غير بانفجار
    // دفعة كاملة (Step 5A ⑪ ④)
    throttleStatus: data?.extensions?.cost?.throttleStatus || null,
    hasMore: conn.pageInfo.hasNextPage,
    nextCursor: conn.pageInfo.endCursor,
  };
}
