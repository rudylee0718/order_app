// routes/account-roles.js
const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

// 權限：為了查客戶的帳號
  router.get('/accounts/',
    async (req, res) => {
      try {
        const { customer_id, page = 1, limit = 10, search = '' } = req.query;

        if (!customer_id) {
          return res.status(400).json({ status: 'Error', message: '請提供客戶代號 customer_id' });
        }

        const offset = (page - 1) * limit;
        const params = [customer_id];
        let whereClause = `WHERE a.customer_id = $1`;

        if (search) {
          whereClause += ` AND (a.account ILIKE $${params.length + 1} OR a.description ILIKE $${params.length + 1})`;
          params.push(`%${search}%`);
        }

        // 總數
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.accounts a ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        // 資料
        const dataResult = await pool.query(`
          SELECT
            a.account,
            a.password,
            a.description,
            a.email,
            a.phone,
            a.status,
            a.remark,
            a.profile_image_url,
            a.customer_id,
            a.created_at,
            a.updated_at,
            a.created_by,
            a.updated_by
          FROM ${schemaName}.accounts a
          ${whereClause}

          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          accounts: dataResult.rows,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        });

      } catch (error) {
        console.error('❌ 查詢帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢帳號失敗', error: error.message });
      }
    }
  );

  // ==================== 查詢帳號的所有角色 ====================
  // GET /api/account-roles/:account
  // 權限：masters:permission:read
  router.get('/:account',
    authenticateToken,
    requirePermission('users:accountrole:read'),
    async (req, res) => {
      try {
        const { account } = req.params;

        // 確認帳號存在
        const accountCheck = await pool.query(
          `SELECT account, description FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (accountCheck.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }

        const result = await pool.query(`
          SELECT
            ar.id,
            ar.account,
            ar.role_code,
            ar.assigned_at,
            ar.assigned_by,
            a.description as account_name
          FROM ${schemaName}.account_roles ar
          LEFT JOIN ${schemaName}.accounts a ON ar.account = a.account
          WHERE ar.account = $1
          ORDER BY ar.assigned_at ASC
        `, [account]);

        res.json({
          status: 'Success',
          account: accountCheck.rows[0],
          roles: result.rows,
          total: result.rows.length
        });

      } catch (error) {
        console.error('❌ 查詢帳號角色失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢角色失敗', error: error.message });
      }
    }
  );

  // ==================== 查詢所有角色列表（可依 customer_id 篩選）====================
  // GET /api/account-roles?customer_id=&account=
  router.get('/',
    authenticateToken,
    requirePermission('users:accountrole:read'),
    async (req, res) => {
      try {
        const { customer_id, account } = req.query;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (customer_id) {
          whereClause += ` AND a.customer_id = $${params.length + 1}`;
          params.push(customer_id);
        }

        if (account) {
          whereClause += ` AND ar.account = $${params.length + 1}`;
          params.push(account);
        }

        const result = await pool.query(`
          SELECT
            ar.id,
            ar.account,
            ar.role_code,
            ar.assigned_at,
            ar.assigned_by,
            a.description as account_name,
            a.profile_image_url,
            a.customer_id
          FROM ${schemaName}.account_roles ar
          LEFT JOIN ${schemaName}.accounts a ON ar.account = a.account
          ${whereClause}
          ORDER BY ar.account ASC, ar.assigned_at ASC
        `, params);

        res.json({
          status: 'Success',
          roles: result.rows,
          total: result.rows.length
        });

      } catch (error) {
        console.error('❌ 查詢角色列表失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢失敗', error: error.message });
      }
    }
  );

  // ==================== 新增角色指派 ====================
  // POST /api/account-roles
  // 權限：masters:permission:create
  router.post('/',
    authenticateToken,
    requirePermission('users:accountrole:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { account, role_code, assigned_by } = req.body;

        // 必填驗證
        if (!account || !role_code) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '帳號與角色代碼為必填' });
        }

        // 確認帳號存在
        const accountCheck = await client.query(
          `SELECT account FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (accountCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }

        // 防止重複指派
        const dupCheck = await client.query(
          `SELECT id FROM ${schemaName}.account_roles WHERE account = $1 AND role_code = $2`,
          [account, role_code]
        );
        if (dupCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '此帳號已擁有該角色' });
        }

        // 插入
        const insertResult = await client.query(`
          INSERT INTO ${schemaName}.account_roles (account, role_code, assigned_at, assigned_by)
          VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
          RETURNING *
        `, [account, role_code, assigned_by || req.user.account]);

        await client.query('COMMIT');

        res.status(201).json({
          status: 'Success',
          message: '角色指派成功',
          role: insertResult.rows[0]
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 新增角色失敗:', error);
        res.status(500).json({ status: 'Error', message: '新增角色失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 刪除角色指派 ====================
  // DELETE /api/account-roles/:id
  // 權限：masters:permission:delete
  router.delete('/:id',
    authenticateToken,
    requirePermission('users:accountrole:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { id } = req.params;

        // 確認記錄存在
        const checkResult = await client.query(
          `SELECT id, account, role_code FROM ${schemaName}.account_roles WHERE id = $1`,
          [id]
        );
        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '角色指派記錄不存在' });
        }

        const { account, role_code } = checkResult.rows[0];

        // 防止刪除 super_admin 的最後一個管理員角色（可選保護）
        if (role_code === 'super_admin') {
          const adminCount = await client.query(
            `SELECT COUNT(*) FROM ${schemaName}.account_roles WHERE role_code = 'super_admin'`
          );
          if (parseInt(adminCount.rows[0].count) <= 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'Error',
              message: '系統至少需要保留一位超級管理員，無法刪除',
              code: 'LAST_SUPER_ADMIN'
            });
          }
        }

        await client.query(
          `DELETE FROM ${schemaName}.account_roles WHERE id = $1`,
          [id]
        );

        await client.query('COMMIT');

        res.json({
          status: 'Success',
          message: '角色已移除',
          deletedId: parseInt(id),
          account,
          role_code
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除角色失敗:', error);
        res.status(500).json({ status: 'Error', message: '刪除角色失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 批次指派角色（一次指派多個）====================
  // POST /api/account-roles/batch
  router.post('/batch',
    authenticateToken,
    requirePermission('users:accountrole:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { account, role_codes, assigned_by } = req.body;

        if (!account || !Array.isArray(role_codes) || role_codes.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '帳號與角色列表為必填' });
        }

        const accountCheck = await client.query(
          `SELECT account FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (accountCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }

        const assigned = [];
        const skipped = [];

        for (const role_code of role_codes) {
          const dupCheck = await client.query(
            `SELECT id FROM ${schemaName}.account_roles WHERE account = $1 AND role_code = $2`,
            [account, role_code]
          );
          if (dupCheck.rows.length > 0) {
            skipped.push(role_code);
            continue;
          }
          await client.query(`
            INSERT INTO ${schemaName}.account_roles (account, role_code, assigned_at, assigned_by)
            VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
          `, [account, role_code, assigned_by || req.user.account]);
          assigned.push(role_code);
        }

        await client.query('COMMIT');

        res.status(201).json({
          status: 'Success',
          message: `成功指派 ${assigned.length} 個角色`,
          assigned,
          skipped
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 批次指派角色失敗:', error);
        res.status(500).json({ status: 'Error', message: '批次指派失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  return router;
};