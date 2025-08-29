// routes/accounts.js

const express = require('express');
const router = express.Router();

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (client, schemaName) => {

  // 新增帳號資料的 API
  router.post('/', async (req, res) => {
    const { account, password, description, customer_id } = req.body;

    // 檢查所有必需的欄位
    if (!account || !password || !customer_id) {
      return res.status(400).json({ status: 'Error', message: '缺少必要的欄位: account, password 和 customer_id' });
    }
    
    try {
      // 檢查 customer_id 是否存在於客戶資料表中
      const customerCheckQuery = `
        SELECT id FROM ${schemaName}.customers WHERE id = $1;
      `;
      const customerCheckResult = await client.query(customerCheckQuery, [customer_id]);
      
      if (customerCheckResult.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '提供的客戶ID不存在' });
      }

      const query = `
        INSERT INTO ${schemaName}.accounts (account, password, description, customer_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (account) DO NOTHING
        RETURNING *;
      `;
      const values = [account, password, description, customer_id];
      
      const result = await client.query(query, values);
      
      if (result.rows.length > 0) {
        res.status(201).json({ status: 'Success', message: '帳號資料已成功新增', data: result.rows[0] });
      } else {
        res.status(409).json({ status: 'Error', message: '帳號名稱已存在，無法新增' });
      }

    } catch (err) {
      console.error('新增帳號資料失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '新增帳號資料失敗' });
    }
  });

   // 查詢單一帳號資料的 API (用於 Flutter 頁面中的自動帶入功能)
  router.get('/', async (req, res) => {
    const { account } = req.query;
    if (!account) {
      return res.status(400).json({ status: 'Error', message: '缺少帳號參數' });
    }
    try {
      const query = `
        SELECT a.account, a.description as accountName,b.description as customerName, a.customer_id FROM ${schemaName}.accounts as a 
        left join ${schemaName}.customers as b on a.customer_id=b.id WHERE a.account = $1;
      `;
      const values = [account];
      const result = await client.query(query, values);
      if (result.rows.length > 0) {
        res.status(200).json({ status: 'Success', message: '帳號查詢成功', data: result.rows[0] });
      } else {
        res.status(404).json({ status: 'Error', message: '帳號不存在' });
      }
    } catch (err) {
      console.error('帳號查詢失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '帳號查詢失敗' });
    }
  });


  // 返回 router 物件
  return router;
};