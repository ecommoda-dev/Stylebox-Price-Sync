// EcomModa — Stylebox Price Sync (v1.4.0)
// skills: worker-builder v4.2.0 · constants v6.0.1 · shopify-graphql-helper v3.2.0 · woocommerce-sync-helper v2.2.0 — 19-11-2026

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'stylebox_price_sync';

// بيرجع من ?action=get_config — الواجهة بتقارنه بـ MIN_WORKER_VERSION عندها،
// فـ Promote ناقص أو rollback بيبان بدل ما يفضل صامت.
const WORKER_VERSION = '1.4.0';

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

// ─── سقف الـ 429 — ميزانية النداءات (woocommerce-sync-helper Step 3.5) ───
// نافذة متحركة ≈ ٣٠ نداء / ٣٠–٦٠ ث على stylebox.online، **مشتركة بين كل الـ Workers**.
// قبل v1.4.0: نداءين لكل variant (GET ثم POST) = ٨٠ نداء لصفحة bulk. دلوقتي نداء
// واحد لكل دفعة (التحقق SKU/GTIN بيحصل على سيرفر ووردبريس): ٤٠ variant = ٢ نداء.
// مصدر الأرقام: لوجز كلاودفلير 19-11-2026 (66 variant فشلوا بـ WP GET 429 جسم فاضي).
const WP_BATCH_SIZE   = 20;    // عدد الـ items في النداء الواحد (حد السيرفر الأقصى ٥٠)
const WP_BATCH_GAP_MS = 1500;  // فاصل بين دفعتين متتاليتين — متوازي ممنوع (الموقع بيرجّع 500)
const RATE_LIMIT_DEFAULT_RETRY_SEC = 120;  // لو Retry-After غايب: النافذة بتفضى بعد ~١٫٥–٢ دقيقة سكون

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
// §SHOPIFY::getAccessToken — التوكن والـ throttle bucket مشتركين بين كل Workers الستاك
// (نفس الـ Custom App)، فالفشل العابر لازم يتعافى بدل ما يتحوّل لفشل كامل
// (worker-builder Step 5A ⑯ ②). الاسم OAUTH_MAX_ATTEMPTS مقصود — وصفة الجرد بتدوّر عليه.
const OAUTH_MAX_ATTEMPTS = 3;

async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
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
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        lastErr = new Error(`OAuth failed: ${resp.status}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('No access_token in response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: unknown failure');
}

// 🔴 النسخة المعتمدة (worker-builder Step 5A ①) — بترمي على: فشل شبكة ·
//    HTTP status · رد مش JSON · data.errors · data فاضية، + إعادة محاولة على
//    THROTTLED. النسخة القديمة كانت `return resp.json()` وبس، يعني 401/429/5xx
//    من شوبيفاي كانت بتعدّي كأنها رد سليم وأي throttle بيقتل صفحة كاملة من
//    المزامنة الشاملة برسالة مبهمة.
// ⑮ تكلفة الاستعلام — throttleStatus (الرصيد المتبقي) + actualQueryCost (النداء كلّف قد إيه)
//    للقياس بس: صفر اعتماد من الواجهة عليهم. costLog اختياري لتجميع تفصيل لكل استعلام.
let _lastThrottle  = null;
let _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-10/graphql.json`, {
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
    const cost = data.extensions?.cost;
    if (cost) {
      if (cost.throttleStatus) _lastThrottle = cost.throttleStatus;
      _lastQueryCost = { op: opName, requested: cost.requestedQueryCost ?? null, actual: cost.actualQueryCost ?? null };
      if (costLog) costLog.push({ ..._lastQueryCost });
    }
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

// ════════════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥)
// ════════════════════════════════════════════════════════════
// قطعة الأداة دي بس من log-values.json اللي جنبها — بتتحدّث معاه في
// نفس الـ commit. ممنوع شحن السجل الكامل بتاع كل الأدوات هنا
// (worker-builder Step 7-ب عن ليه).
const LOG_REGISTRY = {
  stylebox_price_sync: new Set([
    'login', 'logout', 'hmac_failed', 'unexpected_error',
    'empty_payload_bug', 'invalid_variant', 'not_linked_yet',
    'stale_event_skipped', 'no_triggered_at_header', 'invalid_price',
    'no_price_change_skipped', 'wp_variation_not_found', 'sku_mismatch',
    'gtin_mismatch', 'synced', 'wp_update_failed', 'rate_limited',
  ]),
};

const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

// UPSERT على (source_tool, tool, type) — صف واحد لكل قيمة، hits بيعدّ.
// الحدث الكامل مش بيضيع: الصف الأصلي موجود في logs وعليه _unregistered،
// والجدول ده فهرس مش سجل تاني — عشان كده dedupe مش صف لكل حدث.
const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

// فشل التنبيه ممنوع يأثر على أي حاجة — try/catch صامت. بتجمّع التكرار
// جوّه نفس الدفعة في صف واحد (hits) قبل ما تكتب.
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

async function writeLog(db, entry) {
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

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
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);
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
// endpoint الدفعات: POST /wp-json/ecommoda/v1/variation-prices (v1.4.0)
//   body: { items: [{ variation_id, expected_sku, expected_gtin, regular_price, sale_price }] }
//   السيرفر بيعمل triple-check (SKU + GTIN) ويقارن ويكتب، ويرجّع نتيجة لكل item
//   **بنفس ترتيب المدخلات** (+ حقل index): updated | unchanged | sku_mismatch |
//   gtin_mismatch | not_found | bad_request | save_failed. الفشل الجزئي = HTTP 200.
// الـ routes القديمة (GET/POST variation-price/{id}) لسه موجودة على الموقع للتوافق
// ومابتتنادّاش من الـ Worker ده (diag بس بيعمل probe عليها).
// الهيدر X-Sync-Header-Secret (مش X-EcomModa-Secret القياسي — سلوك قائم، CLAUDE.md).
// ══════════════════════════════════════════════════════
class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super('WP rate-limited (429)');
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;   // null لو Retry-After غايب
  }
}

async function wcBatchUpdatePrices(env, items) {
  const res = await fetch(
    `${String(env.WP_BASE_URL).replace(/\/$/, '')}/wp-json/ecommoda/v1/variation-prices`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Header-Secret': env.SYNC_SECRET },
      body: JSON.stringify({ items }),
    }
  );
  const text = await res.text();
  if (res.status === 429) {
    // 429 بجسم **فاضي** = سقف الاستضافة (اتقفل قبل ما PHP يشتغل) → circuit breaker.
    // 429 بجسم JSON = حاجة تانية (بلجن/ووكومرس) → خطأ عادي، مش rate limit.
    if (!text.trim()) {
      const ra = parseInt(res.headers.get('Retry-After') || '', 10);
      throw new RateLimitError(Number.isFinite(ra) ? ra : null);
    }
    throw new Error(`WP batch failed: 429 ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`WP batch failed: ${res.status} ${text.slice(0, 300)}`);
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`WP batch: رد مش JSON — ${text.slice(0, 200)}`); }
  if (!body || !Array.isArray(body.results)) throw new Error('WP batch: الرد من غير results[]');
  return body;   // { success, summary, results[] }
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
      // لحد ما hasMore: false. مبني فوق prepareVariant()+flushBatch() نفسهم اللي
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
          // ℹ️ read_all_orders: بدونها الأوردرات الأقدم من 60 يوم بترجع «غير موجود» بدل خطأ صلاحية.
          //    الأداة دي مابتقراش أوردرات أصلاً، فالفحص معلومة مش شرط (shopify-graphql-helper §3.2).
          add(true, 'read_all_orders', scopes.includes('read_all_orders') ? 'ممنوحة' : 'غير ممنوحة — مش مطلوبة للأداة دي (بتزامن أسعار variants مش أوردرات)');
          const t = d?.extensions?.cost?.throttleStatus;
          if (t) add(true, 'throttleStatus',
            `متاح ${t.currentlyAvailable} من ${t.maximumAvailable} · استرجاع ${t.restoreRate}/ث`);
          const qc = d?.extensions?.cost;
          if (qc) add(true, 'actualQueryCost',
            `آخر نداء (${_lastQueryCost?.op || 'diagScopes'}) كلّف ${qc.actualQueryCost ?? '؟'} نقطة (المطلوب ${qc.requestedQueryCost ?? '؟'})`);
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

        // ⑥ endpoint الدفعات (v1.4.0) — POST بـ items:[] **بدون أي كتابة**.
        //    400 = الـ route شغّال والسر مقبول · 404 rest_no_route = السنيپت لسه ما اتلصقش ·
        //    401/403 = السر غلط · 429 = سقف الاستضافة (استنى ~دقيقتين)
        try {
          const res = await fetch(`${String(env.WP_BASE_URL || '').replace(/\/$/, '')}/wp-json/ecommoda/v1/variation-prices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Sync-Header-Secret': env.SYNC_SECRET || '' },
            body: JSON.stringify({ items: [] }),
          });
          if (res.status === 400) add(true, 'WooCommerce batch endpoint', '400 على items فاضية = route الدفعات شغّال والسر مقبول');
          else if (res.status === 404) add(false, 'WooCommerce batch endpoint', '404 — سنيپت الدفعات (variation-prices) لسه ما اتلصقش على WordPress');
          else if (res.status === 401 || res.status === 403) add(false, 'WooCommerce batch endpoint', `${res.status} — SYNC_SECRET مرفوض من WordPress`);
          else if (res.status === 429) add(false, 'WooCommerce batch endpoint', '429 — سقف الاستضافة (استنى ~دقيقتين وأعد الفحص)');
          else add(false, 'WooCommerce batch endpoint', `HTTP ${res.status} (المتوقع 400 على items فاضية)`);
        } catch (e) { add(false, 'WooCommerce batch endpoint', `تعذّر الوصول: ${e.message}`); }

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
// بيحضّر **كل** variants المنتج (prepareVariant — صفر نداءات WordPress)، وبعدين
// بيبعتهم مرة واحدة في flushBatch: نداء واحد بدل 2×N. كل نتيجة (نجاح أو تخطي)
// بتتسجل في D1 لأن ده الطريقة الوحيدة لمراقبة Worker بلا واجهة.
//
// ⚠️ لو WordPress رفض بـ 429 (سقف الاستضافة) التحديث **بيضيع** — شوبيفاي مش
//    هتعيد بعد الـ 200. التعويض الوحيد: صف rate_limited لكل variant + الحجز
//    اترجّع، والمزامنة الشاملة بتلحقه. ممنوع setTimeout/retry جوّه waitUntil
//    (الطابور الدائم = Tier 4، خارج النطاق).
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

  const pending = [];
  for (const variant of payload.variants) {
    const prep = await prepareVariant(env, variant, { webhookId, eventId, triggeredAt, diff, force: false });
    if (prep.pending) pending.push(prep.pending);
  }
  await flushBatch(env, pending);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── §WEBHOOK::prepareVariant ──
// ⚠️ مصدر الحقيقة الوحيد لحساب السعر وحراس ما-قبل-WordPress — بتُستخدم من
// الويبهوك (شكل REST payload) ومن bulk_sync_all (شكل GraphQL مُعاد تشكيله لنفس
// البنية جوه runBulkSyncPage). أي تعديل هنا بينطبق على الاتنين.
//
// **صفر نداءات WordPress هنا.** بترجّع واحد من:
//   { done: 'rejected' | 'already' }  — الصف اتكتب في D1 خلاص
//   { pending: {...} }                — جاهز للكتابة، ينتظر flushBatch
// الـ triple-check (SKU + GTIN) بقى على سيرفر ووردبريس جوّه endpoint الدفعات
// (نفس شروط النسخة القديمة بالحرف: trim + مقارنة نصية، SKU الأول ثم GTIN).
//
// ctx.force: bulk بيتخطّى noChangeGuard — الكاش بيخزّن **آخر قيمة زامنّاها** مش
// القيمة الفعلية على WC، فلو السعر اتغيّر بره الأداة الكاش بيكدّب. الـ endpoint
// الجديد رخيص وبيرجّع `unchanged` بنفسه لو مطابق فعلًا. الويبهوك يفضل على الكاش.
//
// ⚠️ **قاعدة عدم الضياع:** لكل variant صف واحد بالظبط في D1 — مفيش مسار
//    بيخرج من غير writeLog (flushBatch بتكمّل الصف للـ pending). (Step 5A ⑭)
async function prepareVariant(env, variant, ctx) {
  const { webhookId, eventId, triggeredAt, diff, force } = ctx;

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
    return { done: 'rejected' };
  }

  // ── §WEBHOOK::linkGuard ──
  const wordpressVariationId = findMetafield(variant.metafields, 'custom', 'wordpress_variation_id');
  if (!wordpressVariationId) {
    await log({
      type: 'not_linked_yet',
      notes: 'الـ variant ده لسه من غير custom.wordpress_variation_id metafield',
      extra: { result: 'rejected', stage: 'lookup', variantId, webhookId, eventId },
    });
    return { done: 'rejected' };
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
      return { done: 'rejected' };
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
    return { done: 'rejected' };
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

  // ── §WEBHOOK::noChangeGuard ── (تجنّب نداء WordPress من غير داعي — الويبهوك بس)
  // 🔴 دي result='already' مش رفض ومش فشل: الحالة المستهدفة موجودة أصلاً
  //    ومفيش حاجة كانت مطلوبة. وهي **أكتر نوع صف في سجل الأداة دي**، فلو
  //    اتحسبت فشل أو تحذير، أكتر رسالة بتظهر تبقى أقلها إفادة. (constants §12)
  if (!force) {
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
      return { done: 'already' };
    }
  }

  return {
    pending: {
      variantId, sku, wordpressVariationId, regularPrice, salePrice,
      shopifyPrice, shopifyCompare, diff, webhookId, eventId,
      log, release, wasLogged: () => logged,
    },
  };
}

// ── §WEBHOOK::flushBatch ──
// بيبعت الـ pending على دفعات WP_BATCH_SIZE **متتالية** (فاصل WP_BATCH_GAP_MS —
// متوازي ممنوع) ويكمّل صف D1 لكل variant. بيرجّع:
//   { outcomes[] (بنفس ترتيب pendingList: success|warning|error|rejected|already|deferred),
//     rateLimited, retryAfterSec }
// 🔴 **circuit breaker:** أول 429 بجسم فاضي يوقف الدورة — كل اللي لسه ما اتبعتش
//    (الدفعة الحالية + الباقي) ← releaseClaim + صف rate_limited لكل variant، outcome
//    'deferred'، ومفيش إعادة محاولة جوّه نفس الاستدعاء (كل نداء زيادة = 429 زيادة).
async function flushBatch(env, pendingList) {
  const n = pendingList.length;
  const outcomes = new Array(n).fill(null);
  if (n === 0) return { outcomes, rateLimited: false, retryAfterSec: null };

  const failUnexpected = async (p, message) => {
    await p.log({
      type: 'unexpected_error',
      notes: message,
      extra: { result: 'error', stage: 'write', variantId: p.variantId, wordpressVariationId: p.wordpressVariationId, webhookId: p.webhookId, eventId: p.eventId },
    });
    await p.release();
    return 'error';
  };

  // متغيّر ناقص يوقف العملية باسمه، مرة واحدة قبل أول دفعة (Step 5A ⑧)
  try { assertEnv(env, 'woo'); }
  catch (e) {
    for (let i = 0; i < n; i++) outcomes[i] = await failUnexpected(pendingList[i], e.message || String(e));
    return { outcomes, rateLimited: false, retryAfterSec: null };
  }

  for (let start = 0; start < n; start += WP_BATCH_SIZE) {
    const end = Math.min(start + WP_BATCH_SIZE, n);
    if (start > 0) await sleep(WP_BATCH_GAP_MS);

    const items = [];
    for (let i = start; i < end; i++) {
      const p = pendingList[i];
      items.push({
        variation_id:  Number(p.wordpressVariationId),
        expected_sku:  String(p.sku || ''),
        expected_gtin: String(p.variantId),     // GTIN على ووردبريس = Shopify variant numeric ID
        regular_price: p.regularPrice,
        sale_price:    p.salePrice || '',
      });
    }

    let body;
    try {
      body = await wcBatchUpdatePrices(env, items);
    } catch (e) {
      if (e instanceof RateLimitError) {
        for (let i = start; i < n; i++) {
          const p = pendingList[i];
          await p.log({
            type: 'rate_limited',
            notes: 'WordPress رفض بسبب سقف الاستضافة (429) — اتوقفت الدورة والحجز اترجّع',
            extra: { result: 'warning', stage: 'write', variantId: p.variantId, wordpressVariationId: p.wordpressVariationId, webhookId: p.webhookId, eventId: p.eventId, retryAfterSec: e.retryAfterSec },
          });
          await p.release();
          outcomes[i] = 'deferred';
        }
        return { outcomes, rateLimited: true, retryAfterSec: e.retryAfterSec };
      }
      // أي خطأ تاني على الدفعة كلها: unexpected_error + إرجاع الحجز، وكمّل للدفعة اللي بعدها
      for (let i = start; i < end; i++) outcomes[i] = await failUnexpected(pendingList[i], `فشل نداء الدفعة: ${e.message || e}`);
      continue;
    }

    for (let i = start; i < end; i++) {
      const p = pendingList[i];
      const item = body.results[i - start];
      try {
        if (!item || Number(item.variation_id) !== Number(p.wordpressVariationId)) {
          outcomes[i] = await failUnexpected(p, 'رد الدفعة مش مطابق للمدخلات (results ناقصة أو بترتيب مختلف)');
        } else {
          outcomes[i] = await applyBatchResult(env, p, item);
        }
      } catch (e) {
        outcomes[i] = await failUnexpected(p, e.message || String(e));
      }
    }
  }
  return { outcomes, rateLimited: false, retryAfterSec: null };
}

// ── §WEBHOOK::applyBatchResult ── نتيجة item واحد من السيرفر → صف D1 + الكاش
// بيرجّع واحدة من مفردات extra.result المقفولة (constants §12).
async function applyBatchResult(env, p, item) {
  const base = { variantId: p.variantId, wordpressVariationId: p.wordpressVariationId, webhookId: p.webhookId, eventId: p.eventId };
  const before = `regular:${item.old_regular_price ?? item.regular_price ?? '-'} / sale:${(item.old_sale_price ?? item.sale_price) || '-'}`;
  const after  = `regular:${p.regularPrice} / sale:${p.salePrice || '-'}`;
  // ⚠️ مفتاح type بيتكتب **صريح** في كل مكان (مفيش shorthand — worker-builder Step 7)
  const rejectDone = async () => { await p.release(); return 'rejected'; };

  switch (item.status) {
    case 'updated':
      await updateLastSyncedPrice(env.DB, p.variantId, p.regularPrice, p.salePrice);
      await p.log({
        type: 'synced',
        valueBefore: before,
        valueAfter: after,
        notes: 'تمّت مزامنة السعر بنجاح',
        extra: {
          result: 'success', stage: 'write', ...base,
          shopifyPrice: p.shopifyPrice, shopifyCompare: p.shopifyCompare, priceDifference: p.diff, wcResult: item,
        },
      });
      // الكتابة تمّت بس السجل فشل — الواجهة لازم تعرف الفرق
      return p.wasLogged() ? 'success' : 'warning';

    case 'unchanged':
      // الحالة مطابقة فعلًا على WooCommerce — الكاش بيتحدّث (ده بيصلّح كاش كان بيكدّب)
      await updateLastSyncedPrice(env.DB, p.variantId, p.regularPrice, p.salePrice);
      await p.log({
        type: 'no_price_change_skipped',
        notes: 'السعر على WooCommerce مطابق فعلًا للمحسوب — السيرفر ماكتبش حاجة',
        extra: { result: 'already', stage: 'write', ...base, regularPrice: p.regularPrice, salePrice: p.salePrice },
      });
      return 'already';

    case 'sku_mismatch':
      await p.log({
        type: 'sku_mismatch',
        notes: `SKU مختلف — Shopify: "${p.sku}" | ${item.message || 'WordPress'}`,
        extra: { result: 'rejected', stage: 'lookup', ...base },
      });
      return rejectDone();
    case 'gtin_mismatch':
      await p.log({
        type: 'gtin_mismatch',
        notes: `GTIN لا يطابق Variant ID (متوقع: "${p.variantId}") — ${item.message || ''}`,
        extra: { result: 'rejected', stage: 'lookup', ...base },
      });
      return rejectDone();
    case 'not_found':
      await p.log({
        type: 'wp_variation_not_found',
        notes: `WordPress Variation Id (${p.wordpressVariationId}) مش موجود على WordPress`,
        extra: { result: 'rejected', stage: 'lookup', ...base },
      });
      return rejectDone();

    case 'bad_request':
    case 'save_failed':
      // 🔴 error مش rejected: النداء **وصل** لـ WooCommerce واترفض/فشل (constants §12)
      await p.log({
        type: 'wp_update_failed',
        valueBefore: before,
        valueAfter: after,
        notes: `فشل تحديث WordPress (${item.status}): ${item.message || ''}`,
        extra: { result: 'error', stage: 'write', ...base, wpStatus: item.status },
      });
      await p.release();
      return 'error';

    default:
      throw new Error(`status غير معروف من السيرفر: "${item.status}"`);
  }
}

// ══════════════════════════════════════════════════════
// §BULK-SYNC — runBulkSyncPage
// صفحة واحدة (BULK_SYNC_PAGE_SIZE variant) من كل الكتالوج — مش بس المربوطين.
// بيقرا metafield custom.wordpress_variation_id مباشرة مع الصفحة (نداء واحد،
// مفيش N+1)، وبيعيد تشكيل كل variant لنفس بنية الويبهوك عشان prepareVariant()
// تشتغل من غير أي تكرار في منطق السعر. بعدين flushBatch مرة واحدة للصفحة كلها
// (٤٠ variant = دفعتين = نداءين لووردبريس بدل ٨٠).
//
// ⚠️ لو WordPress رفض بـ 429: `rateLimited: true` + `nextCursor` = **نفس cursor
//    الصفحة دي** (الواجهة بتعيدها بالظبط) + `retryAfterSec`. اللي اتعالج قبل الـ429
//    متحسوب في results، واللي لسه في `deferred` (مش error).
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
  const queryCost = [];
  const data = await shopifyGQL(env, token, query, { cursor }, 'productVariants', queryCost);
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
  let deferred = 0;   // اتأجّلت بسبب 429 — مش error، ومش من مفردات result

  const pending = [];
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

    // force: الشاملة بتتخطّى كاش «آخر قيمة زامنّاها» (يكدّب لو WC اتغيّر بره الأداة)
    const prep = await prepareVariant(env, shaped, {
      webhookId: batchTag,
      eventId: batchTag,
      triggeredAt,
      diff,
      force: true,
    });
    if (prep.done) results[prep.done]++;
    else pending.push(prep.pending);
  }

  const flushed = await flushBatch(env, pending);
  for (const o of flushed.outcomes) {
    if (o === 'deferred') deferred++;
    else if (o && results[o] !== undefined) results[o]++;
  }

  const rateLimited = flushed.rateLimited;
  return {
    scanned,
    linked,
    results,
    deferred,
    rateLimited,
    retryAfterSec: rateLimited ? (flushed.retryAfterSec ?? RATE_LIMIT_DEFAULT_RETRY_SEC) : null,
    // تكلفة الاستعلام معروضة — الاقتراب من سقف النقط مابيبانش غير بانفجار
    // دفعة كاملة (Step 5A ⑪ ④)
    throttleStatus: data?.extensions?.cost?.throttleStatus || null,
    queryCost,   // ⑮ تفصيل لكل استعلام (للقياس بس)
    // لو rateLimited: نفس cursor الصفحة دي (مش اللي بعدها) والواجهة تعيدها بعد الانتظار
    hasMore: rateLimited ? true : conn.pageInfo.hasNextPage,
    nextCursor: rateLimited ? (cursor || null) : conn.pageInfo.endCursor,
    done: !rateLimited && !conn.pageInfo.hasNextPage,
  };
}
