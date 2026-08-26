# مزامنة أسعار Stylebox (`Stylebox-Price-Sync`)

**بتعمل إيه:** بتستقبل ويبهوك `PRODUCTS_UPDATE` من Shopify وبتزامن سعر أي
variant مربوط بـ `custom.wordpress_variation_id` مع WooCommerce (stylebox.online)
تلقائيًا، مع هامش سعر ثابت (`PRICE_DIFFERENCE`) وTriple-check (SKU + GTIN).
فيها كمان مزامنة شاملة يدوية (`bulk_sync_all`) لكل الكتالوج صفحة صفحة.
**مين بيستخدمها:** حسابات / إدارة المخزون — تشغيل تلقائي بالكامل، الواجهة للمراقبة والمزامنة الشاملة اليدوية بس.
**الإصدار:** Worker `v1.0.0` · الواجهة `v1.0.0`   ← خط الأساس وقت النقل لـ git (26-08-2026)، الاتنين مستقلين

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
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات |

## D1

```
tool  : stylebox_price_sync
type  : synced · no_price_change_skipped · not_linked_yet · stale_event_skipped ·
        sku_mismatch · gtin_mismatch · wp_variation_not_found · wp_update_failed ·
        invalid_price · invalid_variant · empty_payload_bug · no_triggered_at_header ·
        hmac_failed · unexpected_error · login · logout
```

> ✅ مُسجَّلة في `ecommoda-constants` §7 بتاريخ 26-08-2026 (النقل ده) — مستنتجة
> من `TOOL_NAME` في الكود المنشور + جرد فعلي لكل قيم `type` في D1.

> ⚠️ **جدول D1 إضافي:** `stylebox_price_sync_state` (`variant_id` PK ·
> `last_triggered_at` · `last_synced_regular_price` · `last_synced_sale_price` ·
> `updated_at`) — ordering guard (منع حدث قديم يكتب فوق حدث أحدث) + cache
> (تجنّب نداء WordPress من غير داعي). موجود بالفعل، مفيش حاجة تتعمل.

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
إجمالي logs لـ tool='stylebox_price_sync':
  no_price_change_skipped : 3750
  synced                  : 812
  sku_mismatch             : 450   ⚠️ عدد كبير — يستاهل مراجعة، مش بند نقل
  not_linked_yet           : 86
  login                    : 11
  stale_event_skipped      : 1

variants متتبَّعة في stylebox_price_sync_state: 801
```

## فخاخ الأداة دي

- **الهيدر `X-Sync-Header-Secret` مختلف عن الاسم القياسي `X-EcomModa-Secret`**
  المستخدم في باقي أدوات WooCommerce (`woocommerce-sync-helper` §3). ده موجود
  في الكود المنشور فعليًا — سلوك قائم، مش غلطة نقل، ومتغيّرش من غير طلب صريح.
- **التعليق فوق `wcGetVariationPrice`/`wcUpdateVariationPrice` بيقول endpoint
  `variation-price` "لسه مش موجود على WordPress"** — ده تعليق قديم فات
  أوانه. صفوف D1 حية (`type='synced'`, `wcResult.success:true`) بتأكد إن
  الـ endpoint شغّال فعليًا. الكود اتنقل زي ما هو (بايت ببايت)، التعليق
  متسيّبش كما هو عمدًا — لو حد فتح الملف بعدين ولاحظ التناقض، ده السبب.
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
| ecommoda-worker-builder | v1.0.0 |
| ecommoda-html-builder | v1.0.0 |
| ecommoda-constants | v1.1.0 |

آخر مطابقة: 26-08-2026 · `index.js` v1.0.0 · `index.html` v1.0.0
🔴 معلّقة: — لا شيء

> سطر **🔴 معلّقة** = أي بند كاسر **معروف ومتقرر تأجيله**، بسببه.
> `— لا شيء` معناها مفيش. **بند 🔴 متأجل من غير ما يتكتب هنا = بند ضايع** —
> مفيش ملف تاني في المشروع بيتتبّعه.

## مسائل مفتوحة

- Build watch paths لسه على الافتراضي (`*`) — تضييقها لـ `index.js` +
  `wrangler.toml` اختياري (§13-ب في `ecommoda-tool-migration-playbook`)، مش
  إلزامي، بس بيقلل نشر Worker بلا داعي عند تعديل HTML بس.
