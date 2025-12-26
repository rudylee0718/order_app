// services/messageService.js

const { generateMessageId, generateImageId } = require('../utils/idGenerator');
const { uploadImageToSupabase, uploadMultipleImagesToSupabase } = require('../utils/supabase');

/**
 * 訊息服務 - 處理訊息相關的業務邏輯
 */
class MessageService {
  constructor(pool, schemaName) {
    this.pool = pool;
    this.schemaName = schemaName;
  }

  /**
   * 取得兩個用戶之間的訊息
   * @param {string} account1 - 帳號1
   * @param {string} account2 - 帳號2
   * @returns {Promise<Array>} 訊息列表
   */
  async getMessages(account1, account2) {
    const result = await this.pool.query(`
      SELECT 
        m.message_id,
        m.sender_account,
        m.receiver_account,
        m.message,
        m.message_type,
        m.image_url,
        m.thumbnail_url,
        m.image_count,
        m.reply_to_message_id,
        m.timestamp,
        m.is_read,
        m.read_at,
        rm.message as reply_to_message,
        m.image_url as reply_to_image_url,
        rm.sender_account as reply_to_sender,
        ru.description as reply_to_sender_name
      FROM ${this.schemaName}.messages m
      LEFT JOIN ${this.schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN ${this.schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE (m.sender_account = $1 AND m.receiver_account = $2)
         OR (m.sender_account = $2 AND m.receiver_account = $1)
      ORDER BY m.timestamp ASC
    `, [account1, account2]);

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
   * 發送文字訊息
   * @param {string} senderAccount - 發送者帳號
   * @param {string} receiverAccount - 接收者帳號
   * @param {string} message - 訊息內容
   * @param {string} messageType - 訊息類型
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendTextMessage(senderAccount, receiverAccount, message, messageType = 'text', replyToMessageId = null) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const messageId = generateMessageId();
      
      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, receiver_account, 
          message, message_type, reply_to_message_id, timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [messageId, senderAccount, receiverAccount, message, messageType, replyToMessageId]);
      
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
   * 發送單張圖片訊息
   * @param {string} senderAccount - 發送者帳號
   * @param {string} receiverAccount - 接收者帳號
   * @param {Object} file - 圖片檔案
   * @param {string} message - 附加訊息
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendImageMessage(senderAccount, receiverAccount, file, message = '', replyToMessageId = null) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // 上傳圖片到 Supabase
      const imageUrl = await uploadImageToSupabase(file);
      const messageId = generateMessageId();
      
      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, receiver_account,
          message_type, image_url, timestamp
        )
        VALUES ($1, $2, $3, 'image', $4, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [messageId, senderAccount, receiverAccount, imageUrl]);
      
      const timestamp = result.rows[0].timestamp;
      
      await client.query('COMMIT');
      
      return {
        messageId,
        imageUrl,
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
   * 發送多張圖片訊息
   * @param {string} senderAccount - 發送者帳號
   * @param {string} receiverAccount - 接收者帳號
   * @param {Array} files - 圖片檔案陣列
   * @param {string} message - 附加訊息
   * @param {string} replyToMessageId - 回覆的訊息 ID
   * @returns {Promise<Object>} 訊息資訊
   */
  async sendMultiImageMessage(senderAccount, receiverAccount, files, message = '', replyToMessageId = null) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // 批次上傳圖片到 Supabase
      const imageUrls = await uploadMultipleImagesToSupabase(files);
      const messageId = generateMessageId();
      const displayMessage = message || `[${imageUrls.length} 張圖片]`;
      
      // 插入訊息
      const result = await client.query(`
        INSERT INTO ${this.schemaName}.messages (
          message_id, sender_account, receiver_account,
          message, message_type, image_url, reply_to_message_id, timestamp
        )
        VALUES ($1, $2, $3, $4, 'multi_image', $5, $6, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [
        messageId, 
        senderAccount, 
        receiverAccount, 
        displayMessage,
        JSON.stringify(imageUrls),
        replyToMessageId
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
   * 取得訊息的所有圖片
   * @param {string} messageId - 訊息 ID
   * @returns {Promise<Array>} 圖片列表
   */
  async getMessageImages(messageId) {
    const result = await this.pool.query(`
      SELECT 
        image_id,
        message_id,
        image_url,
        thumbnail_url,
        image_order
      FROM ${this.schemaName}.message_images
      WHERE message_id = $1
      ORDER BY image_order ASC
    `, [messageId]);

    return result.rows;
  }
}

module.exports = MessageService;