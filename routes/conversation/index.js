// routes/conversation/index.js

const express = require('express');
const router = express.Router();

module.exports = (pool, schemaName) => {
  // 引入子路由
  const conversationsRouter = require('./conversations')(pool, schemaName);
  const messagesRouter = require('./messages')(pool, schemaName);
  const usersRouter = require('./users')(pool, schemaName);
  const groupsRouter = require('./groups')(pool, schemaName);
  const groupMessagesRouter = require('./groupMessages')(pool, schemaName);

  // 掛載子路由
  router.use('/conversations', conversationsRouter);
  router.use('/messages', messagesRouter);
  router.use('/users', usersRouter);
  router.use('/groups', groupsRouter);
  router.use('/groups', groupMessagesRouter);

  // 測試資料庫連線
  router.get('/test', async (req, res) => {
    try {
      const result = await pool.query('SELECT NOW()');
      res.json({ 
        success: true, 
        message: 'Database connected',
        time: result.rows[0].now
      });
    } catch (error) {
      console.error('Database connection error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Database connection failed' 
      });
    }
  });

  return router;
};