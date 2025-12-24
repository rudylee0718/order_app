// config/database.js

const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

/**
 * PostgreSQL 連線池配置
 */
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

/**
 * 測試資料庫連線
 */
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ 成功連接到 PostgreSQL 資料庫！');
    client.release();
    return true;
  } catch (err) {
    console.error('❌ 資料庫連線失敗：', err.stack);
    return false;
  }
}

/**
 * 優雅關閉連線池
 */
async function closePool() {
  try {
    await pool.end();
    console.log('🔒 資料庫連線池已關閉');
  } catch (err) {
    console.error('❌ 關閉連線池時發生錯誤：', err);
  }
}

module.exports = {
  pool,
  testConnection,
  closePool
};