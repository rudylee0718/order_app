// routes/erp-orders.js
// 掛載：app.use('/api/erp-orders', require('./routes/erp-orders')(pool, schemaName))

const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ══════════════════════════════════════════════════════════
  // 工具函數
  // ══════════════════════════════════════════════════════════

  /** 產生訂單號碼 S+YY+MM+5碼流水號，依訂單日期的年月 */
  async function generateOrderNo(client, orderDate) {
    const d  = new Date(orderDate);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const prefix = `S${yy}${mm}`;
    const result = await client.query(`
      SELECT order_no FROM ${schemaName}.orders
      WHERE order_no LIKE $1
      ORDER BY order_no DESC LIMIT 1
    `, [`${prefix}%`]);
    const seq = result.rows.length > 0
      ? parseInt(result.rows[0].order_no.slice(5)) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  /** 取下一個可用 uid（只增不減：max(uid)+1）*/
  async function nextUid(client, orderNo) {
    const r = await client.query(
      `SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid
       FROM ${schemaName}.order_items WHERE order_no = $1`,
      [orderNo]
    );
    return r.rows[0].next_uid;
  }

  /**
   * 根據訂單日期找有效的牌價版本，回傳 {version_code} | null
   * 規則：日期在區間內 → start_date 最新 → version_code 最新
   */
  async function getActiveSalesPriceVersion(client, orderDate) {
    const r = await client.query(`
      SELECT version_code
      FROM ${schemaName}.sales_price_versions
      WHERE start_date::date <= $1::date
        AND end_date::date   >= $1::date
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `, [orderDate]);
    return r.rows[0]?.version_code || null;
  }

  /**
   * 根據訂單日期 + 客戶 ID 找有效的客戶等級版本，回傳 {version_code} | null
   */
  async function getActiveCustomerLevelVersion(client, orderDate, customerId) {
    const r = await client.query(`
      SELECT version_code
      FROM ${schemaName}.customer_level_versions
      WHERE cust_id = $1
        AND start_date::date <= $2::date
        AND end_date::date   >= $2::date
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `, [customerId, orderDate]);
    return r.rows[0]?.version_code || null;
  }

  /**
   * 查詢指定版本 + 貨號的牌價
   */
  async function getSalesPrice(client, priceVersion, productCode) {
    if (!priceVersion) return null;
    const r = await client.query(`
      SELECT price, unit
      FROM ${schemaName}.sales_price_rows
      WHERE version_code = $1 AND product_code = $2
      LIMIT 1
    `, [priceVersion, productCode]);
    return r.rows[0] || null;
  }

  /**
   * 查詢指定版本 + class_code 的客戶等級折扣
   * 需要先透過 products.class_code 找到 class_code
   */
  async function getCustomerDiscount(client, levelVersion, productCode) {
    if (!levelVersion) return null;
    // 透過 products.class_code 找到對應的 customer_level_rows
    const r = await client.query(`
      SELECT clr.discount, clr.pmcode, clr.grade, clr.class_code
      FROM ${schemaName}.products p
      JOIN ${schemaName}.customer_level_rows clr
        ON clr.version_code = $1 AND clr.class_code = p.class_code
      WHERE p.product_code = $2
      LIMIT 1
    `, [levelVersion, productCode]);
    return r.rows[0] || null;
  }

  /**
   * 計算單價：
   * pmcode = 'M' → 單價 = 牌價 × 折扣
   * pmcode = 'P' → 單價 = 牌價 + 折扣
   */
  function calcUnitPrice(listPrice, discount, pmcode) {
    const lp = parseFloat(listPrice) || 0;
    const dc = parseFloat(discount) || 0;
    if (pmcode === 'P') return lp + dc;
    return lp * dc; // 預設 M
  }

  /** 更新訂單總金額 */
  async function refreshTotalAmount(client, orderNo) {
    await client.query(`
      UPDATE ${schemaName}.orders
      SET total_amount = (
        SELECT COALESCE(SUM(amount), 0)
        FROM ${schemaName}.order_items
        WHERE order_no = $1
      ),
      updated_at = NOW()
      WHERE order_no = $1
    `, [orderNo]);
  }

  // ══════════════════════════════════════════════════════════
  // 輔助 API：查單別、取訂單報價資訊
  // ══════════════════════════════════════════════════════════

  /** GET /api/erp-orders/types — 查所有單別 */
  router.get('/types',
    authenticateToken,
    requirePermission('sales:order:read'),
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT type_id, type_name, description, sort_order
           FROM ${schemaName}.order_types
           WHERE status = 'active'
           ORDER BY sort_order ASC`
        );
        res.json({ status: 'Success', types: r.rows });
      } catch (err) {
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  /**
   * GET /api/erp-orders/pricing?order_date=&customer_id=&product_code=
   * 回傳：牌價、折扣、pmcode、單價（前端新增/修改明細時呼叫）
   */
  router.get('/pricing',
    authenticateToken,
    requirePermission('sales:order:read'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const { order_date, customer_id, product_code } = req.query;
        if (!order_date || !customer_id || !product_code) {
          return res.status(400).json({ status: 'Error', message: '缺少必要參數' });
        }

        const priceVer  = await getActiveSalesPriceVersion(client, order_date);
        const levelVer  = await getActiveCustomerLevelVersion(client, order_date, customer_id);
        const priceInfo = await getSalesPrice(client, priceVer, product_code);
        const discInfo  = await getCustomerDiscount(client, levelVer, product_code);

        const listPrice  = parseFloat(priceInfo?.price) || 0;
        const discount   = parseFloat(discInfo?.discount) || 1;
        const pmcode     = discInfo?.pmcode || 'M';
        const unitPrice  = calcUnitPrice(listPrice, discount, pmcode);

        res.json({
          status: 'Success',
          price_version:  priceVer,
          level_version:  levelVer,
          list_price:     listPrice,
          discount,
          pmcode,
          unit_price:     unitPrice,
          unit:           priceInfo?.unit || null,
        });
      } catch (err) {
        console.error('❌ 查詢定價失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 1. 查詢訂單清單
  // GET /api/erp-orders?page=&limit=&search=&status=&customer_id=&date_from=&date_to=
  // ══════════════════════════════════════════════════════════
  router.get('/',
    authenticateToken,
    requirePermission('sales:order:read'),
    async (req, res) => {
      try {
        const {
          page = 1, limit = 20,
          search = '', status: statusFilter = '',
          customer_id = '', date_from = '', date_to = ''
        } = req.query;
        const offset = (page - 1) * limit;
        const params = [];
        let where = 'WHERE 1=1';

        if (search) {
          params.push(`%${search}%`);
          where += ` AND (o.order_no ILIKE $${params.length} OR o.customer_name ILIKE $${params.length})`;
        }
        if (statusFilter) {
          params.push(statusFilter);
          where += ` AND o.status = $${params.length}`;
        }
        if (customer_id) {
          params.push(customer_id);
          where += ` AND o.customer_id = $${params.length}`;
        }
        if (date_from) {
          params.push(date_from);
          where += ` AND o.order_date >= $${params.length}::date`;
        }
        if (date_to) {
          params.push(date_to);
          where += ` AND o.order_date <= $${params.length}::date`;
        }

        const countR = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.orders o ${where}`, params
        );

        const dataR = await pool.query(`
          SELECT
            o.order_no, o.order_date::text, o.delivery_date::text,
            o.type_id, ot.type_name,
            o.customer_id, o.customer_name,
            o.salesperson_id, o.salesperson_name,
            o.confirmed, o.status,
            o.total_amount, o.remark,
            o.created_at, o.updated_at,
            (SELECT COUNT(*) FROM ${schemaName}.order_items i WHERE i.order_no = o.order_no) AS item_count
          FROM ${schemaName}.orders o
          LEFT JOIN ${schemaName}.order_types ot ON ot.type_id = o.type_id
          ${where}
          ORDER BY o.order_date DESC, o.order_no DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          orders: dataR.rows,
          total: parseInt(countR.rows[0].count),
          page: parseInt(page),
          totalPages: Math.ceil(parseInt(countR.rows[0].count) / limit)
        });
      } catch (err) {
        console.error('❌ 查詢訂單清單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 2. 查詢單一訂單（含明細）
  // GET /api/erp-orders/:orderNo
  // ══════════════════════════════════════════════════════════
  router.get('/:orderNo',
    authenticateToken,
    requirePermission('sales:order:read'),
    async (req, res) => {
      try {
        const { orderNo } = req.params;

        const orderR = await pool.query(`
          SELECT
            o.*,
            o.order_date::text   AS order_date,
            o.delivery_date::text AS delivery_date,
            ot.type_name
          FROM ${schemaName}.orders o
          LEFT JOIN ${schemaName}.order_types ot ON ot.type_id = o.type_id
          WHERE o.order_no = $1
        `, [orderNo]);

        if (orderR.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }

        const itemsR = await pool.query(`
          SELECT
            id, order_no, uid,
            product_code, product_name, quantity, unit,
            list_price, discount, pmcode, unit_price, amount,
            delivery_date::text AS delivery_date,
            price_version, level_version, remark,
            created_at, updated_at
          FROM ${schemaName}.order_items
          WHERE order_no = $1
          ORDER BY uid ASC
        `, [orderNo]);

        res.json({
          status: 'Success',
          order: orderR.rows[0],
          items: itemsR.rows
        });
      } catch (err) {
        console.error('❌ 查詢訂單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 3. 新增訂單（含明細）
  // POST /api/erp-orders
  // Body: { order_date, delivery_date, type_id, customer_id,
  //         delivery_address, customer_tel, payment_method, payment_terms,
  //         remark, items: [{product_code, quantity, delivery_date, remark?}] }
  // ══════════════════════════════════════════════════════════
  router.post('/',
    authenticateToken,
    requirePermission('sales:order:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const {
          order_date, delivery_date, type_id, customer_id,
          delivery_address, customer_tel,
          payment_method, payment_terms,
          remark, items = []
        } = req.body;

        // ── 基本驗證 ──
        if (!order_date || !delivery_date || !type_id || !customer_id) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '訂單日期、交貨日期、單別、客戶為必填' });
        }
        if (new Date(delivery_date) < new Date(order_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '交貨日期不可早於訂單日期' });
        }
        if (items.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請至少新增一筆明細' });
        }

        // ── 取客戶資料 ──
        const custR = await client.query(
          `SELECT id, description, tel, address, payment_method, payment_terms
           FROM ${schemaName}.customers WHERE id = $1`, [customer_id]
        );
        if (custR.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '客戶不存在' });
        }
        const cust = custR.rows[0];

        // ── 取業務員資料（登入者）──
        const acctR = await client.query(
          `SELECT account, description FROM ${schemaName}.accounts WHERE account = $1`,
          [req.user.account]
        );
        const salesperson = acctR.rows[0];

        // ── 查定價版本 ──
        const priceVer = await getActiveSalesPriceVersion(client, order_date);
        const levelVer = await getActiveCustomerLevelVersion(client, order_date, customer_id);

        // ── 產生訂單號碼 ──
        const orderNo = await generateOrderNo(client, order_date);

        // ── 插入表頭 ──
        await client.query(`
          INSERT INTO ${schemaName}.orders (
            order_no, order_date, delivery_date, type_id,
            customer_id, customer_name, delivery_address, customer_tel,
            payment_method, payment_terms,
            salesperson_id, salesperson_name,
            confirmed, status, total_amount, remark,
            created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    false,'draft',0,$13,$14,$14)
        `, [
          orderNo, order_date, delivery_date, type_id,
          customer_id,
          cust.description,
          delivery_address || cust.address || '',
          customer_tel     || cust.tel      || '',
          payment_method   || cust.payment_method || '',
          payment_terms    || cust.payment_terms  || '',
          req.user.account,
          salesperson?.description || req.user.account,
          remark || null,
          req.user.account
        ]);

        // ── 插入明細 ──
        let uid = 1;
        for (const item of items) {
          if (!item.product_code || !item.quantity) continue;

          const prodR = await client.query(
            `SELECT product_code, product_name, unit FROM ${schemaName}.products
             WHERE product_code = $1`, [item.product_code]
          );
          const prod = prodR.rows[0];
          if (!prod) continue;

          const priceInfo = await getSalesPrice(client, priceVer, item.product_code);
          const discInfo  = await getCustomerDiscount(client, levelVer, item.product_code);

          const listPrice = parseFloat(priceInfo?.price) || 0;
          const discount  = parseFloat(discInfo?.discount) || 1;
          const pmcode    = discInfo?.pmcode || 'M';
          const unitPrice = calcUnitPrice(listPrice, discount, pmcode);
          const amount    = unitPrice * parseFloat(item.quantity);
          const itemDate  = item.delivery_date || delivery_date;

          await client.query(`
            INSERT INTO ${schemaName}.order_items (
              order_no, uid, product_code, product_name, quantity, unit,
              list_price, discount, pmcode, unit_price, amount,
              delivery_date, price_version, level_version, remark,
              created_by, updated_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
          `, [
            orderNo, uid++, prod.product_code, prod.product_name,
            item.quantity, item.unit || prod.unit,
            listPrice, discount, pmcode, unitPrice, amount,
            itemDate, priceVer, levelVer, item.remark || null,
            req.user.account
          ]);
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

        // 回傳完整訂單
        const finalR = await pool.query(
          `SELECT o.*, o.order_date::text, o.delivery_date::text, ot.type_name
           FROM ${schemaName}.orders o
           LEFT JOIN ${schemaName}.order_types ot ON ot.type_id = o.type_id
           WHERE o.order_no = $1`, [orderNo]
        );
        const finalItems = await pool.query(
          `SELECT *, delivery_date::text AS delivery_date
           FROM ${schemaName}.order_items WHERE order_no = $1 ORDER BY uid`, [orderNo]
        );

        res.status(201).json({
          status: 'Success',
          message: `訂單 ${orderNo} 建立成功`,
          order: finalR.rows[0],
          items: finalItems.rows
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 建立訂單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 4. 修改訂單表頭（不含明細）
  // PUT /api/erp-orders/:orderNo
  // ══════════════════════════════════════════════════════════
  router.put('/:orderNo',
    authenticateToken,
    requirePermission('sales:order:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        // 已確認訂單不可修改
        const chk = await client.query(
          `SELECT confirmed FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (chk.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        if (chk.rows[0].confirmed) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認的訂單不可修改，請先取消確認' });
        }

        const {
          order_date, delivery_date, type_id,
          delivery_address, customer_tel,
          payment_method, payment_terms, remark
        } = req.body;

        if (new Date(delivery_date) < new Date(order_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '交貨日期不可早於訂單日期' });
        }

        await client.query(`
          UPDATE ${schemaName}.orders SET
            order_date       = $1,
            delivery_date    = $2,
            type_id          = $3,
            delivery_address = $4,
            customer_tel     = $5,
            payment_method   = $6,
            payment_terms    = $7,
            remark           = $8,
            updated_by       = $9,
            updated_at       = NOW()
          WHERE order_no = $10
        `, [order_date, delivery_date, type_id,
            delivery_address, customer_tel,
            payment_method, payment_terms, remark || null,
            req.user.account, orderNo]);

        await client.query('COMMIT');

        const r = await pool.query(
          `SELECT o.*, o.order_date::text, o.delivery_date::text, ot.type_name
           FROM ${schemaName}.orders o
           LEFT JOIN ${schemaName}.order_types ot ON ot.type_id = o.type_id
           WHERE o.order_no = $1`, [orderNo]
        );
        res.json({ status: 'Success', message: '訂單更新成功', order: r.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 更新訂單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 5. 訂單確認 / 取消確認
  // PATCH /api/erp-orders/:orderNo/confirm  { confirmed: true/false }
  // ══════════════════════════════════════════════════════════
  router.patch('/:orderNo/confirm',
    authenticateToken,
    requirePermission('sales:order:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;
        const { confirmed } = req.body; // boolean

        const chk = await client.query(
          `SELECT order_no FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (chk.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }

        await client.query(`
          UPDATE ${schemaName}.orders SET
            confirmed  = $1,
            status     = $2,
            updated_by = $3,
            updated_at = NOW()
          WHERE order_no = $4
        `, [confirmed, confirmed ? 'confirmed' : 'draft', req.user.account, orderNo]);

        await client.query('COMMIT');
        res.json({
          status: 'Success',
          message: confirmed ? '訂單已確認（下單）' : '訂單已取消確認（回草稿）',
          confirmed,
          order_status: confirmed ? 'confirmed' : 'draft'
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 訂單確認失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 6. 刪除訂單
  // DELETE /api/erp-orders/:orderNo
  // ══════════════════════════════════════════════════════════
  router.delete('/:orderNo',
    authenticateToken,
    requirePermission('sales:order:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        const chk = await client.query(
          `SELECT confirmed FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (chk.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        if (chk.rows[0].confirmed) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認訂單不可刪除，請先取消確認' });
        }

        // order_items 因 ON DELETE CASCADE 會自動刪除
        await client.query(`DELETE FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]);
        await client.query('COMMIT');

        res.json({ status: 'Success', message: `訂單 ${orderNo} 已刪除` });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除訂單失敗:', err);
        res.status(500).json({ status: 'Error', message: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // 7. 新增訂單明細
  // POST /api/erp-orders/:orderNo/items
  // ══════════════════════════════════════════════════════════
  router.post('/:orderNo/items',
    authenticateToken,
    requirePermission('sales:order:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo } = req.params;

        const orderR = await client.query(
          `SELECT order_date::text, delivery_date::text, customer_id, confirmed
           FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (orderR.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        const order = orderR.rows[0];
        if (order.confirmed) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認訂單不可新增明細' });
        }

        const { product_code, quantity, delivery_date, unit: inputUnit, remark } = req.body;
        if (!product_code || !quantity) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '貨號與數量為必填' });
        }
        const itemDate = delivery_date || order.delivery_date;
        if (new Date(itemDate) < new Date(order.order_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '明細交貨日期不可早於訂單日期' });
        }

        const prodR = await client.query(
          `SELECT product_code, product_name, unit FROM ${schemaName}.products
           WHERE product_code = $1`, [product_code]
        );
        if (prodR.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '貨號不存在' });
        }
        const prod = prodR.rows[0];

        const priceVer  = await getActiveSalesPriceVersion(client, order.order_date);
        const levelVer  = await getActiveCustomerLevelVersion(client, order.order_date, order.customer_id);
        const priceInfo = await getSalesPrice(client, priceVer, product_code);
        const discInfo  = await getCustomerDiscount(client, levelVer, product_code);

        const listPrice = parseFloat(priceInfo?.price) || 0;
        const discount  = parseFloat(discInfo?.discount) || 1;
        const pmcode    = discInfo?.pmcode || 'M';
        const unitPrice = calcUnitPrice(listPrice, discount, pmcode);
        const amount    = unitPrice * parseFloat(quantity);
        const uid       = await nextUid(client, orderNo);

        const insertR = await client.query(`
          INSERT INTO ${schemaName}.order_items (
            order_no, uid, product_code, product_name, quantity, unit,
            list_price, discount, pmcode, unit_price, amount,
            delivery_date, price_version, level_version, remark,
            created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
          RETURNING *, delivery_date::text AS delivery_date
        `, [
          orderNo, uid, prod.product_code, prod.product_name,
          quantity, inputUnit || prod.unit,
          listPrice, discount, pmcode, unitPrice, amount,
          itemDate, priceVer, levelVer, remark || null,
          req.user.account
        ]);

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

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

  // ══════════════════════════════════════════════════════════
  // 8. 修改訂單明細
  // PUT /api/erp-orders/:orderNo/items/:uid
  // ══════════════════════════════════════════════════════════
  router.put('/:orderNo/items/:uid',
    authenticateToken,
    requirePermission('sales:order:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo, uid } = req.params;

        const orderR = await client.query(
          `SELECT order_date::text, confirmed FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (!orderR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        if (orderR.rows[0].confirmed) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認訂單不可修改明細' });
        }
        const orderDate = orderR.rows[0].order_date;

        const { quantity, unit_price, list_price, discount, pmcode, delivery_date, remark } = req.body;
        const newUnitPrice = parseFloat(unit_price) || 0;
        const newAmount    = newUnitPrice * parseFloat(quantity);
        const itemDate     = delivery_date || orderDate;

        if (new Date(itemDate) < new Date(orderDate)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '明細交貨日期不可早於訂單日期' });
        }

        const updR = await client.query(`
          UPDATE ${schemaName}.order_items SET
            quantity      = $1,
            list_price    = $2,
            discount      = $3,
            pmcode        = $4,
            unit_price    = $5,
            amount        = $6,
            delivery_date = $7,
            remark        = $8,
            updated_by    = $9,
            updated_at    = NOW()
          WHERE order_no = $10 AND uid = $11
          RETURNING *, delivery_date::text AS delivery_date
        `, [quantity, list_price, discount, pmcode,
            newUnitPrice, newAmount, itemDate,
            remark || null, req.user.account, orderNo, uid]);

        if (!updR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '明細不存在' });
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

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

  // ══════════════════════════════════════════════════════════
  // 9. 刪除訂單明細
  // DELETE /api/erp-orders/:orderNo/items/:uid
  // ══════════════════════════════════════════════════════════
  router.delete('/:orderNo/items/:uid',
    authenticateToken,
    requirePermission('sales:order:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { orderNo, uid } = req.params;

        const orderR = await client.query(
          `SELECT confirmed FROM ${schemaName}.orders WHERE order_no = $1`, [orderNo]
        );
        if (!orderR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '訂單不存在' });
        }
        if (orderR.rows[0].confirmed) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '已確認訂單不可刪除明細' });
        }

        const delR = await client.query(
          `DELETE FROM ${schemaName}.order_items WHERE order_no = $1 AND uid = $2 RETURNING uid`,
          [orderNo, uid]
        );
        if (!delR.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '明細不存在' });
        }

        await refreshTotalAmount(client, orderNo);
        await client.query('COMMIT');

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

  return router;
};