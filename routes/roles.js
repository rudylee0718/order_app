// routes/roles.js
// 提供 app_order.roles 資料表的查詢 API
// 掛載方式：app.use('/api/roles', require('./routes/roles')(pool, schemaName))

const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ==================== 查詢所有角色定義 ====================
  // GET /api/roles
  // 前端用來載入角色清單（用於指派 Modal 的選擇列表）
  // 權限：masters:permission:read
  router.get('/',
    authenticateToken,
    requirePermission('users:accountrole:read'),
    async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT
            id,
            role_code,
            role_name,
            description,
            level,
            created_at,
            updated_at
          FROM ${schemaName}.roles
          ORDER BY level ASC, id ASC
        `);

        res.json({
          status: 'Success',
          roles: result.rows,
          total: result.rows.length
        });

      } catch (error) {
        console.error('❌ 查詢角色定義失敗:', error);
        res.status(500).json({
          status: 'Error',
          message: '查詢角色定義失敗',
          error: error.message
        });
      }
    }
  );

  // ==================== 查詢單一角色定義 ====================
  // GET /api/roles/:roleCode
  router.get('/:roleCode',
    authenticateToken,
    requirePermission('users:accountrole:read'),
    async (req, res) => {
      try {
        const { roleCode } = req.params;

        const result = await pool.query(
          `SELECT * FROM ${schemaName}.roles WHERE role_code = $1`,
          [roleCode]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            status: 'Error',
            message: '角色不存在'
          });
        }

        res.json({
          status: 'Success',
          role: result.rows[0]
        });

      } catch (error) {
        console.error('❌ 查詢角色失敗:', error);
        res.status(500).json({
          status: 'Error',
          message: '查詢角色失敗',
          error: error.message
        });
      }
    }
  );

  return router;
};