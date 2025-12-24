// routes/conversation/conversations.js

const express = require('express');
const router = express.Router();
const { validateRequired, validateAccount } = require('../../middleware/validation');
const { asyncHandler } = require('../../middleware/errorHandler');
const ConversationService = require('../../services/conversationService');

module.exports = (pool, schemaName) => {
  const conversationService = new ConversationService(pool, schemaName);

  /**
   * GET /api/conversations/:account
   * 取得某個用戶的所有對話列表
   */
  router.get('/:account',
    validateAccount,
    asyncHandler(async (req, res) => {
      const { account } = req.params;
      
      const conversations = await conversationService.getConversations(account);
      
      res.json({
        success: true,
        conversations: conversations.map(row => ({
          conversationId: row.conversation_id,
          userAccount: row.user_account,
          contactAccount: row.contact_account,
          contactName: row.contact_name,
          lastMessage: row.last_message,
          lastMessageTime: row.last_message_time,
          unreadCount: row.unread_count,
          updatedAt: row.updated_at
        }))
      });
    })
  );

  /**
   * DELETE /api/conversations
   * 刪除對話
   */
  router.delete('/',
    validateRequired(['userAccount', 'contactAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { userAccount, contactAccount } = req.query;
      
      await conversationService.deleteConversation(userAccount, contactAccount);
      
      res.json({ success: true });
    })
  );

  /**
   * GET /api/conversations/unread/count/:account
   * 取得未讀訊息總數
   */
  router.get('/unread/count/:account',
    validateAccount,
    asyncHandler(async (req, res) => {
      const { account } = req.params;
      
      const count = await conversationService.getUnreadCount(account);
      
      res.json({
        success: true,
        count
      });
    })
  );

  return router;
};