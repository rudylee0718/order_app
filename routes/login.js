// routes/login.js

const express = require('express');
const router = express.Router();

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

  // 處理登入驗證的 API
  router.post('/', async (req, res) => {
    const { account, password } = req.body;

    if (!account || !password) {
      return res.status(400).json({ status: 'Error', message: '帳號和密碼不能為空' });
    }

    try {
      const query = `
        SELECT * FROM ${schemaName}.accounts WHERE account = $1 AND password = $2;
      `;
      const values = [account, password];
      const result = await pool.query(query, values);

      if (result.rows.length > 0) {
        res.status(200).json({ status: 'Success', message: '登入成功', data: result.rows[0] });
      } else {
        res.status(401).json({ status: 'Error', message: '帳號或密碼錯誤' });
      }
    } catch (err) {
      console.error('登入驗證失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // 返回 router 物件
  return router;
};