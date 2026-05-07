
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { pool, testConnection, closePool } = require('./config/database');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');


// 加載環境變數
dotenv.config();

// 建立 Express 應用程式
const app = express();
const port = process.env.PORT || 3000;

// ==================== 中介軟體設定 ====================

// 啟用 CORS
app.use(cors());

// 解析 JSON 請求
app.use(express.json());

// 請求日誌 (開發環境)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// ==================== Schema 設定 ====================

const schemaName = process.env.SCHEMA_NAME || 'app_order';
const schemaName1 = process.env.SCHEMA_NAME_1 || 'process_schedule';

// ==================== 路由設定 ====================

// 引入路由模組
const customersRouter = require('./routes/customers')(pool, schemaName);
const accountsRouter = require('./routes/accounts')(pool, schemaName);
const rolesRouter = require('./routes/roles')(pool, schemaName);
const accountRolesRouter = require('./routes/account-roles')(pool, schemaName);
const loginRouter = require('./routes/login')(pool, schemaName);
const loadUiRouter = require('./routes/load_ui')(pool, schemaName);
const ordersRouter = require('./routes/orders')(pool, schemaName);
const scheduleRouter = require('./routes/schedule')(pool, schemaName1);
const conversationRouter = require('./routes/conversation')(pool, schemaName);
const productsRouter = require('./routes/products')(pool, schemaName);
const areasRouter = require('./routes/areas')(pool, schemaName);
const purchasePricesRouter = require('./routes/purchase-prices')(pool, schemaName);
const salesPricesRouter = require('./routes/sales-prices')(pool, schemaName);
const productsGradeRouter = require('./routes/products-grade')(pool, schemaName);
const customerLevelsRouter = require('./routes/customer-levels')(pool, schemaName);
const aiRouter = require('./routes/ai')(pool, schemaName);
const erpOrders = require('./routes/erp-orders')(pool, schemaName);
const purchaseRequest = require('./routes/purchase-requests')(pool, schemaName);
const cartRouter = require('./routes/cart')(pool, schemaName);
const quizRouter = require('./routes/quiz')(pool, schemaName);

// 掛載路由
app.use('/api/customers', customersRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/account-roles', accountRolesRouter);
app.use('/api/login', loginRouter);
app.use('/api', loadUiRouter);
app.use('/api', ordersRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api', conversationRouter);
app.use('/api/products', productsRouter);
app.use('/api/areas', areasRouter);
app.use('/api/purchase-prices', purchasePricesRouter);
app.use('/api/sales-prices', salesPricesRouter);
app.use('/api/products-grade', productsGradeRouter);
app.use('/api/customer-levels', customerLevelsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/erp-orders', erpOrders);
app.use('/api/purchase-requests', purchaseRequest);
app.use('/api/cart', cartRouter);
app.use('/api/quiz', quizRouter);

// ==================== 健康檢查端點 ====================

app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'OK',
      message: '後端伺服器運行正常,並已連接到資料庫',
      currentTime: result.rows[0].now,
      environment: process.env.NODE_ENV || 'development',
      schemas: {
        main: schemaName,
        schedule: schemaName1
      }
    });
  } catch (err) {
    console.error('❌ API 狀態檢查失敗:', err.stack);
    res.status(500).json({
      status: 'Error',
      message: '無法連接到資料庫'
    });
  }
});

// 根路徑
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the API Server',
    version: '2.0.0',
    documentation: '/api/status'
  });
});

// ==================== 錯誤處理 ====================

// 404 處理
app.use(notFoundHandler);

// 全域錯誤處理
app.use(errorHandler);

// ==================== 啟動伺服器 ====================

async function startServer() {
  try {
    // 測試資料庫連線
    const connected = await testConnection();
    
    if (!connected) {
      console.error('❌ 無法連接到資料庫,伺服器啟動失敗');
      process.exit(1);
    }




    // 啟動伺服器
    const server = app.listen(port, () => {
      console.log('='.repeat(50));
      console.log(`🚀 伺服器正在運行於 http://localhost:${port}`);
      console.log(`📊 環境: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🗄️  主要 Schema: ${schemaName}`);
      console.log(`📅 排程 Schema: ${schemaName1}`);
      console.log('='.repeat(50));
    });

    // 優雅關閉
    const gracefulShutdown = async (signal) => {
      console.log(`\n收到 ${signal} 信號,正在優雅關閉...`);
      
      server.close(async () => {
        console.log('⏹️  HTTP 伺服器已關閉');
        await closePool();
        console.log('👋 伺服器已完全關閉');
        process.exit(0);
      });

      // 如果 10 秒後還沒關閉,強制關閉
      setTimeout(() => {
        console.error('❌ 無法在時間內優雅關閉,強制退出');
        process.exit(1);
      }, 10000);
    };

    // 監聽關閉信號
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('❌ 伺服器啟動失敗:', error);
    process.exit(1);
  }
}

// 啟動伺服器
startServer();

// 未捕獲的錯誤處理
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未處理的 Promise 拒絕:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ 未捕獲的例外:', error);
  process.exit(1);
});

module.exports = app;