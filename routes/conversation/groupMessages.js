// routes/conversation/groupMessages.js

const express = require('express');
const router = express.Router();
const { singleUpload, multiUpload } = require('../../config/upload');
const { validateRequired, validateFileUpload, validateAccount, validateMessage } = require('../../middleware/validation');
const { asyncHandler } = require('../../middleware/errorHandler');
const GroupMessageService = require('../../services/groupMessageService');
const ConversationService = require('../../services/conversationService');

module.exports = (pool, schemaName) => {
  const groupMessageService = new GroupMessageService(pool, schemaName);
  const conversationService = new ConversationService(pool, schemaName);

  /**
   * GET /api/groups/:groupId/messages
   * 取得群組訊息
   */
  router.get('/:groupId/messages',
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;

      const messages = await groupMessageService.getGroupMessages(groupId);

      res.json({
        success: true,
        messages
      });
    })
  );

  /**
   * POST /api/groups/:groupId/messages/send
   * 發送群組文字訊息
   */
  router.post('/:groupId/messages/send',
    validateRequired(['senderAccount', 'message']),
    validateAccount,
    validateMessage,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { senderAccount, message, messageType = 'text', replyToMessageId } = req.body;

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 發送訊息
        const result = await groupMessageService.sendGroupTextMessage(
          groupId,
          senderAccount,
          message,
          messageType,
          replyToMessageId
        );

        // 更新群組對話摘要
        await conversationService.updateGroupConversations(
          client,
          groupId,
          message,
          result.timestamp
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          message: '訊息發送成功',
          messageId: result.messageId,
          timestamp: result.timestamp
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })
  );

  /**
   * POST /api/groups/:groupId/messages/send-image
   * 發送群組圖片訊息
   */
  router.post('/:groupId/messages/send-image',
    singleUpload.single('image'),
    validateRequired(['senderAccount']),
    validateFileUpload(true),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { senderAccount, message, replyToMessageId } = req.body;

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 發送圖片訊息
        const result = await groupMessageService.sendGroupImageMessage(
          groupId,
          senderAccount,
          req.file,
          message,
          replyToMessageId
        );

        // 更新群組對話摘要
        const displayMessage = message || '傳送了一張圖片';
        await conversationService.updateGroupConversations(
          client,
          groupId,
          displayMessage,
          result.timestamp
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          message: '圖片發送成功',
          messageId: result.messageId,
          imageUrl: result.imageUrl,
          thumbnailUrl: result.thumbnailUrl,
          timestamp: result.timestamp
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })
  );

  /**
   * POST /api/groups/:groupId/messages/send-multi-images
   * 發送群組多圖訊息
   */
  router.post('/:groupId/messages/send-multi-images',
    multiUpload.array('images', 9),
    validateRequired(['senderAccount']),
    validateFileUpload(true),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { senderAccount, message, replyToMessageId } = req.body;

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 發送多圖訊息
        const result = await groupMessageService.sendGroupMultiImageMessage(
          groupId,
          senderAccount,
          req.files,
          message,
          replyToMessageId
        );

        // 更新群組對話摘要
        const displayMessage = message || `[${result.imageCount} 張圖片]`;
        await conversationService.updateGroupConversations(
          client,
          groupId,
          displayMessage,
          result.timestamp
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          message: '圖片發送成功',
          messageId: result.messageId,
          imageUrls: result.imageUrls,
          imageCount: result.imageCount,
          timestamp: result.timestamp
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })
  );

  /**
   * PUT /api/groups/:groupId/messages/read
   * 標記群組訊息為已讀
   */
  router.put('/:groupId/messages/read',
    validateRequired(['userAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { userAccount } = req.body;

      await groupMessageService.markGroupMessagesAsRead(groupId, userAccount);

      res.json({
        success: true,
        message: '已標記為已讀'
      });
    })
  );

  return router;
};