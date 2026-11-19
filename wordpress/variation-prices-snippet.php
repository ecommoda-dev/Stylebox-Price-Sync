// ══════════════════════════════════════════════════════════════════════
// EcomModa — endpoint الدفعات: POST /wp-json/ecommoda/v1/variation-prices
// الإصدار: v1.0.0 — 19-11-2026 (يخدم stylebox-price-sync-worker v1.4.0)
//
// ⚠️ للّصق في WPCode (سنيپت `EcomModa – MCP Abilities`) — WPCode بيضيف <?php
//    لوحده، فالملف ده **من غير** <?php عن قصد. متلزقش <?php.
// ⚠️ حطّه **جوّه نفس** add_action( 'rest_api_init', function () { ... } ) اللي فيها
//    routes الـ variation-price القديمة (GET/POST variation-price/{id}) — لأنه
//    بيستخدم نفس $permission_check (hash_equals على X-Sync-Header-Secret). متمسحش
//    القديمة ولا $permission_check.
//    لو اتلصق برّه الـ closure ده، $permission_check مش معرّف → الـ route بيرد 401 دايمًا
//    (fail-closed — مفيش وضع بيفتح من غير سر).
// ⚠️ مفيش سر في الملف ده.
// ══════════════════════════════════════════════════════════════════════

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
