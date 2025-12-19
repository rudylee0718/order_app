// routes/login.js

const express = require('express');
const multer = require('multer');
const supabase = require('./supabase');
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();



// 設定圖片上傳
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'images');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'img-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
async function uploadToSupabase(file) {
  const ext = path.extname(file.originalname);
  const fileName = `img_${Date.now()}${ext}`;
  const filePath = `messages/${fileName}`;

  const { error } = await supabase.storage
    .from('chat-images')
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage
    .from('chat-images')
    .getPublicUrl(filePath);

  return data.publicUrl;
}
// const upload = multer({
//   storage: storage,
//   limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
//   fileFilter: (req, file, cb) => {
//     const allowedTypes = /jpeg|jpg|png|gif|webp/;
//     const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
//     const mimetype = allowedTypes.test(file.mimetype);
    
//     if (mimetype && extname) {
//       return cb(null, true);
//     } else {
//       cb(new Error('只允許上傳圖片檔案'));
//     }
//   }
// });

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

// GET /api/conversations/:account
// 取得某個用戶的所有對話列表
router.get('/conversations/:account', async (req, res) => {
  const { account } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        c.conversation_id,
        c.user_account,
        c.contact_account,
        c.last_message,
        c.last_message_time,
        c.unread_count,
        c.updated_at,
        a.description as contact_name
      FROM ${schemaName}.conversations c
      LEFT JOIN ${schemaName}.accounts a ON c.contact_account = a.account
      WHERE c.user_account = $1
      ORDER BY c.last_message_time DESC
    `, [account]);
    
    res.json({
      success: true,
      conversations: result.rows.map(row => ({
        conversationId: row.conversation_id,
        userAccount: row.user_account,
        contactAccount: row.contact_account,
        contactName: row.contact_name,
        contactAvatar: row.contact_avatar,
        lastMessage: row.last_message,
        lastMessageTime: row.last_message_time,
        unreadCount: row.unread_count,
        updatedAt: row.updated_at
      }))
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
})

// 搜尋用戶(排除自己)
router.get('/users/search', async (req, res) => {
  const { q, excludeAccount } = req.query;
  
  if (!q) {
    return res.status(400).json({ success: false, error: 'Missing query parameter' });
  }
  
  try {
    const result = await pool.query(`
      SELECT 
        account,
        description
      FROM ${schemaName}.accounts
      WHERE (account ILIKE $1 OR description ILIKE $1)
        AND account != $2
      ORDER BY description
      LIMIT 20
    `, [`%${q}%`, excludeAccount || '']);
    
    res.json({
      success: true,
      users: result.rows.map(row => ({
        account: row.account,
        name: row.description,
      }))
    });
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/messages', async (req, res) => {
  const { account1, account2 } = req.query;
  
  if (!account1 || !account2) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 查詢訊息及回覆資訊
    const messagesResult = await client.query(`
      SELECT 
        m.message_id,
        m.sender_account,
        m.receiver_account,
        m.message,
        m.message_type,
        m.image_url,
        m.thumbnail_url,
        m.reply_to_message_id,
        m.timestamp,
        m.is_read,
        m.read_at,
        rm.message as reply_to_message,
        rm.sender_account as reply_to_sender,
        ru.description as reply_to_sender_name
      FROM ${schemaName}.messages m
      LEFT JOIN ${schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN ${schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE (m.sender_account = $1 AND m.receiver_account = $2)
         OR (m.sender_account = $2 AND m.receiver_account = $1)
      ORDER BY m.timestamp ASC
    `, [account1, account2]);
    
    // 標記訊息為已讀並設定讀取時間
    await client.query(`
      UPDATE ${schemaName}.messages
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
      WHERE receiver_account = $1 
        AND sender_account = $2 
        AND is_read = FALSE
    `, [account1, account2]);
    
    // 清除未讀數量
    await client.query(`
      UPDATE ${schemaName}.conversations
      SET unread_count = 0
      WHERE user_account = $1 
        AND contact_account = $2
    `, [account1, account2]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      messages: messagesResult.rows.map(row => ({
        messageId: row.message_id,
        senderAccount: row.sender_account,
        receiverAccount: row.receiver_account,
        message: row.message,
        messageType: row.message_type,
        imageUrl: row.image_url,
        thumbnailUrl: row.thumbnail_url,
        replyToMessageId: row.reply_to_message_id,
        replyToMessage: row.reply_to_message,
        replyToSender: row.reply_to_sender,
        replyToSenderName: row.reply_to_sender_name,
        timestamp: row.timestamp,
        isRead: row.is_read,
        readAt: row.read_at
      }))
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/messages/:messageId
// 取得單一訊息詳情
router.get('/messages/:messageId', async (req, res) => {
  const { messageId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        m.*,
        su.description as sender_name,
        ru.description as receiver_name
      FROM ${schemaName}.messages m
      JOIN ${schemaName}.accounts su ON m.sender_account = su.account
      JOIN ${schemaName}.accounts ru ON m.receiver_account = ru.account
      WHERE m.message_id = $1
    `, [messageId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    
    const row = result.rows[0];
    res.json({
      success: true,
      message: {
        messageId: row.message_id,
        senderAccount: row.sender_account,
        senderName: row.sender_name,
        receiverAccount: row.receiver_account,
        receiverName: row.receiver_name,
        message: row.message,
        messageType: row.message_type,
        imageUrl: row.image_url,
        thumbnailUrl: row.thumbnail_url,
        timestamp: row.timestamp,
        isRead: row.is_read,
        readAt: row.read_at
      }
    });
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/messages/send
// 發送文字訊息
router.post('/messages/send', async (req, res) => {
  const { senderAccount, receiverAccount, message, messageType, replyToMessageId } = req.body;
  
  if (!senderAccount || !receiverAccount || (!message && messageType !== 'image')) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const type = messageType || 'text';
    
    // ✅ 插入訊息並立即返回 timestamp
    const result = await client.query(`
      INSERT INTO ${schemaName}.messages (
        message_id, sender_account, receiver_account, 
        message, message_type, reply_to_message_id, timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING timestamp
    `, [messageId, senderAccount, receiverAccount, message, type, replyToMessageId || null]);
    
    const messageTime = result.rows[0].timestamp;
    
    // 更新對話記錄
    await updateConversations(client, senderAccount, receiverAccount, message, messageTime);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      messageId: messageId,
      timestamp: messageTime
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/messages/send-image
// 上傳並發送圖片訊息
// router.post('/messages/send-image', upload.single('image'), async (req, res) => {
//   const { senderAccount, receiverAccount, message, messageType, replyToMessageId, timestamp } = req.body;
  
//   if (!senderAccount || !receiverAccount || !req.file) {
//     return res.status(400).json({ success: false, error: 'Missing parameters' });
//   }
  
//   const client = await pool.connect();
  
//   try {
//     await client.query('BEGIN');
    
//     const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
//     const messageTime = timestamp || new Date().toISOString();
    
//     // 圖片 URL (實際應用中應該使用 CDN 或雲端儲存)
//     const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
//     const imageUrl = `${baseUrl}/uploads/images/${req.file.filename}`;
//     const thumbnailUrl = imageUrl; // 實際應用中應該生成縮圖
    
//     const displayMessage = message || '傳送了一張圖片';
    
//     // 插入訊息
//     await client.query(`
//       INSERT INTO ${schemaName}.messages (
//         message_id, sender_account, receiver_account, 
//         message, message_type, image_url, thumbnail_url,
//         reply_to_message_id, timestamp
//       )
//       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//     `, [
//       messageId, senderAccount, receiverAccount, 
//       displayMessage, 'image', imageUrl, thumbnailUrl,
//       replyToMessageId || null, messageTime
//     ]);
    
//     // 更新對話記錄
//     await updateConversations(client, senderAccount, receiverAccount, displayMessage, messageTime);
    
//     await client.query('COMMIT');
    
//     res.json({
//       success: true,
//       messageId: messageId,
//       imageUrl: imageUrl
//     });
//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('Error sending image message:', error);
//     res.status(500).json({ success: false, error: 'Internal server error' });
//   } finally {
//     client.release();
//   }
// });
router.post(
  '/messages/send-image',
  upload.single('image'),
  async (req, res) => {
    const { senderAccount, receiverAccount } = req.body;
    
    if (!senderAccount || !receiverAccount || !req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 上傳到 Supabase
      const imageUrl = await uploadToSupabase(req.file);
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // ✅ 插入訊息並立即返回 timestamp
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
          message_id, sender_account, receiver_account,
          message_type, image_url, timestamp
        )
        VALUES ($1, $2, $3, 'image', $4, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [messageId, senderAccount, receiverAccount, imageUrl]);
      
      const messageTime = result.rows[0].timestamp;

      await updateConversations(
        client,
        senderAccount,
        receiverAccount,
        '傳送了一張圖片',
        messageTime
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        messageId: messageId,
        imageUrl: imageUrl,
        timestamp: messageTime
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error sending image message:', err);
      res.status(500).json({ 
        success: false, 
        error: err.message 
      });
    } finally {
      client.release();
    }
  }
);
// 更新對話記錄的輔助函數
async function updateConversations(client, senderAccount, receiverAccount, message, messageTime) {
  // 更新或創建發送者的對話記錄
  await client.query(`
    INSERT INTO ${schemaName}.conversations (
      conversation_id, user_account, contact_account, last_message, last_message_time, unread_count
    )
    VALUES ($1, $2, $3, $4, $5, 0)
    ON CONFLICT (user_account, contact_account) 
    DO UPDATE SET
      last_message = EXCLUDED.last_message,
      last_message_time = EXCLUDED.last_message_time,
      updated_at = CURRENT_TIMESTAMP
  `, [
    `conv_${senderAccount}_${receiverAccount}`,
    senderAccount,
    receiverAccount,
    message,
    messageTime
  ]);
  
  // 更新或創建接收者的對話記錄 (未讀數量 +1)
  await client.query(`
    INSERT INTO ${schemaName}.conversations (
      conversation_id, user_account, contact_account, last_message, last_message_time, unread_count
    )
    VALUES ($1, $2, $3, $4, $5, 1)
    ON CONFLICT (user_account, contact_account) 
    DO UPDATE SET
      last_message = EXCLUDED.last_message,
      last_message_time = EXCLUDED.last_message_time,
      unread_count = conversations.unread_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `, [
    `conv_${receiverAccount}_${senderAccount}`,
    receiverAccount,
    senderAccount,
    message,
    messageTime
  ]);
}

// PUT /api/messages/read
// 標記訊息為已讀
router.put('/messages/read', async (req, res) => {
  const { userAccount, contactAccount, readAt } = req.body;
  
  if (!userAccount || !contactAccount) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const client = await pool.connect();
  const readTime = readAt || new Date().toISOString();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      UPDATE ${schemaName}.messages
      SET is_read = TRUE, read_at = $3
      WHERE receiver_account = $1 
        AND sender_account = $2 
        AND is_read = FALSE
    `, [userAccount, contactAccount, readTime]);
    
    await client.query(`
      UPDATE ${schemaName}.conversations
      SET unread_count = 0
      WHERE user_account = $1 
        AND contact_account = $2
    `, [userAccount, contactAccount]);
    
    await client.query('COMMIT');
    
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error marking messages as read:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/conversations
router.delete('/conversations', async (req, res) => {
  const { userAccount, contactAccount } = req.query;
  
  if (!userAccount || !contactAccount) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      DELETE FROM ${schemaName}.conversations
      WHERE user_account = $1 AND contact_account = $2
    `, [userAccount, contactAccount]);
    
    await client.query(`
      DELETE FROM ${schemaName}.messages
      WHERE (sender_account = $1 AND receiver_account = $2)
         OR (sender_account = $2 AND receiver_account = $1)
    `, [userAccount, contactAccount]);
    
    await client.query('COMMIT');
    
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting conversation:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/messages/unread/count/:account
router.get('/messages/unread/count/:account', async (req, res) => {
  const { account } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT COALESCE(SUM(unread_count), 0) as total_unread
      FROM ${schemaName}.conversations
      WHERE user_account = $1
    `, [account]);
    
    res.json({
      success: true,
      count: parseInt(result.rows[0].total_unread)
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

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
  // 返回 router 物件
  return router;
};