// routes/products.js
const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');


module.exports = (pool, schemaName) => {
  const router = express.Router();

// ==================== 取得適用價格版本 ====================
// 規則：符合多個版本時取 start_date 最新的；相同則取 version_code 最大的
async function getApplicableVersion(pool, schemaName) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const result = await pool.query(`
    SELECT version_code
    FROM ${schemaName}.sales_price_versions
    WHERE start_date <= $1 AND end_date >= $1
    ORDER BY start_date DESC, version_code DESC
    LIMIT 1
  `, [today]);
  return result.rows.length > 0 ? result.rows[0].version_code : null;
}

    // ══════════════════════════════════════════════
  // ── 分類主檔 API（/api/products/classes）──
  // ══════════════════════════════════════════════
 
  // GET /api/products/classes — 查詢所有分類（供下拉選單使用）
  router.get('/classes',
    authenticateToken,
    requirePermission('masters:product:read'),
    async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT class_code, class_name, description, sort_order, status
          FROM ${schemaName}.product_classes
          ORDER BY sort_order ASC, class_code ASC
        `);
        res.json({ status: 'Success', classes: result.rows });
      } catch (error) {
        console.error('❌ 查詢分類失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢分類失敗', error: error.message });
      }
    }
  );
 
  // GET /api/products/classes/:classCode — 查詢單一分類
  router.get('/classes/:classCode',
    authenticateToken,
    requirePermission('masters:product:read'),
    async (req, res) => {
      try {
        const { classCode } = req.params;
        const result = await pool.query(
          `SELECT * FROM ${schemaName}.product_classes WHERE class_code = $1`,
          [classCode]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '分類不存在' });
        }
        res.json({ status: 'Success', class: result.rows[0] });
      } catch (error) {
        console.error('❌ 查詢分類失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢分類失敗', error: error.message });
      }
    }
  );
 
  // PUT /api/products/classes/:classCode — 更新分類名稱 / 說明
  router.put('/classes/:classCode',
    authenticateToken,
    requirePermission('masters:product:update'),
    async (req, res) => {
      try {
        const { classCode } = req.params;
        const { class_name, description, sort_order, status } = req.body;
 
        if (!class_name || !class_name.trim()) {
          return res.status(400).json({ status: 'Error', message: '分類名稱不可為空' });
        }
 
        const result = await pool.query(`
          UPDATE ${schemaName}.product_classes
          SET class_name  = $1,
              description = $2,
              sort_order  = $3,
              status      = $4,
              updated_at  = CURRENT_TIMESTAMP,
              updated_by  = $5
          WHERE class_code = $6
          RETURNING *
        `, [
          class_name.trim(),
          description || null,
          sort_order ?? 0,
          status || 'active',
          req.user.account,
          classCode
        ]);
 
        if (result.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '分類不存在' });
        }
 
        res.json({ status: 'Success', message: '分類更新成功', class: result.rows[0] });
      } catch (error) {
        console.error('❌ 更新分類失敗:', error);
        res.status(500).json({ status: 'Error', message: '更新分類失敗', error: error.message });
      }
    }
  );
 
  // ══════════════════════════════════════════════
  // ── 產品 CRUD API ──
  // ══════════════════════════════════════════════

  // GET /api/products — 查詢產品列表（含 class_name JOIN）
  router.get('/',
    authenticateToken,
    requirePermission('masters:product:read'),
    async (req, res) => {
      try {
        const { page = 1, limit = 10, search = '', class_code = '', status: statusFilter = '' } = req.query;
        const offset = (page - 1) * limit;
 
        let whereClause = 'WHERE 1=1';
        const params = [];
 
        if (search) {
          params.push(`%${search}%`);
          whereClause += ` AND (p.product_code ILIKE $${params.length} OR p.product_name ILIKE $${params.length})`;
        }
 
        if (class_code) {
          params.push(class_code);
          whereClause += ` AND p.class_code = $${params.length}`;
        }
 
        if (statusFilter) {
          params.push(statusFilter);
          whereClause += ` AND p.status = $${params.length}`;
        }
 
        // 總數
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.products p ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);
 
        // 資料（JOIN product_classes 取得 class_name）
        const dataResult = await pool.query(`
          SELECT
            p.id,
            p.product_code,
            p.product_name,
            p.specification,
            p.unit,
            p.category,
            p.class_code,
            c.class_name,
            p.status,
            p.remark,
            p.created_at,
            p.updated_at,
            p.created_by,
            p.updated_by
          FROM ${schemaName}.products p
          LEFT JOIN ${schemaName}.product_classes c ON p.class_code = c.class_code
          ${whereClause}
          ORDER BY p.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);
 
        res.json({
          status: 'Success',
          products: dataResult.rows,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        });
      } catch (error) {
        console.error('❌ 查詢產品失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢產品失敗', error: error.message });
      }
    }
  );

 // ==================== GET /api/products/shopping ====================
// 公開 API（不需登入），回傳商品列表 + 適用版本價格 + img
// 支援：search、class_code、status、page、limit
router.get('/shopping', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      class_code = '',
      status: statusFilter = 'active', // 預設只顯示上架商品
    } = req.query;
 
    const offset = (parseInt(page) - 1) * parseInt(limit);
 
    // 1. 取得適用價格版本
    const versionCode = await getApplicableVersion(pool, schemaName);
 
    // 2. 動態組合 WHERE 條件
    const conditions = ['1=1'];
    const params = [];
 
    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(p.product_code ILIKE $${params.length} OR p.product_name ILIKE $${params.length})`
      );
    }
 
    if (class_code) {
      params.push(class_code);
      conditions.push(`p.class_code = $${params.length}`);
    }
 
    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`p.status = $${params.length}`);
    }
 
    const whereClause = 'WHERE ' + conditions.join(' AND ');
 
    // 3. 查詢總筆數
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schemaName}.products p ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);
 
    // 4. 查詢商品資料（JOIN 價格版本、商品分類）
    //    若有適用版本 → LEFT JOIN sales_price_rows 取得價格與折扣
    //    若無適用版本 → price/discount/discount_price 全部為 0/1/0
    let dataQuery;
    let dataParams;
 
    if (versionCode) {
      // 有適用版本：JOIN 價格明細
      dataParams = [...params, versionCode, parseInt(limit), offset];
      dataQuery = `
        SELECT
          p.id,
          p.product_code,
          p.product_name,
          p.specification,
          p.unit,
          p.category,
          p.class_code,
          c.class_name,
          p.img,
          p.status,
          p.remark,
          -- 價格欄位
          COALESCE(spr.price, 0)                              AS price,
          COALESCE(spr.price, 0)                              AS origin_price,
          COALESCE(spr.discount, 1)                           AS discount,
          ROUND(
            COALESCE(spr.price, 0) * COALESCE(spr.discount, 1)
          , 0)                                                AS discount_price,
          $${params.length + 1}::text                         AS version_code
        FROM ${schemaName}.products p
        LEFT JOIN ${schemaName}.product_classes c
          ON p.class_code = c.class_code
        LEFT JOIN ${schemaName}.sales_price_rows spr
          ON p.product_code = spr.product_code
          AND spr.version_code = $${params.length + 1}
        ${whereClause}
        ORDER BY p.product_code ASC
        LIMIT $${params.length + 2} OFFSET $${params.length + 3}
      `;
    } else {
      // 無適用版本：不 JOIN 價格，全部為預設值
      dataParams = [...params, parseInt(limit), offset];
      dataQuery = `
        SELECT
          p.id,
          p.product_code,
          p.product_name,
          p.specification,
          p.unit,
          p.category,
          p.class_code,
          c.class_name,
          p.img,
          p.status,
          p.remark,
          0     AS price,
          0     AS origin_price,
          1     AS discount,
          0     AS discount_price,
          NULL  AS version_code
        FROM ${schemaName}.products p
        LEFT JOIN ${schemaName}.product_classes c
          ON p.class_code = c.class_code
        ${whereClause}
        ORDER BY p.product_code ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
    }
 
    const dataResult = await pool.query(dataQuery, dataParams);
 
    res.json({
      status: 'Success',
      data: dataResult.rows,
      version_code: versionCode || null,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error('❌ 查詢購物商品失敗:', error);
    res.status(500).json({
      status: 'Error',
      message: '查詢購物商品失敗',
      error: error.message,
    });
  }
});
 
// ==================== GET /api/products/shopping/:product_code ====================
// 公開 API（不需登入），取得單一商品詳情 + 適用版本價格
router.get('/shopping/:product_code', async (req, res) => {
  try {
    const { product_code } = req.params;
    const versionCode = await getApplicableVersion(pool, schemaName);
 
    let query, params;
 
    if (versionCode) {
      params = [product_code, versionCode];
      query = `
        SELECT
          p.id,
          p.product_code,
          p.product_name,
          p.specification,
          p.unit,
          p.category,
          p.class_code,
          c.class_name,
          p.img,
          p.status,
          p.remark,
          COALESCE(spr.price, 0)                              AS price,
          COALESCE(spr.price, 0)                              AS origin_price,
          COALESCE(spr.discount, 1)                           AS discount,
          ROUND(
            COALESCE(spr.price, 0) * COALESCE(spr.discount, 1)
          , 0)                                                AS discount_price,
          $2::text                                            AS version_code
        FROM ${schemaName}.products p
        LEFT JOIN ${schemaName}.product_classes c
          ON p.class_code = c.class_code
        LEFT JOIN ${schemaName}.sales_price_rows spr
          ON p.product_code = spr.product_code
          AND spr.version_code = $2
        WHERE p.product_code = $1 AND p.status = 'active'
      `;
    } else {
      params = [product_code];
      query = `
        SELECT
          p.id,
          p.product_code,
          p.product_name,
          p.specification,
          p.unit,
          p.category,
          p.class_code,
          c.class_name,
          p.img,
          p.status,
          p.remark,
          0     AS price,
          0     AS origin_price,
          1     AS discount,
          0     AS discount_price,
          NULL  AS version_code
        FROM ${schemaName}.products p
        LEFT JOIN ${schemaName}.product_classes c
          ON p.class_code = c.class_code
        WHERE p.product_code = $1 AND p.status = 'active'
      `;
    }
 
    const result = await pool.query(query, params);
 
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '找不到此商品' });
    }
 
    res.json({ status: 'Success', data: result.rows[0] });
  } catch (error) {
    console.error('❌ 查詢商品詳情失敗:', error);
    res.status(500).json({
      status: 'Error',
      message: '查詢商品詳情失敗',
      error: error.message,
    });
  }
});
  // GET /api/products/:id — 查詢單一產品
  router.get('/:id',
    authenticateToken,
    requirePermission('masters:product:read'),
    async (req, res) => {
      try {
        const { id } = req.params;
        const result = await pool.query(`
          SELECT p.*, c.class_name
          FROM ${schemaName}.products p
          LEFT JOIN ${schemaName}.product_classes c ON p.class_code = c.class_code
          WHERE p.id = $1
        `, [id]);
 
        if (result.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '產品不存在' });
        }
        res.json({ status: 'Success', product: result.rows[0] });
      } catch (error) {
        console.error('❌ 查詢產品失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢產品失敗', error: error.message });
      }
    }
  );

  // POST /api/products — 新增產品
  router.post('/',
    authenticateToken,
    requirePermission('masters:product:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
 
        const { product_code, product_name, specification, unit, category, class_code, status = 'active', remark } = req.body;
 
        if (!product_code || !product_name || !unit) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '貨號、品名、單位為必填欄位' });
        }
        if (!/^[A-Z0-9-]+$/.test(product_code)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '貨號只能包含大寫英文、數字和連字號' });
        }
 
        // 貨號重複檢查
        const dupCheck = await client.query(
          `SELECT id FROM ${schemaName}.products WHERE product_code = $1`,
          [product_code.toUpperCase()]
        );
        if (dupCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '此貨號已存在' });
        }
 
        // class_code 合法性檢查（若有填）
        if (class_code) {
          const classCheck = await client.query(
            `SELECT class_code FROM ${schemaName}.product_classes WHERE class_code = $1`,
            [class_code]
          );
          if (classCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ status: 'Error', message: '指定的分類不存在' });
          }
        }
 
        const insertResult = await client.query(`
          INSERT INTO ${schemaName}.products
            (product_code, product_name, specification, unit, category, class_code, status, remark, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
          RETURNING *
        `, [
          product_code.toUpperCase(), product_name,
          specification || null, unit,
          category || null, class_code || null,
          status, remark || null, req.user.account
        ]);
 
        await client.query('COMMIT');
        res.status(201).json({ status: 'Success', message: '產品新增成功', product: insertResult.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 新增產品失敗:', error);
        res.status(500).json({ status: 'Error', message: '新增產品失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

   // PUT /api/products/:id — 更新產品
  router.put('/:id',
    authenticateToken,
    requirePermission('masters:product:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
 
        const { id } = req.params;
        const { product_name, specification, unit, category, class_code, status, remark } = req.body;
 
        if (!product_name || !unit) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '品名、單位為必填欄位' });
        }
 
        const checkResult = await client.query(
          `SELECT id FROM ${schemaName}.products WHERE id = $1`, [id]
        );
        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '產品不存在' });
        }
 
        // class_code 合法性檢查（若有填）
        if (class_code) {
          const classCheck = await client.query(
            `SELECT class_code FROM ${schemaName}.product_classes WHERE class_code = $1`,
            [class_code]
          );
          if (classCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ status: 'Error', message: '指定的分類不存在' });
          }
        }
 
        const updateResult = await client.query(`
          UPDATE ${schemaName}.products SET
            product_name = $1, specification = $2, unit = $3,
            category = $4, class_code = $5, status = $6,
            remark = $7, updated_by = $8, updated_at = CURRENT_TIMESTAMP
          WHERE id = $9
          RETURNING *
        `, [
          product_name, specification || null, unit,
          category || null, class_code || null, status,
          remark || null, req.user.account, id
        ]);
 
        await client.query('COMMIT');
        res.json({ status: 'Success', message: '產品更新成功', product: updateResult.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 更新產品失敗:', error);
        res.status(500).json({ status: 'Error', message: '更新產品失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // DELETE /api/products/:id — 刪除產品
  router.delete('/:id',
    authenticateToken,
    requirePermission('masters:product:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { id } = req.params;
 
        const checkResult = await client.query(
          `SELECT id, product_code FROM ${schemaName}.products WHERE id = $1`, [id]
        );
        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '產品不存在' });
        }
 
        const productCode = checkResult.rows[0].product_code;
 
        // TODO: 可在此加上關聯資料檢查（採購價格、訂單等）
 
        await client.query(`DELETE FROM ${schemaName}.products WHERE id = $1`, [id]);
        await client.query('COMMIT');
 
        res.json({ status: 'Success', message: '產品刪除成功', deletedProductCode: productCode });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除產品失敗:', error);
        res.status(500).json({ status: 'Error', message: '刪除產品失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  return router;
};