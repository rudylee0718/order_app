// routes/conversation/messages.js

const express = require('express');
const router = express.Router();
const { singleUpload, multiUpload } = require('../../config/upload');
const { validateRequired, validateFileUpload, validateAccount, validateMessage } = require('../../middleware/validation');
const { asyncHandler } = require('../../middleware/errorHandler');
const MessageService = require('../../services/messageService');
const ConversationService = require('../../services/conversationService');

module.exports = (pool, schemaName) => {
  const messageService = new MessageService(pool, schemaName);
  const conversationService = new ConversationService(pool, schemaName);

  /**
   * GET /api/messages
   * 取得兩個用戶之間的訊息
   */
  router.get('/', 
    validateRequired(['account1', 'account2']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { account1, account2 } = req.query;
      
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // 取得訊息
        const messages = await messageService.getMessages(account1, account2);
        
        // 標記為已讀
        await conversationService.markAsRead(account1, account2);
        
        await client.query('COMMIT');
        
        res.json({
          success: true,
          messages: messages.map(msg => ({
            messageId: msg.message_id,
            senderAccount: msg.sender_account,
            receiverAccount: msg.receiver_account,
            message: msg.message,
            messageType: msg.message_type,
            imageUrl: msg.image_url,
            thumbnailUrl: msg.thumbnail_url,
            imageCount: msg.image_count || 0,
            images: msg.images || [],
            replyToMessageId: msg.reply_to_message_id,
            replyToMessage: msg.reply_to_message,
            replyToSender: msg.reply_to_sender,
            replyToSenderName: msg.reply_to_sender_name,
            timestamp: msg.timestamp,
            isRead: msg.is_read,
            readAt: msg.read_at
          }))
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
   * POST /api/messages/send
   * 發送文字訊息
   */
  router.post('/send',
    validateRequired(['senderAccount', 'receiverAccount', 'message']),
    validateAccount,
    validateMessage,
    asyncHandler(async (req, res) => {
      const { senderAccount, receiverAccount, message, messageType, replyToMessageId } = req.body;
      
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // 發送訊息
        const result = await messageService.sendTextMessage(
          senderAccount, 
          receiverAccount, 
          message, 
          messageType || 'text',
          replyToMessageId
        );
        
        // 更新對話記錄
        await conversationService.updateConversations(
          client,
          senderAccount,
          receiverAccount,
          message,
          result.timestamp
        );
        
        await client.query('COMMIT');
        
        res.json({
          success: true,
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
   * POST /api/messages/send-image
   * 發送單張圖片訊息
   */
  router.post('/send-image',
    singleUpload.single('image'),
    validateRequired(['senderAccount', 'receiverAccount']),
    validateFileUpload(true),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { senderAccount, receiverAccount, replyToMessageId } = req.body;
      
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // 發送圖片訊息
        const result = await messageService.sendImageMessage(
          senderAccount,
          receiverAccount,
          req.file,
          '',
          replyToMessageId
        );
        
        // 更新對話記錄
        await conversationService.updateConversations(
          client,
          senderAccount,
          receiverAccount,
          '傳送了一張圖片',
          result.timestamp
        );
        
        await client.query('COMMIT');
        
        res.json({
          success: true,
          messageId: result.messageId,
          imageUrl: result.imageUrl,
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
   * POST /api/messages/send-multi-images
   * 發送多張圖片訊息
   */
  router.post('/send-multi-images',
    multiUpload.array('images', 9),
    validateRequired(['senderAccount', 'receiverAccount']),
    validateFileUpload(true),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { senderAccount, receiverAccount, message, replyToMessageId } = req.body;
      
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // 發送多圖訊息
        const result = await messageService.sendMultiImageMessage(
          senderAccount,
          receiverAccount,
          req.files,
          message,
          replyToMessageId
        );
        
        // 更新對話記錄
        await conversationService.updateConversations(
          client,
          senderAccount,
          receiverAccount,
          result.message || `[${result.imageCount} 張圖片]`,
          result.timestamp
        );
        
        await client.query('COMMIT');
        
        res.json({
          success: true,
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
   * PUT /api/messages/read
   * 標記訊息為已讀
   */
  router.put('/read',
    validateRequired(['userAccount', 'contactAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { userAccount, contactAccount } = req.body;
      
      await conversationService.markAsRead(userAccount, contactAccount);
      
      res.json({ success: true });
    })
  );

  /**
   * GET /api/messages/:messageId/images
   * 取得訊息的所有圖片
   */
  router.get('/:messageId/images',
    asyncHandler(async (req, res) => {
      const { messageId } = req.params;
      
      const images = await messageService.getMessageImages(messageId);
      
      res.json({
        success: true,
        images
      });
    })
  );

  return router;
};