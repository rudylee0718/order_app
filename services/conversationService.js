// services/conversationService.js

const { generateConversationId } = require('../utils/idGenerator');

/**
 * 對話服務 - 處理對話相關的業務邏輯
 */
class ConversationService {
  constructor(pool, schemaName) {
    this.pool = pool;
    this.schemaName = schemaName;
  }

  /**
   * 更新或創建個人對話記錄
   * @param {Object} client - PostgreSQL 客戶端
   * @param {string} senderAccount - 發送者帳號
   * @param {string} receiverAccount - 接收者帳號
   * @param {string} message - 訊息內容
   * @param {Date} messageTime - 訊息時間
   */
  async updateConversations(client, senderAccount, receiverAccount, message, messageTime) {
    // 更新或創建發送者的對話記錄
    await client.query(`
      INSERT INTO ${this.schemaName}.conversations (
        conversation_id, user_account, contact_account, 
        last_message, last_message_time, unread_count
      )
      VALUES ($1, $2, $3, $4, $5, 0)
      ON CONFLICT (user_account, contact_account) 
      DO UPDATE SET
        last_message = EXCLUDED.last_message,
        last_message_time = EXCLUDED.last_message_time,
        updated_at = CURRENT_TIMESTAMP
    `, [
      generateConversationId(senderAccount, receiverAccount),
      senderAccount,
      receiverAccount,
      message.substring(0, 100),
      messageTime
    ]);
    
    // 更新或創建接收者的對話記錄 (未讀數量 +1)
    await client.query(`
      INSERT INTO ${this.schemaName}.conversations (
        conversation_id, user_account, contact_account, 
        last_message, last_message_time, unread_count
      )
      VALUES ($1, $2, $3, $4, $5, 1)
      ON CONFLICT (user_account, contact_account) 
      DO UPDATE SET
        last_message = EXCLUDED.last_message,
        last_message_time = EXCLUDED.last_message_time,
        unread_count = ${this.schemaName}.conversations.unread_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `, [
      generateConversationId(receiverAccount, senderAccount),
      receiverAccount,
      senderAccount,
      message.substring(0, 100),
      messageTime
    ]);
  }

  /**
   * 更新群組對話摘要
   * @param {Object} client - PostgreSQL 客戶端
   * @param {string} groupId - 群組 ID
   * @param {string} lastMessage - 最後訊息
   * @param {Date} messageTime - 訊息時間
   */
  async updateGroupConversations(client, groupId, lastMessage, messageTime) {
    try {
      const { generateGroupConversationId } = require('../utils/idGenerator');

      // 取得群組所有成員
      const membersResult = await client.query(
        `SELECT user_account FROM ${this.schemaName}.group_members WHERE group_id = $1`,
        [groupId]
      );

      // 為每個成員更新或插入對話摘要
      for (const member of membersResult.rows) {
        await client.query(`
          INSERT INTO ${this.schemaName}.group_conversations (
            conversation_id, group_id, user_account, 
            last_message, last_message_time, unread_count, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 1, $6)
          ON CONFLICT (group_id, user_account) 
          DO UPDATE SET
            last_message = EXCLUDED.last_message,
            last_message_time = EXCLUDED.last_message_time,
            unread_count = ${this.schemaName}.group_conversations.unread_count + 1,
            updated_at = EXCLUDED.updated_at
        `, [
          generateGroupConversationId(),
          groupId,
          member.user_account,
          lastMessage.substring(0, 100),
          messageTime,
          messageTime
        ]);
      }
    } catch (error) {
      console.error('❌ Error updating group conversations:', error);
      throw error;
    }
  }

  /**
   * 取得用戶的對話列表
   * @param {string} account - 用戶帳號
   * @returns {Promise<Array>} 對話列表
   */
  async getConversations(account) {
    const result = await this.pool.query(`
      SELECT 
        c.conversation_id,
        c.user_account,
        c.contact_account,
        c.last_message,
        c.last_message_time,
        c.unread_count,
        c.updated_at,
        a.description as contact_name
      FROM ${this.schemaName}.conversations c
      LEFT JOIN ${this.schemaName}.accounts a ON c.contact_account = a.account
      WHERE c.user_account = $1
      ORDER BY c.last_message_time DESC
    `, [account]);
    
    return result.rows;
  }

  /**
   * 刪除對話
   * @param {string} userAccount - 用戶帳號
   * @param {string} contactAccount - 聯絡人帳號
   */
  async deleteConversation(userAccount, contactAccount) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(`
        DELETE FROM ${this.schemaName}.conversations
        WHERE user_account = $1 AND contact_account = $2
      `, [userAccount, contactAccount]);
      
      await client.query(`
        DELETE FROM ${this.schemaName}.messages
        WHERE (sender_account = $1 AND receiver_account = $2)
           OR (sender_account = $2 AND receiver_account = $1)
      `, [userAccount, contactAccount]);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 標記訊息為已讀
   * @param {string} userAccount - 用戶帳號
   * @param {string} contactAccount - 聯絡人帳號
   */
  async markAsRead(userAccount, contactAccount) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE ${this.schemaName}.messages
        SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
        WHERE receiver_account = $1 
          AND sender_account = $2 
          AND is_read = FALSE
      `, [userAccount, contactAccount]);
      
      await client.query(`
        UPDATE ${this.schemaName}.conversations
        SET unread_count = 0
        WHERE user_account = $1 
          AND contact_account = $2
      `, [userAccount, contactAccount]);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 取得未讀訊息總數
   * @param {string} account - 用戶帳號
   * @returns {Promise<number>} 未讀訊息數量
   */
  async getUnreadCount(account) {
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(unread_count), 0) as total_unread
      FROM ${this.schemaName}.conversations
      WHERE user_account = $1
    `, [account]);
    
    return parseInt(result.rows[0].total_unread);
  }
}

module.exports = ConversationService;