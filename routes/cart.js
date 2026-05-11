// routes/cart.js
// 請在 index.js 加入：
//   const cartRouter = require('./routes/cart')(pool, schemaName);
//   app.use('/api/cart', cartRouter);

const express = require('express');
const router = express.Router();

module.exports = (pool, schemaName) => {

  // ==================== 取得帳號輔助函式 ====================
  function getAccount(req) {
    if (req.user && req.user.account) return req.user.account;
    return req.headers['x-account'] || null;
  }

  // ==================== 取得適用價格版本 ====================
  // 規則：購物車日期符合多個版本時，取 start_date 最新的；
  //       start_date 相同時，取 version_code 最大的
  async function getApplicableVersion(checkDate) {
    const query = `
      SELECT version_code, start_date, end_date
      FROM ${schemaName}.sales_price_versions
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1;
    `;
    const result = await pool.query(query, [checkDate]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  // ==================== GET /api/cart ====================
  // 取得購物車（含商品資訊 + 適用價格）
  router.get('/', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    try {
      const today = new Date().toISOString().split('T')[0];
      const version = await getApplicableVersion(today);

      let query, values;

      if (version) {
        query = `
          SELECT
            c.id,
            c.product_code,
            c.qty,
            c.account,
            c.created_at,
            c.updated_at,
            p.product_name,
            p.specification,
            p.unit,
            p.category,
            p.img,
            COALESCE(spr.price, 0)                        AS price,
            COALESCE(spr.discount, 1)                     AS discount,
            COALESCE(spr.price, 0)                        AS origin_price,
            COALESCE(spr.price * COALESCE(spr.discount,1), 0) AS discount_price,
            $2::text                                       AS version_code
          FROM ${schemaName}.cart_items c
          LEFT JOIN ${schemaName}.products p
            ON c.product_code = p.product_code
          LEFT JOIN ${schemaName}.sales_price_rows spr
            ON c.product_code = spr.product_code
            AND spr.version_code = $2
          WHERE c.account = $1
          ORDER BY c.created_at DESC;
        `;
        values = [account, version.version_code];
      } else {
        query = `
          SELECT
            c.id,
            c.product_code,
            c.qty,
            c.account,
            c.created_at,
            c.updated_at,
            p.product_name,
            p.specification,
            p.unit,
            p.category,
            p.img,
            0     AS price,
            1     AS discount,
            0     AS origin_price,
            0     AS discount_price,
            NULL  AS version_code
          FROM ${schemaName}.cart_items c
          LEFT JOIN ${schemaName}.products p
            ON c.product_code = p.product_code
          WHERE c.account = $1
          ORDER BY c.created_at DESC;
        `;
        values = [account];
      }

      const result = await pool.query(query, values);
      res.json({ status: 'Success', data: result.rows, version: version || null });
    } catch (err) {
      console.error('取得購物車失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== POST /api/cart ====================
  router.post('/', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const { product_code, qty } = req.body;
    if (!product_code || !qty || qty <= 0) {
      return res.status(400).json({ status: 'Error', message: '請提供商品代碼及數量' });
    }

    try {
      const productCheck = await pool.query(
        `SELECT product_code FROM ${schemaName}.products WHERE product_code = $1`,
        [product_code]
      );
      if (productCheck.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '找不到此商品' });
      }

      const checkResult = await pool.query(
        `SELECT id, qty FROM ${schemaName}.cart_items WHERE account = $1 AND product_code = $2`,
        [account, product_code]
      );

      if (checkResult.rows.length > 0) {
        const newQty = checkResult.rows[0].qty + qty;
        const updated = await pool.query(
          `UPDATE ${schemaName}.cart_items
           SET qty = $1, updated_at = NOW(), updated_by = $2
           WHERE id = $3 RETURNING *`,
          [newQty, account, checkResult.rows[0].id]
        );
        return res.json({ status: 'Success', message: '購物車已更新', data: updated.rows[0] });
      }

      const inserted = await pool.query(
        `INSERT INTO ${schemaName}.cart_items
           (product_code, qty, account, created_at, updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, NOW(), NOW(), $3, $3) RETURNING *`,
        [product_code, qty, account]
      );
      res.json({ status: 'Success', message: '已加入購物車', data: inserted.rows[0] });
    } catch (err) {
      console.error('加入購物車失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== PUT /api/cart/:id ====================
  router.put('/:id', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const { id } = req.params;
    const { qty } = req.body;
    if (!qty || qty <= 0) {
      return res.status(400).json({ status: 'Error', message: '數量必須大於 0' });
    }

    try {
      const result = await pool.query(
        `UPDATE ${schemaName}.cart_items
         SET qty = $1, updated_at = NOW(), updated_by = $2
         WHERE id = $3 AND account = $2 RETURNING *`,
        [qty, account, id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '找不到此購物車項目' });
      }
      res.json({ status: 'Success', message: '數量已更新', data: result.rows[0] });
    } catch (err) {
      console.error('更新購物車失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== DELETE /api/cart/batch ====================
  // 注意：batch 路由需在 /:id 之前定義
  router.delete('/batch', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 'Error', message: '請提供要刪除的 ID 列表' });
    }

    try {
      await pool.query(
        `DELETE FROM ${schemaName}.cart_items WHERE id = ANY($1::int[]) AND account = $2`,
        [ids, account]
      );
      res.json({ status: 'Success', message: '已批量刪除' });
    } catch (err) {
      console.error('批量刪除失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== DELETE /api/cart/:id ====================
  router.delete('/:id', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const { id } = req.params;
    try {
      const result = await pool.query(
        `DELETE FROM ${schemaName}.cart_items WHERE id = $1 AND account = $2 RETURNING *`,
        [id, account]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '找不到此購物車項目' });
      }
      res.json({ status: 'Success', message: '已從購物車移除' });
    } catch (err) {
      console.error('刪除購物車失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== GET /api/cart/count ====================
  router.get('/count', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.json({ status: 'Success', data: { count: 0 } });

    try {
      const result = await pool.query(
        `SELECT COUNT(*) AS count FROM ${schemaName}.cart_items WHERE account = $1`,
        [account]
      );
      res.json({ status: 'Success', data: { count: parseInt(result.rows[0].count) } });
    } catch (err) {
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== POST /api/cart/checkout ====================
  // 支援兩種模式：
  //   1. 購物車結帳：item_ids 有值 → 扣餘額 + 刪除購物車項目
  //   2. 直接購買：item_ids 為空陣列 → 只扣餘額，不刪購物車
  router.post('/checkout', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const { item_ids, total_amount } = req.body;

    // total_amount 必須有值且大於 0
    if (total_amount == null || total_amount <= 0) {
      return res.status(400).json({ status: 'Error', message: '請提供有效的結帳金額' });
    }

    // item_ids 允許為空陣列（直接購買場景），但必須是陣列型別
    if (item_ids !== undefined && !Array.isArray(item_ids)) {
      return res.status(400).json({ status: 'Error', message: 'item_ids 格式錯誤' });
    }

    const isDirectBuy = !item_ids || item_ids.length === 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 鎖定帳戶，確認餘額
      const balanceResult = await client.query(
        `SELECT balance FROM ${schemaName}.accounts WHERE account = $1 FOR UPDATE`,
        [account]
      );
      if (balanceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'Error', message: '找不到帳戶資料' });
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);
      if (currentBalance < total_amount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'Error', message: '帳戶餘額不足' });
      }

      // 扣除餘額
      await client.query(
        `UPDATE ${schemaName}.accounts
         SET balance = balance - $1, updated_at = NOW(), updated_by = $2
         WHERE account = $2`,
        [total_amount, account]
      );

      // 僅購物車結帳才刪除購物車項目
      if (!isDirectBuy) {
        await client.query(
          `DELETE FROM ${schemaName}.cart_items WHERE id = ANY($1::int[]) AND account = $2`,
          [item_ids, account]
        );
      }

      await client.query('COMMIT');

      const newBalResult = await pool.query(
        `SELECT balance FROM ${schemaName}.accounts WHERE account = $1`,
        [account]
      );

      res.json({
        status: 'Success',
        message: '結帳成功',
        data: {
          new_balance: parseFloat(newBalResult.rows[0].balance),
          is_direct_buy: isDirectBuy,  // 讓前端知道是哪種模式
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('結帳失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '結帳失敗，請稍後再試' });
    } finally {
      client.release();
    }
  });

  return router;
};