// ────────────────────────────────────────────────────────────────────────
// 完整取代你原本的 ai.js router
// 兩個端點都改為接收 { systemMessage, history } 而非單一 prompt
// history 格式: [{ role: 'user'|'assistant', content: '...' }, ...]
// ────────────────────────────────────────────────────────────────────────

const express = require('express');
const ollama  = require('ollama').default;

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ── 共用：把前端傳來的 history 組成 Ollama messages ──────────────
  const buildMessages = (systemMessage, history = []) => [
    {
      role: 'system',
      content: systemMessage || '你是一位精通生產管理與 ERP 系統的專業助理，請務必使用繁體中文回答。',
    },
    ...history,   // history 已包含本次 user 訊息（由前端 buildHistory 組好）
  ];

  // ── 1. 非串流 API（fallback 用）───────────────────────────────────
  router.post('/chat', async (req, res, next) => {
    try {
      const { systemMessage, history = [] } = req.body;

      const response = await ollama.chat({
        model: 'llama3:8b',
        messages: buildMessages(systemMessage, history),
        stream: false,
      });

      res.json({ success: true, reply: response.message.content });
    } catch (error) {
      next(error);
    }
  });

  // ── 2. 串流 API（主要使用）───────────────────────────────────────
  router.post('/chat/stream', async (req, res, next) => {
    try {
      const { systemMessage, history = [] } = req.body;

      // SSE Headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const stream = await ollama.chat({
        model: 'llama3:8b',
        messages: buildMessages(systemMessage, history),
        stream: true,
      });

      for await (const chunk of stream) {
        const token = chunk.message?.content ?? '';
        if (token) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      if (!res.headersSent) {
        next(error);
      } else {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      }
    }
  });

  // ── 3. 分析訂單 API（原有功能保留）──────────────────────────────
  router.post('/analyze-order/:orderId', async (req, res, next) => {
    try {
      const { orderId } = req.params;

      const query = `SELECT * FROM ${schemaName}.orders WHERE order_id = $1`;
      const orderResult = await pool.query(query, [orderId]);

      if (orderResult.rows.length === 0) {
        return res.status(404).json({ message: '找不到該訂單' });
      }

      const orderData = JSON.stringify(orderResult.rows[0]);

      const response = await ollama.chat({
        model: 'llama3:8b',
        messages: [
          {
            role: 'system',
            content: '你是一位工廠管理專家，請務必使用繁體中文回答。我會給你 JSON 格式的訂單數據，請幫我總結狀態並給出改善建議。',
          },
          { role: 'user', content: `這是訂單資料：${orderData}` },
        ],
        stream: false,
      });

      res.json({ orderId, analysis: response.message.content });
    } catch (error) {
      next(error);
    }
  });

  return router;
};