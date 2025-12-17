// server.js

// 引入所需的模組
const express = require('express');
const cors = require('cors'); // 引入 cors 套件
const { Pool  } = require('pg');
const dotenv = require('dotenv');

// 加載 .env 檔案中的環境變數
dotenv.config();

// 建立 Express 應用程式
const app = express();
const port = process.env.PORT || 3000;
// 啟用 CORS，允許所有來源的請求
app.use(cors());

// 啟用 Express 內建的 body-parser，用來解析 JSON 請求
app.use(express.json());

// PostgreSQL 連線設定，從環境變數中讀取
const pool = new Pool ({
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
const schemaName1 = 'process_schedule';

/**
 * 連接到資料庫
 */
async function connectToDatabase() {
  try {
    await pool.connect();
    console.log('成功連接到 PostgreSQL 資料庫！');
  } catch (err) {
    console.error('資料庫連線失敗：', err.stack);
  }
}

// 呼叫函式以連接資料庫
connectToDatabase();

// 引入客戶和帳號的路由模組
const customersRouter = require('./routes/customers')(pool, schemaName);
const accountsRouter = require('./routes/accounts')(pool, schemaName);
const loginRouter = require('./routes/login')(pool, schemaName);
const loadUi=require('./routes/load_ui')(pool, schemaName);
const ordersRouter=require('./routes/orders')(pool, schemaName);
const scheduleRouter=require('./routes/schedule')(pool, schemaName1);

// 將路由掛載到主應用程式上
app.use('/api/customers', customersRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/login', loginRouter);
app.use('/api', loadUi);
app.use('/api', ordersRouter);
app.use('/api/schedule', scheduleRouter);


// 定義一個測試用的 API 端點
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
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



// 啟動伺服器
app.listen(port, () => {
  console.log(`伺服器正在運行於 http://localhost:${port}`);
});
