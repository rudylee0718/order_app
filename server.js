// server.js

// 引入所需的模組
const express = require('express');
const { Client } = require('pg');
const dotenv = require('dotenv');

// 加載 .env 檔案中的環境變數
dotenv.config();

// 建立 Express 應用程式
const app = express();
const port = process.env.PORT || 3000;

// 啟用 Express 內建的 body-parser，用來解析 JSON 請求
app.use(express.json());

// PostgreSQL 連線設定，從環境變數中讀取
const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false // 這對於 Render 的連線可能是必要的
  }
});


//專案的 schema 名稱
const schemaName = 'app_order';

/**
 * 連接到資料庫
 */
async function connectToDatabase() {
  try {
    await client.connect();
    console.log('成功連接到 PostgreSQL 資料庫！');
  } catch (err) {
    console.error('資料庫連線失敗：', err.stack);
  }
}

// 呼叫函式以連接資料庫
connectToDatabase();

// 定義一個測試用的 API 端點
app.get('/api/status', async (req, res) => {
  try {
    const result = await client.query('SELECT NOW()');
    res.json({
      status: 'OK',
      message: '後端伺服器運行正常，並已連接到資料庫。',
      currentTime: result.rows[0].now
    });
  } catch (err) {
    console.error('API 狀態檢查失敗：', err.stack);
    res.status(500).json({ status: 'Error', message: '無法連接到資料庫' });
  }
});

// 新增客戶資料的 API
app.post('/api/customers', async (req, res) => {
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
    
    const result = await client.query(query, values);

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

// 新增帳號資料的 API
app.post('/api/accounts', async (req, res) => {
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

// 啟動伺服器
app.listen(port, () => {
  console.log(`伺服器正在運行於 http://localhost:${port}`);
});
