<div dir="rtl" style="text-align: right;">

# مزامنة أسعار Stylebox (`Stylebox-Price-Sync`)

![version](https://img.shields.io/badge/version-v1.2.1-blue)

**بتعمل إيه:** بتستقبل ويبهوك `PRODUCTS_UPDATE` من Shopify وبتزامن سعر أي
variant مربوط بـ `custom.wordpress_variation_id` مع WooCommerce (stylebox.online)
تلقائيًا، مع هامش سعر ثابت (`PRICE_DIFFERENCE`) وTriple-check (SKU + GTIN).
فيها كمان مزامنة شاملة يدوية (`bulk_sync_all`) لكل الكتالوج صفحة صفحة.
**مين بيستخدمها:** حسابات / إدارة المخزون — تشغيل تلقائي بالكامل، الواجهة للمراقبة والمزامنة الشاملة اليدوية بس.
**الإصدار:** Worker `v1.2.1` · الواجهة `v1.2.0`   ← الاتنين مستقلين. خط الأساس
وقت النقل لـ git كان `v1.0.0`/`v1.0.0` (26-08-2026)؛ الرفع الحالي من جردة
12-09-2026 (دفعات ١+٢+٣ في v1.1.0، ودفعات ٤+٥ في v1.2.0)، و`v1.2.1` (24-09-2026)
بتاعة `check-log-values.mjs` المصلَّح + تسجيل الـ١٦ قيمة كاملة في
`log-values.json` + الحارس الديناميكي (الطبقة ٥ — `ecommoda-worker-builder`
Step 7-ج).

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Stylebox-Price-Sync/
الـ Worker : https://stylebox-price-sync-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: stylebox-price-sync-worker     ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

| المسار / `?action=` | بيعمل إيه |
|---|---|
| `POST /webhook` | مستقبِل ويبهوك Shopify `PRODUCTS_UPDATE` — HMAC بـ `CLIENT_SECRET` (مش `SHOPIFY_WEBHOOK_SECRET` — مسجّل عن طريق Webhook Control Center) |
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | Universal D1 Auth القياسي |
| `bulk_sync_all` | صفحة واحدة (40 variant) من كل الكتالوج — بترجع `cursor` للصفحة الجاية |
| `diag` | فحص ذاتي **بدون أي كتابة**: الأسرار (أسماء وأطوال بس) · `PRICE_DIFFERENCE` **بقيمتها** (var مش سر، وهي الفخ الموثّق تحت) · D1 والجدولين · شوبيفاي OAuth والصلاحيات و`throttleStatus` · endpoint ووردبريس (GET على variation وهمي، 404 = شغّال والسر مقبول) |
| `get_config` | نسخة الـ Worker (`WORKER_VERSION`) — الواجهة بتقارنها بـ `MIN_WORKER_VERSION` عندها وبتحذّر لو الـ Worker أقدم (Promote ناقص / rollback) |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات — فلترة وعدّ وترتيب **كلهم server-side**. الفلاتر المقبولة على التلاتة بنفس المجموعة: `employees` · `types` (CSV) · `search` (بيدوّر في **`sku`**) · `searchNotes` · `dateFrom` · `dateTo` · `sortBy`/`sortDir` (على `get_logs` بس). و`get_logs_export` بيرجّع `cap` و`total` و`truncated` جنب الصفوف |

## D1

```
tool  : stylebox_price_sync
type  : synced · no_price_change_skipped · not_linked_yet · stale_event_skipped ·
        sku_mismatch · gtin_mismatch · wp_variation_not_found · wp_update_failed ·
        invalid_price · invalid_variant · empty_payload_bug · no_triggered_at_header ·
        hmac_failed · unexpected_error · login · logout
```

> ✅ **البند اللي كان هنا اتقفل 24-09-2026 — مش بتعديل كود، بترحيل التسجيل نفسه.**
> `ecommoda-constants` v3.1.0 (§7.1) نقلت جدول `tool`/`type` من السكيل لملف
> `log-values.json` جنب `index.js` في كل ريبو — بالظبط عشان الفجوة اللي كانت
> هنا (تسجيل قيمة جديدة كان محتاج تغليف + رفع + ضغطة Update من أحمد، خطوة
> بشرية مؤجلة اتخرقت ٦ مرات في الستاك). الـ١٦ قيمة كلهم (بما فيهم الستة اللي
> كانوا معلّمين هنا: `invalid_price` · `invalid_variant` · `empty_payload_bug` ·
> `no_triggered_at_header` · `hmac_failed` · `logout`) مسجّلين دلوقتي في
> `log-values.json` بتاع الريبو ده، والدليل آلي: `node check-log-values.mjs`
> (النسخة المصلَّحة — Step 7 في `ecommoda-worker-builder`) بيرجّع exit 0.
> **الدليل من هنا فصاعدًا `log-values.json` نفسه، مش `CLAUDE.md`.**

> ⚠️ **جدول D1 إضافي:** `stylebox_price_sync_state` (`variant_id` PK ·
> `last_triggered_at` · `last_synced_regular_price` · `last_synced_sale_price` ·
> `updated_at`) — ordering guard (منع حدث قديم يكتب فوق حدث أحدث) + cache
> (تجنّب نداء WordPress من غير داعي). موجود بالفعل، مفيش حاجة تتعمل.
>
> ℹ️ **من v1.2.0:** `last_triggered_at` بقى ممكن يبقى `NULL` — الحجز بيترفع
> (`releaseClaim`) لما الشغل يفشل، عشان إعادة تسليم نفس الحدث تتعالج تاني.
> قبل كده أي فشل كان بيخلّي إعادة المحاولة على نفس الحدث **مستحيلة**
> (`stale_event_skipped` لأن المقارنة `>` صارمة).
>
> ℹ️ وصفوف السجل من v1.2.0 بقى فيها `extra.result` (مفردات `constants` §12:
> `success` · `warning` · `error` · `rejected` · `already`) و`extra.stage`
> (`lookup` / `write`) — وده اللي بيخلّي استعلام خط الأساس يقيس **الكتابة
> المؤكَّدة** مش المحاولات.
>
> ✅ **من v1.2.1: الحارس الديناميكي (الطبقة ٥ — `ecommoda-worker-builder`
> Step 7-ج) شغّال جوّه `writeLog`.** `LOG_REGISTRY` (`§LOG-REG` في `index.js`)
> مبني من الـ١٦ قيمة في `log-values.json`. قيمة `(tool, type)` مش مسجّلة
> **بتتكتب عادي** ومعاها `extra._unregistered = true`، وصف UPSERT بيتحط في
> `log_value_alerts` (جدول مشترك، `constants` §2) — **مفيش رفض كتابة أبدًا**.
> مفيش `writeLogsBatch` في الأداة دي (كتابة صف بصف بس)، فالحارس محتاج مكان
> واحد بس: `writeLog` نفسها — و`safeWriteLog` وكل نداءات `log()` المحلية جوّه
> `processVariant` بتعدّي عليها كلها.
>
> ⚠️ **`log-values.json` فيه `"logAnchors": ["log"]`** — القفلة المحلية
> `const log = async (entry) => safeWriteLog(env.DB, { tool: TOOL_NAME, sku,
> ...entry })` جوّه `processVariant` مش من الأسماء الافتراضية في
> `check-log-values.mjs` (`writeLog` / `safeWriteLog` / …)، فمن غير التسجيل ده
> الفحص الساكن ما كانش هيشوف ١١ من الـ١٦ قيمة خالص — مش تحذير، اختفاء تام
> (نفس عيلة `writeLogBatch` بدون `s` وshorthand `{ tool, type }` الموثّقة في
> السكيل). اتكتشف بمراجعة يدوية لأسماء دوال الكتابة في `processVariant`، مش
> من أوتبوت الفحص نفسه.

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET · SYNC_SECRET
Vars     : SHOP_DOMAIN · WP_BASE_URL · PRICE_DIFFERENCE   ← من [vars] في wrangler.toml بعد النقل
Build watch paths : * الافتراضي (مش مضيّقة — راجع §13-ب لو حابب تضيّقها)
```

⚠️ **`PRICE_DIFFERENCE` ليها fallback في الكود** (`getPriceDiff` بترجع `0`
لو القيمة غايبة أو مش رقم) — لو ضاعت في النقل، الأداة بتفضل شغّالة وتكتب
`synced` بصمت **بسعر من غير أي فرق**. القيمة اتأكَّدت `100` من
`extra.priceDifference` في صفوف D1 حية بتاريخ 26-08-2026 — **لازم Ahmed
يتأكد بعينه من Settings → Variables إنها لسه `100` بعد أول Promote.**

## CORS

`ALLOWED_ORIGINS` صارمة (بس `https://ecommoda-dev.github.io`) — لأن الأداة
**كتابة** (بتكتب أسعار على WooCommerce)، مش قراءة فقط.

## خط الأساس بعد النقل

> الأداة دي مالهاش أرقام واجهة ثابتة (مفيش صفحة "إحصائيات") — البديل من D1
> قبل النقل مباشرة (26-08-2026)، بدل زرار "تحديث" (راجع §0-ب):

```
> 🔴 **الأرقام اللي تحت مابقتش صالحة للمقارنة.** `ecommoda-constants` §7.1
> بيوثّق **تنظيف سجل D1 بتاريخ 12-09-2026** (قرار أحمد، بلا نسخ احتياطية):
> اتمسح **11,890 صف** من `stylebox_price_sync` وفضل **755** بس، وأقدم صف بقى
> `2026-09-09T22:00:10Z`. فأي مقارنة بأرقام 26-08 دي **بتقيس التنظيف مش
> الأداة**.
>
> ⚠️ وكمان الاستعلامات دي بتعدّ `type` لوحده — يعني بتقيس **المحاولات** مش
> الكتابة المؤكَّدة (`worker-builder` Step 5A ⑭). من v1.2.0 بقى ينفع تتقاس صح:

**الصيغة الصحيحة من v1.2.0 (بتقيس الكتابة الفعلية):**

```sql
SELECT type, json_extract(extra,'$.result') AS result, COUNT(*) AS n FROM logs WHERE tool = 'stylebox_price_sync' GROUP BY type, result ORDER BY n DESC;
```

**خط الأساس التاريخي (26-08-2026) — للسياق بس، اتمسح أغلبه في تنظيف 12-09:**

```
إجمالي logs لـ tool='stylebox_price_sync' (26-08-2026، قبل التنظيف):
  no_price_change_skipped : 3750
  synced                  : 812
  sku_mismatch             : 450   ⚠️ عدد كبير — يستاهل مراجعة، مش بند نقل
  not_linked_yet           : 86
  login                    : 11
  stale_event_skipped      : 1

variants متتبَّعة في stylebox_price_sync_state: 801
الباقي بعد تنظيف 12-09-2026: 755 صف (constants §7.1)
```

## فخاخ الأداة دي

- **الهيدر `X-Sync-Header-Secret` مختلف عن الاسم القياسي `X-EcomModa-Secret`**
  المستخدم في باقي أدوات WooCommerce (`woocommerce-sync-helper` §3). ده موجود
  في الكود المنشور فعليًا — سلوك قائم، مش غلطة نقل، ومتغيّرش من غير طلب صريح.
- **حارس `WORKER_SECRET` الغايب اتضاف في v1.1.0** — قبل كده لو السر ضاع أو
  اتضاف من غير Promote، القالب كان بينتج السلسلة الحرفية `"Bearer undefined"`
  فأي طلب بالهيدر ده بيعدّي. لو شوفت `WORKER_SECRET غير مضبوط` في رد الـ
  Worker، ده الحارس شغّال — ضيف السر واعمل Promote.
- **`updateLastSyncedPrice` كانت `UPDATE` على صف ممكن ميكونش موجود** (اتصلّحت
  في v1.1.0 كـ upsert). الصف بيتعمله INSERT جوّه `claimIfNewer` بس، واللي
  بتتخطّى في مسار `no_triggered_at_header` — فالكاش كان مابيتكتبش في صمت
  و`no_price_change_skipped` عمرها ما كانت تتحقق للحالة دي.
- ✅ **التعليق القديم فوق `wcGetVariationPrice` اتصحّح في v1.2.0.** كان بيقول
  إن endpoint `variation-price` "لسه مش موجود على WordPress" — وده فات أوانه
  (صفوف D1 حية `type='synced'` + `wcResult.success:true` بتأكد إنه شغّال).
  كان متسيّب عمدًا وقت النقل (نقل بايت ببايت)، وبقى مصيدة لأي حد يفتح الملف.
- ✅ **`PRICE_DIFFERENCE` بقى ليها فحص ظاهر من v1.2.0:** `?action=diag` بيرجّع
  **قيمتها الفعلية** (var مش سر) + تحذير صريح لو غايبة أو مش رقم، وزرار
  🩺 في شاشة الإعدادات بيعرضها. قبل كده الطريقة الوحيدة تشوفها كانت قراءة
  `extra.priceDifference` من صفوف D1 باليد. **الفخ نفسه لسه قائم** — القيمة
  الغايبة بتخلّي الأداة تكتب `synced` بصمت بسعر من غير أي فرق — بس بقى ليه
  كاشف.
- **٤٥٠ صف `sku_mismatch`** — رقم كبير نسبيًا لأداة شغّالة بانتظام. مش
  مشكلة نقل، بس يستاهل Ahmed يشوفها لو فاضي.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

```
مفيش نسخ HTML مرقّمة قديمة في الريبو وقت النقل — Index.html نسخة واحدة بس.
```

## بصمة المهارات

> الصيغة والقواعد والمهارات اللي بتدخل الجدول → `ecommoda-skill-versioning`
> Step 4. مهارة مالهاش رقم إصدار مابتدخلش الجدول.

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v3.7.0 |
| ecommoda-html-builder | v7.0.0 |
| ecommoda-constants | v3.1.0 |

آخر مطابقة: 24-09-2026 · `index.js` v1.2.1 · `index.html` v1.2.0
🔴 معلّقة:
- 🟡 **٤٥٠ صف `sku_mismatch`** في خط الأساس القديم — رقم كبير نسبيًا لأداة
  شغّالة بانتظام، ومش مشكلة كود. (أغلب الصفوف دي اتمسحت في تنظيف 12-09،
  فالمراجعة بقت على الصفوف الجديدة.)
- 🟡 **Build watch paths لسه على الافتراضي `*`** — راجع «مسائل مفتوحة» تحت.
- 🟡 **نسخة `esc()` في قالب `ecommoda-html-builder` بتكسر فاحص الربط بتاع
  المهارة نفسها** (`scripts/js-undef-check.js`): الـ tokenizer مابيعرفش
  regex literals فـ `/"/g` و `/'/g` بيتقروا كبداية سلسلة نصية وبيبلعوا تعريفات
  الدوال اللي بعدها. الأداة هنا بتستخدم صيغة `split/join` **بنفس الناتج
  بالحرف** عشان الفحص يعدّي — البند مرصود للإبلاغ في المهارة، مش مشكلة في
  الأداة.

> سطر **🔴 معلّقة** = أي بند كاسر **معروف ومتقرر تأجيله**، بسببه.
> `— لا شيء` معناها مفيش. **بند 🔴 متأجل من غير ما يتكتب هنا = بند ضايع** —
> مفيش ملف تاني في المشروع بيتتبّعه.

## مسائل مفتوحة

- Build watch paths لسه على الافتراضي (`*`) — تضييقها لـ `index.js` +
  `wrangler.toml` اختياري (§13-ب في `ecommoda-tool-migration-playbook`)، مش
  إلزامي، بس بيقلل نشر Worker بلا داعي عند تعديل HTML بس.

---

آخر تحديث: 24-09-2026 — تحديث `check-log-values.mjs` (يمسك object shorthand) + تسجيل الـ١٦ قيمة كاملة في `log-values.json` + الحارس الديناميكي (الطبقة ٥)

</div>
