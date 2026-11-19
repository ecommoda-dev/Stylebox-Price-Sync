/**
 * EcomModa — Variation Price Sync API
 * -----------------------------------------------------------------
 * غرض هذا الـ snippet: يفتح endpoints تحت namespace ecommoda/v1
 * منفصلين تماماً عن أي snippet تاني (زي variation-stock).
 *
 * 1) GET  /wp-json/ecommoda/v1/variation-price/{id}
 *    → يرجع sku + gtin + regular_price + sale_price للـ variation المطلوبة
 *      (للـ Triple-Check ولمعرفة القيم القديمة قبل الكتابة)
 *
 * 2) POST /wp-json/ecommoda/v1/variation-price/{id}
 *    body: { "regular_price": "2999.00", "sale_price": "2799.00" }
 *    → sale_price ممكن تيجي "" (فاضية) عشان تشيل أي خصم موجود على WooCommerce
 *    → يحدّث السعر ويرجع القيم القديمة والجديدة
 *
 * 3) POST /wp-json/ecommoda/v1/variation-prices        ← جديد (Worker v1.4.0)
 *    body: { "items": [ { variation_id, expected_sku, expected_gtin,
 *                         regular_price, sale_price } ] }   (حد أقصى 50)
 *    → دفعة واحدة: لكل item تحقق SKU/GTIN من ناحية السيرفر ثم مقارنة ثم كتابة.
 *    → يرجع نتيجة لكل item بنفس ترتيب المدخلات:
 *      updated | unchanged | sku_mismatch | gtin_mismatch | not_found |
 *      bad_request | save_failed  — HTTP 200 حتى لو فيه items فاشلة.
 *    السبب: سقف Hostinger (429) — نداء واحد لكل 20 variant بدل نداءين لكل variant.
 *
 * الحماية: هيدر X-Sync-Header-Secret لازم يطابق SYNC_SECRET تحت.
 * ⚠️ التسمية موحّدة (متفق عليها) على كل أدوات المزامنة (stock / price /
 * أي endpoint جديد مستقبلاً) — نفس الاسم بالظبط في الطرفين:
 *   Header                 → X-Sync-Header-Secret
 *   Cloudflare Worker var   → SYNC_SECRET
 *   WordPress constant      → SYNC_SECRET
 * نفس القيمة بالظبط في الاتنين. ملحوظة: التوحيد ده اتطبق حالياً على
 * أداة الـ price بس — snippet الـ stock القديم لسه بيستخدم التسمية
 * القديمة (EC_STOCK_SYNC_SECRET) لحد ما يتحدّث هو كمان بنفس الطريقة.
 *
 * HPOS-safe: بيستخدم wc_get_product() / set_regular_price() /
 * set_sale_price() / save() فقط — مفيش أي SQL مباشر أو WordPress meta
 * functions قديمة.
 *
 * Cache: بعد كل كتابة بيتم مسح الـ product transients لنفس الـ variation
 * ولـ parent product بتاعها + WC_Product_Variable::sync() على الأب — من غير
 * كده السعر ممكن ميتحدّثش على الواجهة فوراً (مشكلة موثقة: WooCommerce
 * بيكاش الأسعار في transients + lookup table).
 * -----------------------------------------------------------------
 */

if (!defined('SYNC_SECRET')) {
    // ⚠️ غيّر القيمة دي لسر عشوائي طويل (32+ حرف) قبل النشر — ممنوع تسيبها
    // نص وصفي زي "SYNC_SECRET"، ده اسم الـ variable مش قيمته.
    // نفس القيمة بالظبط تتحط في Cloudflare Worker variable اسمها SYNC_SECRET
    define('SYNC_SECRET', 'SYNC_SECRET');
}

add_action('rest_api_init', function () {

    // دالة تحقق مشتركة بين كل الـ routes
    $permission_check = function (WP_REST_Request $request) {
        $incoming = $request->get_header('x-sync-header-secret');
        if (!$incoming || !hash_equals(SYNC_SECRET, $incoming)) {
            return new WP_Error(
                'ec_unauthorized',
                'Invalid or missing X-Sync-Header-Secret header',
                array('status' => 401)
            );
        }
        return true;
    };

    // ─────────────────────────────────────────────────────────
    // GET /wp-json/ecommoda/v1/variation-price/{id}
    // ─────────────────────────────────────────────────────────
    register_rest_route('ecommoda/v1', '/variation-price/(?P<id>\d+)', array(
        'methods'             => 'GET',
        'permission_callback' => $permission_check,
        'callback'            => function (WP_REST_Request $request) {
            $variation_id = (int) $request['id'];
            $product = wc_get_product($variation_id);

            if (!$product || $product->get_type() !== 'variation') {
                return new WP_Error(
                    'ec_not_found',
                    'Variation not found: ' . $variation_id,
                    array('status' => 404)
                );
            }

            return array(
                'variation_id'  => $variation_id,
                'sku'           => $product->get_sku(),
                'gtin'          => $product->get_global_unique_id(),
                'regular_price' => $product->get_regular_price(),
                'sale_price'    => $product->get_sale_price(),
            );
        },
    ));

    // ─────────────────────────────────────────────────────────
    // POST /wp-json/ecommoda/v1/variation-price/{id}
    // body: { "regular_price": "2999.00", "sale_price": "2799.00" | "" }
    // ─────────────────────────────────────────────────────────
    register_rest_route('ecommoda/v1', '/variation-price/(?P<id>\d+)', array(
        'methods'             => 'POST',
        'permission_callback' => $permission_check,
        'callback'            => function (WP_REST_Request $request) {
            $variation_id = (int) $request['id'];
            $params       = $request->get_json_params();

            if (!isset($params['regular_price']) || !is_numeric($params['regular_price'])) {
                return new WP_Error(
                    'ec_bad_request',
                    'regular_price (numeric string) is required in body',
                    array('status' => 400)
                );
            }

            // sale_price اختياري — لو مش موجود أو فاضي، بيتشال أي خصم قديم
            $sale_price_raw = isset($params['sale_price']) ? (string) $params['sale_price'] : '';
            if ($sale_price_raw !== '' && !is_numeric($sale_price_raw)) {
                return new WP_Error(
                    'ec_bad_request',
                    'sale_price must be a numeric string or empty string',
                    array('status' => 400)
                );
            }

            $product = wc_get_product($variation_id);
            if (!$product || $product->get_type() !== 'variation') {
                return new WP_Error(
                    'ec_not_found',
                    'Variation not found: ' . $variation_id,
                    array('status' => 404)
                );
            }

            $new_regular_price = (string) $params['regular_price'];

            // لو sale_price موجودة لازم تكون أقل من regular_price، وإلا WooCommerce
            // بيرفضها بصمت (السعر مبيتحدّثش من غير أي error ظاهر)
            if ($sale_price_raw !== '' && (float) $sale_price_raw >= (float) $new_regular_price) {
                return new WP_Error(
                    'ec_bad_request',
                    'sale_price must be less than regular_price',
                    array('status' => 400)
                );
            }

            $old_regular_price = $product->get_regular_price();
            $old_sale_price    = $product->get_sale_price();

            $product->set_regular_price($new_regular_price);
            $product->set_sale_price($sale_price_raw); // '' يشيل الخصم
            $product->save();

            // ── مسح الكاش ── من غير كده السعر ممكن ميتحدّثش فوراً على الواجهة
            // أو على تقرير الـ parent (الـ variable product نفسه بيعرض range
            // للأسعار من الـ lookup table المكاشّة)
            wc_delete_product_transients($variation_id);
            $parent_id = $product->get_parent_id();
            if ($parent_id) {
                // جديد: sync للأب (كان ناقص هنا — الـ endpoint الجديد بيعمله)
                if (class_exists('WC_Product_Variable')) {
                    WC_Product_Variable::sync($parent_id);
                }
                wc_delete_product_transients($parent_id);
            }

            return array(
                'success'           => true,
                'variation_id'      => $variation_id,
                'old_regular_price' => $old_regular_price,
                'old_sale_price'    => $old_sale_price,
                'new_regular_price' => $product->get_regular_price(),
                'new_sale_price'    => $product->get_sale_price(),
            );
        },
    ));

    // ─────────────────────────────────────────────────────────
    // POST /wp-json/ecommoda/v1/variation-prices   (دفعات — جديد)
    // ─────────────────────────────────────────────────────────
    register_rest_route( 'ecommoda/v1', '/variation-prices', array(
        'methods'             => 'POST',
        'permission_callback' => isset( $permission_check ) ? $permission_check : '__return_false',
        'callback'            => function ( WP_REST_Request $req ) {

            $items = $req->get_param( 'items' );
            if ( ! is_array( $items ) || empty( $items ) ) {
                return new WP_REST_Response( array( 'code' => 'ec_bad_request', 'message' => 'items مطلوبة (مصفوفة غير فاضية)' ), 400 );
            }
            if ( count( $items ) > 50 ) {
                return new WP_REST_Response( array( 'code' => 'ec_bad_request', 'message' => 'الحد الأقصى 50 item في النداء الواحد' ), 400 );
            }

            $results = array();   // نتيجة واحدة لكل item **بنفس ترتيب المدخلات** (الـ Worker بيطابق بالفهرس)
            $parents = array();   // parent_id => true — sync مرة واحدة لكل أب مش لكل مقاس
            $touched = array();   // variation ids اللي اتحدّثت فعلاً
            $summary = array(
                'total' => count( $items ), 'updated' => 0, 'unchanged' => 0, 'sku_mismatch' => 0,
                'gtin_mismatch' => 0, 'not_found' => 0, 'bad_request' => 0, 'save_failed' => 0,
            );

            // السعر "رقمي": '' مسموح لـ sale بس. بيرجّع null لو الشكل غلط.
            $num = function ( $v, $allow_empty ) {
                if ( is_string( $v ) || is_int( $v ) || is_float( $v ) ) {
                    $s = trim( (string) $v );
                    if ( $s === '' ) { return $allow_empty ? '' : null; }
                    if ( is_numeric( $s ) && (float) $s >= 0 ) { return $s; }
                }
                return null;
            };

            foreach ( array_values( $items ) as $idx => $it ) {
                $vid = ( is_array( $it ) && isset( $it['variation_id'] ) ) ? $it['variation_id'] : null;
                $row = array( 'index' => $idx, 'variation_id' => is_numeric( $vid ) ? (int) $vid : 0 );

                try {
                    // 1) تحقق الشكل
                    $valid_id = is_int( $vid ) || ( is_string( $vid ) && ctype_digit( $vid ) );
                    $reg  = ( is_array( $it ) && array_key_exists( 'regular_price', $it ) ) ? $num( $it['regular_price'], false ) : null;
                    $sale = ( is_array( $it ) && array_key_exists( 'sale_price', $it ) )    ? $num( $it['sale_price'], true )     : null;
                    if ( ! $valid_id || $reg === null || $sale === null
                         || ( $sale !== '' && (float) $sale >= (float) $reg ) ) {
                        $row['status']  = 'bad_request';
                        $row['message'] = 'variation_id رقم صحيح، regular_price رقمي، sale_price رقمي أو فاضي وأقل من regular';
                        $summary['bad_request']++;
                        $results[] = $row;
                        continue;
                    }
                    $vid = (int) $vid;
                    $row['variation_id'] = $vid;

                    // 2) المقاس لازم يكون WC_Product_Variation (0 مرفوض هنا — wc_get_product(0) مش آمنة)
                    $v = $vid > 0 ? wc_get_product( $vid ) : false;
                    if ( ! $v || ! ( $v instanceof WC_Product_Variation ) ) {
                        $row['status'] = 'not_found';
                        $summary['not_found']++;
                        $results[] = $row;
                        continue;
                    }

                    // 3) التحقق الثلاثي — نفس منطق Worker v1.3.0 (processVariant) بالحرف:
                    //    trim + مقارنة نصية صارمة، SKU الأول ثم GTIN. الـ item ده ماتكتبش لو فشل.
                    $wc_sku  = (string) $v->get_sku();
                    $wc_gtin = method_exists( $v, 'get_global_unique_id' )
                        ? (string) $v->get_global_unique_id()
                        : (string) $v->get_meta( '_global_unique_id' );
                    $exp_sku  = isset( $it['expected_sku'] )  ? (string) $it['expected_sku']  : '';
                    $exp_gtin = isset( $it['expected_gtin'] ) ? (string) $it['expected_gtin'] : '';

                    if ( trim( $exp_sku ) !== trim( $wc_sku ) ) {
                        $row['status']  = 'sku_mismatch';
                        $row['message'] = 'wc_sku=' . $wc_sku . ' expected_sku=' . $exp_sku;
                        $summary['sku_mismatch']++;
                        $results[] = $row;
                        continue;
                    }
                    if ( trim( $wc_gtin ) !== trim( $exp_gtin ) ) {
                        $row['status']  = 'gtin_mismatch';
                        $row['message'] = 'wc_gtin=' . $wc_gtin . ' expected_gtin=' . $exp_gtin;
                        $summary['gtin_mismatch']++;
                        $results[] = $row;
                        continue;
                    }

                    // 4) الأسعار الحالية = المطلوبة؟ (float بعد التطبيع، و'' = بدون تخفيض) ← unchanged من غير save()
                    $old_reg  = (string) $v->get_regular_price( 'edit' );
                    $old_sale = (string) $v->get_sale_price( 'edit' );
                    $same_reg  = ( $old_reg !== '' ) && abs( (float) $old_reg - (float) $reg ) < 0.005;
                    $same_sale = ( $sale === '' ) ? ( $old_sale === '' )
                                                  : ( $old_sale !== '' && abs( (float) $old_sale - (float) $sale ) < 0.005 );
                    if ( $same_reg && $same_sale ) {
                        $row['status']        = 'unchanged';
                        $row['regular_price'] = $old_reg;
                        $row['sale_price']    = $old_sale;
                        $summary['unchanged']++;
                        $results[] = $row;
                        continue;
                    }

                    // 5) كتابة WC CRUD
                    $v->set_regular_price( $reg );
                    $v->set_sale_price( $sale );
                    $v->save();

                    $row['status']            = 'updated';
                    $row['old_regular_price'] = $old_reg;
                    $row['old_sale_price']    = $old_sale;
                    $row['new_regular_price'] = (string) $reg;
                    $row['new_sale_price']    = (string) $sale;
                    $summary['updated']++;
                    $results[] = $row;

                    $touched[] = $vid;
                    $pid = (int) $v->get_parent_id();
                    if ( $pid > 0 ) { $parents[ $pid ] = true; }

                } catch ( Throwable $e ) {
                    $row['status']  = 'save_failed';
                    $row['message'] = $e->getMessage();
                    $summary['save_failed']++;
                    $results[] = $row;
                }
            }

            // بعد الحلقة — مرة واحدة لكل أب: sync + مسح الترانزيينتس (قاعدة PHP #6 — stylebox-mcp-access Step 6)
            foreach ( array_keys( $parents ) as $pid ) {
                if ( class_exists( 'WC_Product_Variable' ) ) { WC_Product_Variable::sync( $pid ); }
                wc_delete_product_transients( $pid );
            }
            foreach ( $touched as $tvid ) {
                wc_delete_product_transients( $tvid );
            }

            // HTTP 200 حتى لو فيه items فاشلة — الفشل الجزئي مش خطأ HTTP
            return new WP_REST_Response( array( 'success' => true, 'summary' => $summary, 'results' => $results ), 200 );
        },
    ) );

});
