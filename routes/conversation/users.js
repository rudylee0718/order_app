// routes/conversation/users.js

const express = require('express');
const router = express.Router();
const { validateRequired } = require('../../middleware/validation');
const { asyncHandler } = require('../../middleware/errorHandler');

module.exports = (pool, schemaName) => {
  /**
   * GET /api/users/search
   * 搜尋用戶(排除自己)
   */
  router.get('/search',
    validateRequired(['q']),
    asyncHandler(async (req, res) => {
      const { q, excludeAccount } = req.query;
      
      const result = await pool.query(`
        SELECT 
          account,
          description,
          customer_id
        FROM ${schemaName}.accounts
        WHERE (account ILIKE $1 OR description ILIKE $1)
          AND account != $2
        ORDER BY description
        LIMIT 20
      `, [`%${q}%`, excludeAccount || '']);
      
      res.json({
        success: true,
        users: result.rows.map(row => ({
          account: row.account,
          accountName: row.description,
          customerId: row.customer_id,
        }))
      });
    })
  );

  return router;
};