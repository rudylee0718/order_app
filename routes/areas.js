// routes/areas.js
const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ==================== 查詢儲區列表 ====================
  // 權限：masters:storage:read
  router.get('/', 
    authenticateToken, 
    requirePermission('masters:storage:read'),
    async (req, res) => {
      try {
        const { page = 1, limit = 10, search = '' } = req.query;
        const offset = (page - 1) * limit;

        // 構建查詢條件
        let whereClause = 'WHERE 1=1';
        const params = [];
        
        if (search) {
          whereClause += ` AND (area_code ILIKE $${params.length + 1} )`;
          params.push(`%${search}%`);
        }

        // 查詢總數
        const countQuery = `SELECT COUNT(*) FROM ${schemaName}.areas ${whereClause}`;
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // 查詢資料
        const dataQuery = `
          SELECT 
            id,
            area_code as areaCode,
            status,
            remark,
            created_at,
            updated_at,
            created_by,
            updated_by
          FROM ${schemaName}.areas
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

        res.json({
          status: 'Success',
          areas: dataResult.rows,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        });

      } catch (error) {
        console.error('❌ 查詢儲區失敗:', error);
        res.status(500).json({ 
          status: 'Error',
          message: '查詢儲區失敗', 
          error: error.message 
        });
      }
    }
  );

  // ==================== 查詢單一儲區 ====================
  // 權限：masters:storage:read
  router.get('/:areaCode', 
    authenticateToken, 
    requirePermission('masters:storage:read'),
    async (req, res) => {
      try {
        const { areaCode } = req.params;
        
        const result = await pool.query(
          `SELECT * FROM ${schemaName}.areas WHERE area_code = $1`,
          [areaCode]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ 
            status: 'Error',
            message: '儲區不存在' 
          });
        }

        res.json({
          status: 'Success',
          area: result.rows[0]
        });

      } catch (error) {
        console.error('❌ 查詢儲區失敗:', error);
        res.status(500).json({ 
          status: 'Error',
          message: '查詢儲區失敗', 
          error: error.message 
        });
      }
    }
  );

  // ==================== 新增儲區 ====================
  // 權限：masters:storage:create
  router.post('/', 
    authenticateToken, 
    requirePermission('masters:storage:create'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        const {
          areaCode,
          status = 'active',
          remark
        } = req.body;

        // 驗證必填欄位
        if (!areaCode) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            status: 'Error',
            message: '儲區為必填欄位' 
          });
        }

        // 驗證儲區格式（大寫英數字和連字號）
        if (!/^[A-Z0-9-]+$/.test(areaCode)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            status: 'Error',
            message: '儲區只能包含大寫英文、數字和連字號' 
          });
        }

        // 檢查儲區是否重複
        const checkResult = await client.query(
          `SELECT area_code FROM ${schemaName}.areas WHERE area_code = $1`,
          [areaCode.toUpperCase()]
        );

        if (checkResult.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            status: 'Error',
            message: '此儲區已存在' 
          });
        }

        // 新增儲區
        const insertResult = await client.query(
          `INSERT INTO ${schemaName}.areas (
            area_code,
            status,
            remark,
            created_by,
            updated_by
          ) VALUES ($1, $2, $3, $4, $4)
          RETURNING *`,
          [
            areaCode.toUpperCase(),
            status,
            remark || null,
            req.user.account // 使用 account 而非 id
          ]
        );

        await client.query('COMMIT');
        
        res.status(201).json({
          status: 'Success',
          message: '儲區新增成功',
          area: insertResult.rows[0]
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 新增儲區失敗:', error);
        res.status(500).json({ 
          status: 'Error',
          message: '新增儲區失敗', 
          error: error.message 
        });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 更新儲區 ====================
  // 權限：masters:storage:update
  router.put('/:areaCode', 
    authenticateToken, 
    requirePermission('masters:storage:update'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        const { areaCode } = req.params;
        const {
          status,
          remark
        } = req.body;



        // 檢查儲區是否存在
        const checkResult = await client.query(
          `SELECT area_code as areaCode FROM ${schemaName}.areas WHERE area_code = $1`,
          [areaCode]
        );

        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
            status: 'Error',
            message: '儲區不存在' 
          });
        }

        // 更新儲區
        const updateResult = await client.query(
          `UPDATE ${schemaName}.areas SET
            status = $1,
            remark = $2,
            updated_by = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE area_code = $4
          RETURNING *`,
          [
            status,
            remark || null,
            req.user.account, // 使用 account 而非 id
            areaCode
          ]
        );

        await client.query('COMMIT');
        
        res.json({
          status: 'Success',
          message: '儲區更新成功',
          area: updateResult.rows[0]
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 更新儲區失敗:', error);
        res.status(500).json({ 
          status: 'Error',
          message: '更新儲區失敗', 
          error: error.message 
        });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 刪除儲區 ====================
  // 權限：masters:storage:delete
  router.delete('/:areaCode', 
    authenticateToken, 
    requirePermission('masters:storage:delete'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        const { areaCode } = req.params;

        // 檢查儲區是否存在
        const checkResult = await client.query(
          `SELECT area_code FROM ${schemaName}.areas WHERE area_code = $1`,
          [areaCode]
        );

        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
            status: 'Error',
            message: '儲區不存在' 
          });
        }

        const area_code = checkResult.rows[0].area_code;


        // 刪除儲區
        await client.query(
          `DELETE FROM ${schemaName}.areas WHERE area_code = $1`, 
          [areaCode]
        );

        await client.query('COMMIT');
        
        res.json({ 
          status: 'Success',
          message: '儲區刪除成功',
          deletedAreaCode: area_code
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除儲區失敗:', error);
        res.status(500).json({ 
          status: 'Error',
          message: '刪除儲區失敗', 
          error: error.message 
        });
      } finally {
        client.release();
      }
    }
  );

  return router;
};