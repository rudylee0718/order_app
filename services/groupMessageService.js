// services/groupMessageService.js

const { generateMessageId } = require('../utils/idGenerator');
const { uploadImageToSupabase, uploadMultipleImagesToSupabase } = require('../utils/supabase');

/**
 * 群組訊息服務 - 處理群組訊息相關的業務邏輯
 */
class GroupMessageService {
  constructor(pool, schemaName) {
    this.pool = pool;
    this.schemaName = schemaName;
  }

  /**
   * 取得群組訊息
   * @param {string} groupId - 群組 ID
   * @returns {Promise<Array>} 訊息列表
   */
  async getGroupMessages(groupId) {
    const result = await this.pool.query(`
      SELECT 
        m.message_id,
        m.sender_account,
        m.message,
        m.message_type,
        m.image_url,
        m.thumbnail_url,
        m.image_count,
        m.reply_to_message_id,
        m.timestamp,
        m.group_id,
        m.is_group_message,
        u.description as sender_name,
        rm.message as reply_to_message,
        rm.image_url AS reply_to_image_url,
        ru.description as reply_to_sender_name
      FROM ${this.schemaName}.messages m
      JOIN ${this.schemaName}.accounts u ON m.sender_account = u.account
      LEFT JOIN ${this.schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN ${this.schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE m.group_id = $1 AND m.is_group_message = true
      ORDER BY m.timestamp ASC
    `, [groupId]);

    // 如果有多張圖片,取得圖片列表
    const messagesWithImages = [];
    for (const msg of result.rows) {
      const messageData = { ...msg, images: [] };

      if (msg.image_count > 0) {
        const imagesResult = await this.pool.query(`
          SELECT image_url, thumbnail_url, image_order
          FROM ${this.schemaName}.message_images
          WHERE message_id = $1
          ORDER BY image_order ASC
        `, [msg.message_id]);
        
        messageData.images = imagesResult.rows;
      }

      messagesWithImages.push(messageData);
    }

    return messagesWithImages;
  }

  /**
   * 發送群組文字訊息
   * @param {string} groupId - 群組 ID
   * @param {string} senderAccount - 發送者帳號
   * @param {string} message - 訊息內容
   * @param {string} messageType - 訊息類型
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendGroupTextMessage(groupId, senderAccount, message, messageType = 'text', replyToMessageId = null) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const messageId = generateMessageId();

      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, message, message_type,
          reply_to_message_id, timestamp, group_id, is_group_message
        )
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, true)
        RETURNING timestamp
      `, [
        messageId,
        senderAccount,
        message,
        replyToMessageId ? 'reply' : messageType,
        replyToMessageId,
        groupId
      ]);

      const timestamp = result.rows[0].timestamp;

      await client.query('COMMIT');

      return {
        messageId,
        timestamp
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 發送群組圖片訊息
   * @param {string} groupId - 群組 ID
   * @param {string} senderAccount - 發送者帳號
   * @param {Object} file - 圖片檔案
   * @param {string} message - 附加訊息
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendGroupImageMessage(groupId, senderAccount, file, message = '', replyToMessageId = null) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 上傳圖片到 Supabase
      const imageUrl = await uploadImageToSupabase(file);
      const messageId = generateMessageId();
      const displayMessage = message || '';

      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, message, message_type,
          image_url, thumbnail_url, reply_to_message_id,
          timestamp, group_id, is_group_message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8, true)
        RETURNING timestamp
      `, [
        messageId,
        senderAccount,
        displayMessage,
        replyToMessageId ? 'reply' : 'image',
        imageUrl,
        imageUrl,
        replyToMessageId,
        groupId
      ]);

      const timestamp = result.rows[0].timestamp;

      await client.query('COMMIT');

      return {
        messageId,
        imageUrl,
        thumbnailUrl: imageUrl,
        timestamp
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 發送群組多圖訊息
   * @param {string} groupId - 群組 ID
   * @param {string} senderAccount - 發送者帳號
   * @param {Array} files - 圖片檔案陣列
   * @param {string} message - 附加訊息
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendGroupMultiImageMessage(groupId, senderAccount, files, message = '', replyToMessageId = null) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 批次上傳圖片到 Supabase
      const imageUrls = await uploadMultipleImagesToSupabase(files);
      const messageId = generateMessageId();
      const displayMessage = message || `[${imageUrls.length} 張圖片]`;

      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, message, message_type,
          image_url, reply_to_message_id,
          timestamp, group_id, is_group_message
        )
        VALUES ($1, $2, $3, 'multi_image', $4, $5, CURRENT_TIMESTAMP, $6, true)
        RETURNING timestamp
      `, [
        messageId,
        senderAccount,
        displayMessage,
        JSON.stringify(imageUrls),
        replyToMessageId,
        groupId
      ]);

      const timestamp = result.rows[0].timestamp;

      await client.query('COMMIT');

      return {
        messageId,
        imageUrls,
        imageCount: imageUrls.length,
        timestamp
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 標記群組訊息為已讀
   * @param {string} groupId - 群組 ID
   * @param {string} userAccount - 用戶帳號
   */
  async markGroupMessagesAsRead(groupId, userAccount) {
    await this.pool.query(`
      UPDATE ${this.schemaName}.group_conversations
      SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $1 AND user_account = $2
    `, [groupId, userAccount]);
  }
}

module.exports = GroupMessageService;