// routes/purchase-requests.js
// 掛載：app.use('/api/purchase-requests', require('./routes/purchase-requests')(pool, schemaName))

const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');
const { getEmbedding } = require('./purchase-requests-embedding-free');

/**
 * 將請購單資料拼接成適合 embedding 的文字
 */
function buildEmbeddingText(pr, items = []) {
  const parts = [
    `請購單號 ${pr.order_no}`,
    `供應商 ${pr.vendor_name}（${pr.vendor_id}）`,
    `請購類別 ${pr.type_id === 'R' ? '原料' : '物料'}`,
    `請購日期 ${pr.order_date}`,
    `需求日期 ${pr.delivery_date}`,
    `請購人員 ${pr.salesperson_name}`,
    `狀態 ${
      pr.status === 'created'   ? '建立中' :
      pr.status === 'confirmed' ? '已確認' : '已核准'
    }`,
    pr.delivery_address ? `運送地址 ${pr.delivery_address}` : '',
    pr.remark           ? `備註 ${pr.remark}` : '',
    items.length > 0
      ? `品項：${items.map(i =>
          `${i.product_code} ${i.product_name} 數量${i.quantity}${i.unit} 單價${i.unit_price}`
        ).join('；')}`
      : '',
  ];
  return parts.filter(Boolean).join('\n');
}

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ══════════════════════════════════════════════════════
  // 工具函數
  // ══════════════════════════════════════════════════════

  async function generateOrderNo(client, orderDate) {
    const d  = new Date(orderDate);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const prefix = `R${yy}${mm}`;
    const result = await client.query(`
      SELECT order_no FROM ${schemaName}.purchase_requests
      WHERE order_no LIKE $1
      ORDER BY order_no DESC LIMIT 1
    `, [`${prefix}%`]);
    const seq = result.rows.length > 0
      ? parseInt(result.rows[0].order_no.slice(5)) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  async function nextUid(client, orderNo) {
    const r = await client.query(
      `SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid
       FROM ${schemaName}.purchase_request_items WHERE order_no = $1`,
      [orderNo]
    );
    return r.rows[0].next_uid;
  }

  async function getActivePurchasePriceVersion(client, orderDate) {
    const r = await client.query(`
      SELECT version_code
      FROM ${schemaName}.purchase_price_versions
      WHERE start_date::date <= $1::date
        AND end_date::date   >= $1::date
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `, [orderDate]);
    return r.rows[0]?.version_code || null;
  }

  async function getPurchasePrice(client, priceVersion, productCode) {
    if (!priceVersion) return null;
    const r = await client.query(`
      SELECT price, unit
      FROM ${schemaName}.purchase_price_rows
      WHERE version_code = $1 AND product_code = $2
      LIMIT 1
    `, [priceVersion, productCode]);
    return r.rows[0] || null;
  }

  async function refreshTotalAmount(client, orderNo) {
    await client.query(`
      UPDATE ${schemaName}.purchase_requests
      SET total_amount = (
        SELECT COALESCE(SUM(amount), 0)
        FROM ${schemaName}.purchase_request_items
        WHERE order_no = $1
      ), updated_at = NOW()
      WHERE order_no = $1
    `, [orderNo]);
  }

  /**
   * ★ 新增：自動更新 embedding（在 COMMIT 之後呼叫，使用 pool 而非 client）
   * 採非阻塞方式，embedding 失敗不影響主流程
   */
  async function updateEmbeddingAsync(orderNo) {
    try {
      const prR = await pool.query(`
        SELECT pr.*, pr.order_date::text, pr.delivery_date::text
        FROM ${schemaName}.purchase_requests pr WHERE pr.order_no = $1
      `, [orderNo]);
      if (!prR.rows.length) return;

      const itemsR = await pool.query(`
        SELECT product_code, product_name, quantity, unit, unit_price
        FROM ${schemaName}.purchase_request_items WHERE order_no = $1 ORDER BY uid
      `, [orderNo]);

      const text      = buildEmbeddingText(prR.rows[0], itemsR.rows);
      const embedding = await getEmbedding(text);

      await pool.query(`
        UPDATE ${schemaName}.purchase_requests
        SET embedding = $1::vector, updated_at = NOW()
        WHERE order_no = $2
      `, [`[${embedding.join(',')}]`, orderNo]);

      console.log(`✅ embedding 更新成功：${orderNo}`);
    } catch (err) {
      console.error(`❌ embedding 更新失敗（${orderNo}）:`, err.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // 輔助 API
  // ══════════════════════════════════════════════════════

  router.get('/types',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const r = await pool.query(`
          SELECT type_id, type_name, sort_order
          FROM ${schemaName}.purchase_request_types
          WHERE status = 'active'
          ORDER BY sort_order ASC
        `);
        res.json({ status: 'Success', types: r.rows });
      } catch (err) {
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  router.get('/pricing',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const { order_date, product_code } = req.query;
        if (!order_date || !product_code) {
          return res.status(400).json({ status: 'Error', message: '缺少必要參數' });
        }
        const priceVer  = await getActivePurchasePriceVersion(client, order_date);
        const priceInfo = await getPurchasePrice(client, priceVer, product_code);

        res.json({
          status:        'Success',
          price_version: priceVer,
          unit_price:    parseFloat(priceInfo?.price) || 0,
          unit:          priceInfo?.unit || null,
        });
      } catch (err) {
        console.error('❌ 查詢採購定價失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  router.get('/vendors',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const { search = '' } = req.query;
        let where = `WHERE customer_type = 'supplier' AND status = 'active'`;
        const params = [];
        if (search) {
          params.push(`%${search}%`);
          where += ` AND (id ILIKE $1 OR description ILIKE $1)`;
        }
        const r = await pool.query(`
          SELECT id, description, tel, address, payment_method, payment_terms
          FROM ${schemaName}.customers
          ${where}
          ORDER BY id ASC
          LIMIT 50
        `, params);
        res.json({ status: 'Success', vendors: r.rows });
      } catch (err) {
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  router.get('/orders/:orderNo',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const { orderNo } = req.params;
        const orderR = await pool.query(
          `SELECT order_no, customer_name, order_date::text
           FROM ${schemaName}.orders WHERE order_no = $1`,
          [orderNo]
        );
        if (!orderR.rows.length) {
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        const itemsR = await pool.query(`
          SELECT uid, product_code, product_name, quantity, unit, delivery_date::text
          FROM ${schemaName}.order_items
          WHERE order_no = $1
          ORDER BY uid ASC
        `, [orderNo]);
        res.json({
          status: 'Success',
          order:  orderR.rows[0],
          items:  itemsR.rows
        });
      } catch (err) {
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // ★ 路由順序修正：/search 和 /embed-all 必須在 /:orderNo 之前宣告
  //   否則 Express 會把 "search"、"embed-all" 當作 orderNo 參數
  // ══════════════════════════════════════════════════════════

  // AI 搜尋
  // GET /api/purchase-requests/search?q=...&limit=10
  router.get('/search',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const { q = '', limit = 10, threshold = 0.3 } = req.query;

        if (!q.trim()) {
          return res.status(400).json({ status: 'Error', message: '請輸入搜尋關鍵字' });
        }

        const queryEmbedding = await getEmbedding(q);

        const result = await pool.query(`
          SELECT
            pr.order_no,
            pr.order_date::text,
            pr.delivery_date::text,
            pr.type_id,
            prt.type_name,
            pr.vendor_id,
            pr.vendor_name,
            pr.salesperson_id,
            pr.salesperson_name,
            pr.status,
            pr.total_amount,
            pr.remark,
            1 - (pr.embedding <=> $1::vector) AS similarity,
            (SELECT COUNT(*) FROM ${schemaName}.purchase_request_items i
             WHERE i.order_no = pr.order_no) AS item_count
          FROM ${schemaName}.purchase_requests pr
          LEFT JOIN ${schemaName}.purchase_request_types prt ON prt.type_id = pr.type_id
          WHERE pr.embedding IS NOT NULL
            AND 1 - (pr.embedding <=> $1::vector) > $2
          ORDER BY pr.embedding <=> $1::vector
          LIMIT $3
        `, [
          `[${queryEmbedding.join(',')}]`,
          parseFloat(threshold),
          parseInt(limit)
        ]);

        res.json({
          status:  'Success',
          query:   q,
          results: result.rows.map(r => ({
            ...r,
            similarity: Math.round(r.similarity * 100) / 100
          })),
          total: result.rows.length
        });
      } catch (err) {
        console.error('❌ AI 搜尋失敗:', err);
        res.status(500).json({
          status:  'Error',
          message: 'AI 搜尋失敗',
          error:   err.message
        });
      }
    }
  );

  // 批次重建所有請購單的 embedding
  // POST /api/purchase-requests/embed-all
  router.post('/embed-all',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      res.json({ status: 'Success', message: '批次 embedding 任務已啟動，請稍後查看日誌' });

      ;(async () => {
        try {
          const allR = await pool.query(`
            SELECT order_no FROM ${schemaName}.purchase_requests ORDER BY order_no
          `);
          console.log(`🔄 開始批次 embedding，共 ${allR.rows.length} 張請購單`);

          let success = 0, failed = 0;
          for (const row of allR.rows) {
            try {
              await updateEmbeddingAsync(row.order_no);
              success++;
              await new Promise(r => setTimeout(r, 200));
            } catch (e) {
              failed++;
              console.error(`❌ ${row.order_no} embedding 失敗:`, e.message);
            }
          }
          console.log(`✅ 批次 embedding 完成：成功 ${success}，失敗 ${failed}`);
        } catch (e) {
          console.error('❌ 批次 embedding 任務失敗:', e);
        }
      })();
    }
  );

  // ══════════════════════════════════════════════════════
  // 1. 查詢請購單清單
  // GET /api/purchase-requests
  // ══════════════════════════════════════════════════════
  router.get('/',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const {
          page = 1, limit = 20,
          search = '', status: statusFilter = '',
          date_from = '', date_to = ''
        } = req.query;
        const offset = (page - 1) * limit;
        const params = [];
        let where = 'WHERE 1=1';

        if (search) {
          params.push(`%${search}%`);
          where += ` AND (pr.order_no ILIKE $${params.length} OR pr.vendor_name ILIKE $${params.length})`;
        }
        if (statusFilter) {
          params.push(statusFilter);
          where += ` AND pr.status = $${params.length}`;
        }
        if (date_from) {
          params.push(date_from);
          where += ` AND pr.order_date >= $${params.length}::date`;
        }
        if (date_to) {
          params.push(date_to);
          where += ` AND pr.order_date <= $${params.length}::date`;
        }

        const countR = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.purchase_requests pr ${where}`, params
        );

        const dataR = await pool.query(`
          SELECT
            pr.order_no,
            pr.order_date::text,
            pr.delivery_date::text,
            pr.type_id,
            prt.type_name,
            pr.vendor_id, pr.vendor_name,
            pr.salesperson_id, pr.salesperson_name,
            pr.confirmed, pr.status,
            pr.total_amount, pr.remark,
            pr.created_at, pr.updated_at,
            (SELECT COUNT(*) FROM ${schemaName}.purchase_request_items i
             WHERE i.order_no = pr.order_no) AS item_count
          FROM ${schemaName}.purchase_requests pr
          LEFT JOIN ${schemaName}.purchase_request_types prt ON prt.type_id = pr.type_id
          ${where}
          ORDER BY pr.order_date DESC, pr.order_no DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          requests: dataR.rows,
          total: parseInt(countR.rows[0].count),
          page: parseInt(page),
          totalPages: Math.ceil(parseInt(countR.rows[0].count) / limit)
        });
      } catch (err) {
        console.error('❌ 查詢請購單清單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 2. 查詢單一請購單（含明細）
  // GET /api/purchase-requests/:orderNo
  // ══════════════════════════════════════════════════════
  router.get('/:orderNo',
    authenticateToken,
    requirePermission('purchase:request:read'),
    async (req, res) => {
      try {
        const { orderNo } = req.params;
        const orderR = await pool.query(`
          SELECT pr.*, pr.order_date::text, pr.delivery_date::text,
                 prt.type_name
          FROM ${schemaName}.purchase_requests pr
          LEFT JOIN ${schemaName}.purchase_request_types prt ON prt.type_id = pr.type_id
          WHERE pr.order_no = $1
        `, [orderNo]);

        if (!orderR.rows.length) {
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }

        const itemsR = await pool.query(`
          SELECT id, order_no, uid, product_code, product_name,
                 quantity, unit, unit_price, amount,
                 so_no, so_uid, remark, price_version,
                 created_at, updated_at
          FROM ${schemaName}.purchase_request_items
          WHERE order_no = $1 ORDER BY uid ASC
        `, [orderNo]);

        res.json({
          status:  'Success',
          request: orderR.rows[0],
          items:   itemsR.rows
        });
      } catch (err) {
        console.error('❌ 查詢請購單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 3. 新增請購單（表頭 + 明細一次完成）
  // POST /api/purchase-requests
  // ══════════════════════════════════════════════════════
  router.post('/',
    authenticateToken,
    requirePermission('purchase:request:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const {
          order_date, delivery_date, type_id, vendor_id,
          delivery_address, remark, items = []
        } = req.body;

        if (!order_date || !delivery_date || !type_id || !vendor_id) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請購日期、需求日期、請購類別、供應商為必填' });
        }
        if (new Date(delivery_date) < new Date(order_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '需求日期不可早於請購日期' });
        }
        if (!items.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請至少新增一筆明細' });
        }

        const vendorR = await client.query(`
          SELECT id, description, tel, address, payment_method, payment_terms, customer_type
          FROM ${schemaName}.customers WHERE id = $1
        `, [vendor_id]);
        if (!vendorR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '供應商不存在' });
        }
        const vendor = vendorR.rows[0];
        if (vendor.customer_type !== 'supplier') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '指定的客戶不是供應商（customer_type 須為 supplier）' });
        }

        const acctR = await client.query(
          `SELECT account, description FROM ${schemaName}.accounts WHERE account = $1`,
          [req.user.account]
        );
        const acct = acctR.rows[0];

        const priceVer = await getActivePurchasePriceVersion(client, order_date);
        const orderNo  = await generateOrderNo(client, order_date);

        await client.query(`
          INSERT INTO ${schemaName}.purchase_requests (
            order_no, order_date, delivery_date, type_id,
            vendor_id, vendor_name, delivery_address,
            vendor_tel, payment_method, payment_terms,
            salesperson_id, salesperson_name,
            confirmed, status, total_amount, remark,
            created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    false,'created',0,$13,$14,$14)
        `, [
          orderNo, order_date, delivery_date, type_id,
          vendor_id, vendor.description,
          delivery_address || vendor.address || '',
          vendor.tel || '',
          vendor.payment_method || '',
          vendor.payment_terms  || '',
          req.user.account,
          acct?.description || req.user.account,
          remark || null,
          req.user.account
        ]);

        let uid = 1;
        for (const item of items) {
          if (!item.product_code || !item.quantity) continue;

          const prodR = await client.query(
            `SELECT product_code, product_name, unit FROM ${schemaName}.products WHERE product_code = $1`,
            [item.product_code]
          );
          const prod = prodR.rows[0];
          if (!prod) continue;

          let unitPrice = parseFloat(item.unit_price) || 0;
          let usedPriceVer = item.price_version || priceVer;
          if (!unitPrice && priceVer) {
            const pi = await getPurchasePrice(client, priceVer, item.product_code);
            unitPrice    = parseFloat(pi?.price) || 0;
            usedPriceVer = priceVer;
          }
          const qty    = parseFloat(item.quantity) || 0;
          const amount = unitPrice * qty;

          await client.query(`
            INSERT INTO ${schemaName}.purchase_request_items (
              order_no, uid, product_code, product_name, quantity, unit,
              unit_price, amount, so_no, so_uid, remark, price_version,
              created_by, updated_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
          `, [
            orderNo, uid++, prod.product_code, prod.product_name,
            qty, item.unit || prod.unit,
            unitPrice, amount,
            item.so_no || null, item.so_uid || null,
            item.remark || null, usedPriceVer,
            req.user.account
          ]);
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

        // ★ COMMIT 後非同步更新 embedding（不阻塞回應）
        updateEmbeddingAsync(orderNo);

        const finalR = await pool.query(`
          SELECT pr.*, pr.order_date::text, pr.delivery_date::text, prt.type_name
          FROM ${schemaName}.purchase_requests pr
          LEFT JOIN ${schemaName}.purchase_request_types prt ON prt.type_id = pr.type_id
          WHERE pr.order_no = $1
        `, [orderNo]);
        const finalItems = await pool.query(
          `SELECT * FROM ${schemaName}.purchase_request_items WHERE order_no = $1 ORDER BY uid`,
          [orderNo]
        );

        res.status(201).json({
          status:  'Success',
          message: `請購單 ${orderNo} 建立成功`,
          request: finalR.rows[0],
          items:   finalItems.rows
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 建立請購單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 4. 修改請購單表頭
  // PUT /api/purchase-requests/:orderNo
  // ══════════════════════════════════════════════════════
  router.put('/:orderNo',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        const chk = await client.query(
          `SELECT status FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]
        );
        if (!chk.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (chk.rows[0].status !== 'created') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認或核准的請購單不可修改' });
        }

        const { order_date, delivery_date, type_id, delivery_address, remark } = req.body;

        if (new Date(delivery_date) < new Date(order_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '需求日期不可早於請購日期' });
        }

        await client.query(`
          UPDATE ${schemaName}.purchase_requests SET
            order_date       = $1,
            delivery_date    = $2,
            type_id          = $3,
            delivery_address = $4,
            remark           = $5,
            updated_by       = $6,
            updated_at       = NOW()
          WHERE order_no = $7
        `, [order_date, delivery_date, type_id, delivery_address, remark || null, req.user.account, orderNo]);

        await client.query('COMMIT');

        // ★ COMMIT 後非同步更新 embedding
        updateEmbeddingAsync(orderNo);

        const r = await pool.query(`
          SELECT pr.*, pr.order_date::text, pr.delivery_date::text, prt.type_name
          FROM ${schemaName}.purchase_requests pr
          LEFT JOIN ${schemaName}.purchase_request_types prt ON prt.type_id = pr.type_id
          WHERE pr.order_no = $1
        `, [orderNo]);

        res.json({ status: 'Success', message: '請購單更新成功', request: r.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 更新請購單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 5. 確認 / 取消確認
  // PATCH /api/purchase-requests/:orderNo/confirm
  // ══════════════════════════════════════════════════════
  router.patch('/:orderNo/confirm',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;
        const { confirmed } = req.body;

        const chk = await client.query(
          `SELECT status FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]
        );
        if (!chk.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (chk.rows[0].status === 'approved') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已核准的請購單不可變更確認狀態' });
        }

        if (confirmed) {
          const cntR = await client.query(
            `SELECT COUNT(*) FROM ${schemaName}.purchase_request_items WHERE order_no = $1`, [orderNo]
          );
          if (parseInt(cntR.rows[0].count) === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ status: 'Error', message: '請購單沒有明細，無法確認' });
          }
        }

        const newStatus = confirmed ? 'confirmed' : 'created';
        await client.query(`
          UPDATE ${schemaName}.purchase_requests SET
            confirmed  = $1,
            status     = $2,
            updated_by = $3,
            updated_at = NOW()
          WHERE order_no = $4
        `, [confirmed, newStatus, req.user.account, orderNo]);

        await client.query('COMMIT');

        // ★ 確認狀態改變，同步更新 embedding（狀態文字會影響向量）
        updateEmbeddingAsync(orderNo);

        res.json({
          status:       'Success',
          message:      confirmed ? '請購單已確認' : '請購單已取消確認',
          confirmed,
          order_status: newStatus
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 確認請購單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 6. 刪除請購單
  // DELETE /api/purchase-requests/:orderNo
  // ══════════════════════════════════════════════════════
  router.delete('/:orderNo',
    authenticateToken,
    requirePermission('purchase:request:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        const chk = await client.query(
          `SELECT status FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]
        );
        if (!chk.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (chk.rows[0].status !== 'created') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '只有「建立」狀態的請購單可以刪除' });
        }

        await client.query(`DELETE FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]);
        await client.query('COMMIT');

        res.json({ status: 'Success', message: `請購單 ${orderNo} 已刪除` });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除請購單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 7. 新增明細（單筆）
  // POST /api/purchase-requests/:orderNo/items
  // ══════════════════════════════════════════════════════
  router.post('/:orderNo/items',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        const prR = await client.query(
          `SELECT order_date::text, status FROM ${schemaName}.purchase_requests WHERE order_no = $1`,
          [orderNo]
        );
        if (!prR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (prR.rows[0].status !== 'created') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '只有「建立」狀態的請購單可以新增明細' });
        }
        const orderDate = prR.rows[0].order_date;

        const { product_code, quantity, unit_price, so_no, so_uid, remark } = req.body;
        if (!product_code || !quantity) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '貨號與數量為必填' });
        }

        const prodR = await client.query(
          `SELECT product_code, product_name, unit FROM ${schemaName}.products WHERE product_code = $1`,
          [product_code]
        );
        if (!prodR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '貨號不存在' });
        }
        const prod = prodR.rows[0];

        const priceVer = await getActivePurchasePriceVersion(client, orderDate);
        let up = parseFloat(unit_price) || 0;
        let pv = priceVer;
        if (!up && priceVer) {
          const pi = await getPurchasePrice(client, priceVer, product_code);
          up = parseFloat(pi?.price) || 0;
          pv = priceVer;
        }

        const qty    = parseFloat(quantity) || 0;
        const amount = up * qty;
        const uid    = await nextUid(client, orderNo);

        const insertR = await client.query(`
          INSERT INTO ${schemaName}.purchase_request_items (
            order_no, uid, product_code, product_name, quantity, unit,
            unit_price, amount, so_no, so_uid, remark, price_version,
            created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
          RETURNING *
        `, [
          orderNo, uid, prod.product_code, prod.product_name,
          qty, prod.unit, up, amount,
          so_no || null, so_uid || null, remark || null, pv,
          req.user.account
        ]);

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

        // ★ 明細變動後更新 embedding
        updateEmbeddingAsync(orderNo);

        res.status(201).json({
          status: 'Success',
          message: '明細新增成功',
          item: insertR.rows[0]
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 新增明細失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 8. 修改明細
  // PUT /api/purchase-requests/:orderNo/items/:uid
  // ══════════════════════════════════════════════════════
  router.put('/:orderNo/items/:uid',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo, uid } = req.params;

        const prR = await client.query(
          `SELECT status FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]
        );
        if (!prR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (prR.rows[0].status !== 'created') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '只有「建立」狀態可修改明細' });
        }

        const { quantity, unit_price, remark } = req.body;
        const qty    = parseFloat(quantity) || 0;
        const up     = parseFloat(unit_price) || 0;
        const amount = qty * up;

        const updR = await client.query(`
          UPDATE ${schemaName}.purchase_request_items SET
            quantity   = $1,
            unit_price = $2,
            amount     = $3,
            remark     = $4,
            updated_by = $5,
            updated_at = NOW()
          WHERE order_no = $6 AND uid = $7
          RETURNING *
        `, [qty, up, amount, remark || null, req.user.account, orderNo, uid]);

        if (!updR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '明細不存在' });
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

        // ★ 明細變動後更新 embedding
        updateEmbeddingAsync(orderNo);

        res.json({ status: 'Success', message: '明細更新成功', item: updR.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 更新明細失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════
  // 9. 刪除明細
  // DELETE /api/purchase-requests/:orderNo/items/:uid
  // ══════════════════════════════════════════════════════
  router.delete('/:orderNo/items/:uid',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo, uid } = req.params;

        const prR = await client.query(
          `SELECT status FROM ${schemaName}.purchase_requests WHERE order_no = $1`, [orderNo]
        );
        if (!prR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }
        if (prR.rows[0].status !== 'created') {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '只有「建立」狀態可刪除明細' });
        }

        const delR = await client.query(
          `DELETE FROM ${schemaName}.purchase_request_items WHERE order_no = $1 AND uid = $2 RETURNING uid`,
          [orderNo, uid]
        );
        if (!delR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '明細不存在' });
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

        // ★ 明細刪除後更新 embedding
        updateEmbeddingAsync(orderNo);

        res.json({ status: 'Success', message: `明細 uid=${uid} 已刪除` });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除明細失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 更新單筆請購單的 embedding
  // POST /api/purchase-requests/:orderNo/embed
  // ══════════════════════════════════════════════════════════
  router.post('/:orderNo/embed',
    authenticateToken,
    requirePermission('purchase:request:update'),
    async (req, res) => {
      try {
        const { orderNo } = req.params;

        const prR = await pool.query(`
          SELECT pr.*, pr.order_date::text, pr.delivery_date::text
          FROM ${schemaName}.purchase_requests pr WHERE pr.order_no = $1
        `, [orderNo]);
        if (!prR.rows.length) {
          return res.status(404).json({ status: 'Error', message: '請購單不存在' });
        }

        const itemsR = await pool.query(`
          SELECT product_code, product_name, quantity, unit, unit_price
          FROM ${schemaName}.purchase_request_items WHERE order_no = $1 ORDER BY uid
        `, [orderNo]);

        const text      = buildEmbeddingText(prR.rows[0], itemsR.rows);
        const embedding = await getEmbedding(text);

        await pool.query(`
          UPDATE ${schemaName}.purchase_requests
          SET embedding = $1::vector, updated_at = NOW()
          WHERE order_no = $2
        `, [`[${embedding.join(',')}]`, orderNo]);

        res.json({
          status:    'Success',
          message:   `請購單 ${orderNo} embedding 更新成功`,
          text_used: text
        });
      } catch (err) {
        console.error('❌ 更新 embedding 失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  return router;
};