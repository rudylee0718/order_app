// routes/customers.js
const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ══════════════════════════════════════════════
  // 輔助 API：查客戶類別清單
  // GET /api/customers/types
  // ══════════════════════════════════════════════
  router.get('/types',
    authenticateToken,
    requirePermission('masters:customer:read'),
    async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT type_code, type_name, sort_order
          FROM ${schemaName}.customer_types
          WHERE status = 'active'
          ORDER BY sort_order ASC, type_code ASC
        `);
        res.json({ status: 'Success', types: result.rows });
      } catch (error) {
        console.error('❌ 查詢客戶類別失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢客戶類別失敗', error: error.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 查詢客戶列表
  // GET /api/customers?page=&limit=&search=&customer_type=&status=
  // ══════════════════════════════════════════════
  router.get('/',
    authenticateToken,
    requirePermission('masters:customer:read'),
    async (req, res) => {
      try {
        const {
          page = 1, limit = 10,
          search = '',
          customer_type = '',
          status: statusFilter = ''
        } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (search) {
          params.push(`%${search}%`);
          whereClause += ` AND (c.id ILIKE $${params.length} OR c.description ILIKE $${params.length})`;
        }
        if (customer_type) {
          params.push(customer_type);
          whereClause += ` AND c.customer_type = $${params.length}`;
        }
        if (statusFilter) {
          params.push(statusFilter);
          whereClause += ` AND c.status = $${params.length}`;
        }

        // 查詢總數
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.customers c ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        // 查詢資料（JOIN customer_types 取得 type_name）
        const dataResult = await pool.query(`
          SELECT
            c.id,
            c.description,
            c.tel,
            c.address,
            c.status,
            c.remark,
            c.customer_type,
            ct.type_name     AS customer_type_name,
            c.payment_method,
            c.payment_terms,
            c.created_at,
            c.updated_at,
            c.created_by,
            c.updated_by
          FROM ${schemaName}.customers c
          LEFT JOIN ${schemaName}.customer_types ct ON ct.type_code = c.customer_type
          ${whereClause}
          ORDER BY c.id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          customers: dataResult.rows,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        });
      } catch (error) {
        console.error('❌ 查詢客戶失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢客戶失敗', error: error.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 查詢單一客戶
  // GET /api/customers/:id
  // ══════════════════════════════════════════════
  router.get('/:id',
    authenticateToken,
    requirePermission('masters:customer:read'),
    async (req, res) => {
      try {
        const { id } = req.params;

        const result = await pool.query(`
          SELECT
            c.*,
            ct.type_name AS customer_type_name
          FROM ${schemaName}.customers c
          LEFT JOIN ${schemaName}.customer_types ct ON ct.type_code = c.customer_type
          WHERE c.id = $1
        `, [id]);

        if (result.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '客戶不存在' });
        }

        res.json({ status: 'Success', customer: result.rows[0] });
      } catch (error) {
        console.error('❌ 查詢客戶失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢客戶失敗', error: error.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 新增客戶
  // POST /api/customers
  // ══════════════════════════════════════════════
  router.post('/',
    authenticateToken,
    requirePermission('masters:customer:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const {
          id, description, tel, address,
          status = 'active', remark,
          customer_type,
          payment_method, payment_terms
        } = req.body;

        // 必填驗證
        if (!id || !description) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '客戶代號、客戶名稱為必填欄位' });
        }

        // 代號格式驗證
        if (!/^[A-Z0-9-]+$/.test(id)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '客戶代號只能包含大寫英文、數字和連字號' });
        }

        // 重複檢查
        const dupCheck = await client.query(
          `SELECT id FROM ${schemaName}.customers WHERE id = $1`, [id.toUpperCase()]
        );
        if (dupCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '此客戶代號已存在' });
        }

        // customer_type 合法性檢查（若有填）
        if (customer_type) {
          const typeCheck = await client.query(
            `SELECT type_code FROM ${schemaName}.customer_types WHERE type_code = $1`, [customer_type]
          );
          if (typeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ status: 'Error', message: '指定的客戶類別不存在' });
          }
        }

        const insertResult = await client.query(`
          INSERT INTO ${schemaName}.customers (
            id, description, tel, address, status, remark,
            customer_type, payment_method, payment_terms,
            created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
          RETURNING *
        `, [
          id.toUpperCase(), description,
          tel || null, address || null,
          status, remark || null,
          customer_type || null,
          payment_method || null, payment_terms || null,
          req.user.account
        ]);

        await client.query('COMMIT');

        res.status(201).json({
          status: 'Success',
          message: '客戶新增成功',
          customer: insertResult.rows[0]
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 新增客戶失敗:', error);
        res.status(500).json({ status: 'Error', message: '新增客戶失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 更新客戶
  // PUT /api/customers/:id
  // ══════════════════════════════════════════════
  router.put('/:id',
    authenticateToken,
    requirePermission('masters:customer:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { id } = req.params;
        const {
          description, tel, address, status, remark,
          customer_type, payment_method, payment_terms
        } = req.body;

        if (!description) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '客戶名稱為必填欄位' });
        }

        // 確認客戶存在
        const chk = await client.query(
          `SELECT id FROM ${schemaName}.customers WHERE id = $1`, [id]
        );
        if (chk.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '客戶不存在' });
        }

        // customer_type 合法性檢查
        if (customer_type) {
          const typeCheck = await client.query(
            `SELECT type_code FROM ${schemaName}.customer_types WHERE type_code = $1`, [customer_type]
          );
          if (typeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ status: 'Error', message: '指定的客戶類別不存在' });
          }
        }

        const updateResult = await client.query(`
          UPDATE ${schemaName}.customers SET
            description    = $1,
            tel            = $2,
            address        = $3,
            status         = $4,
            remark         = $5,
            customer_type  = $6,
            payment_method = $7,
            payment_terms  = $8,
            updated_by     = $9,
            updated_at     = CURRENT_TIMESTAMP
          WHERE id = $10
          RETURNING *
        `, [
          description, tel || null, address || null,
          status, remark || null,
          customer_type || null,
          payment_method || null, payment_terms || null,
          req.user.account, id
        ]);

        await client.query('COMMIT');

        res.json({
          status: 'Success',
          message: '客戶更新成功',
          customer: updateResult.rows[0]
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 更新客戶失敗:', error);
        res.status(500).json({ status: 'Error', message: '更新客戶失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 刪除客戶
  // DELETE /api/customers/:id
  // ══════════════════════════════════════════════
  router.delete('/:id',
    authenticateToken,
    requirePermission('masters:customer:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { id } = req.params;

        const chk = await client.query(
          `SELECT id FROM ${schemaName}.customers WHERE id = $1`, [id]
        );
        if (chk.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '客戶不存在' });
        }

        // TODO: 可在此加入關聯資料檢查（如：訂單是否存在）

        await client.query(`DELETE FROM ${schemaName}.customers WHERE id = $1`, [id]);
        await client.query('COMMIT');

        res.json({
          status: 'Success',
          message: '客戶刪除成功',
          deletedCustomerId: id
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除客戶失敗:', error);
        res.status(500).json({ status: 'Error', message: '刪除客戶失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  return router;
};