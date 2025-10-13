// routes/customers.js

const express = require('express');
const router = express.Router();

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

  // 新增客戶資料的 API
  router.post('/', async (req, res) => {
    const { id, description, tel, address } = req.body;
    
    // 檢查所有必需的欄位
    if (!id || !description) {
      return res.status(400).json({ status: 'Error', message: '缺少必要的欄位: id 和 description' });
    }

    try {
      const query = `
        INSERT INTO ${schemaName}.customers (id, description, tel, address)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
        RETURNING *;
      `;
      const values = [id, description, tel, address];
      
      const result = await pool.query(query, values);

      if (result.rows.length > 0) {
        res.status(201).json({ status: 'Success', message: '客戶資料已成功新增', data: result.rows[0] });
      } else {
        res.status(409).json({ status: 'Error', message: '客戶ID已存在，無法新增' });
      }
    } catch (err) {
      console.error('新增客戶資料失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '新增客戶資料失敗' });
    }
  });

  // 返回 router 物件
  return router;
};