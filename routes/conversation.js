// routes/conversation.js

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

// ==================== 輔助函數 ====================

  // 生成唯一 ID
  function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

// ✨ 新增: 取得被回覆訊息的圖片 URL
async function getReplyToImageUrl(client, schemaName, replyToMessageId) {
  if (!replyToMessageId) {
    return null;
  }

  try {
    const result = await client.query(`
      SELECT message_type, image_url 
      FROM ${schemaName}.messages 
      WHERE message_id = $1
    `, [replyToMessageId]);

    if (result.rows.length === 0) {
      return null;
    }

    const originalMsg = result.rows[0];
    
    // ✨ 如果是圖片訊息,返回圖片 URL
    if (originalMsg.message_type === 'image' || 
        originalMsg.message_type === 'multi_image') {
      
      // multi_image 的情況,解析 JSON 取第一張圖
      if (originalMsg.message_type === 'multi_image' && originalMsg.image_url) {
        try {
          const urls = JSON.parse(originalMsg.image_url);
          return urls[0]; // 返回第一張圖片
        } catch (e) {
          return originalMsg.image_url;
        }
      }
      
      return originalMsg.image_url;
    }

    return null;
  } catch (error) {
    console.error('Error getting reply to image URL:', error);
    return null;
  }
}

// 更新群組對話摘要
async function updateGroupConversations(client, schemaName, groupId, lastMessage, messageTime, senderAccount) {
  try {
    // 取得群組所有成員
    const membersResult = await client.query(
      `SELECT user_account FROM ${schemaName}.group_members WHERE group_id = $1`,
      [groupId]
    );

    // 為每個成員更新或插入對話摘要
    for (const member of membersResult.rows) {
      // ✅ 判斷當前成員是否為發送者
      const isSender = member.user_account === senderAccount;
      
      await client.query(`
        INSERT INTO ${schemaName}.group_conversations (
          conversation_id, group_id, user_account, 
          last_message, last_message_time, unread_count, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (group_id, user_account) 
        DO UPDATE SET
          last_message = EXCLUDED.last_message,
          last_message_time = EXCLUDED.last_message_time,
          unread_count = CASE 
            WHEN $8 THEN 0 
            ELSE ${schemaName}.group_conversations.unread_count + 1 
          END,
          updated_at = EXCLUDED.updated_at
      `, [
        generateId('gconv'),
        groupId,
        member.user_account,
        lastMessage.substring(0, 100),
        messageTime,
        isSender ? 0 : 1,  // ✅ 發送者初始未讀數為 0，其他為 1
        messageTime,
        isSender  // ✅ 用於 UPDATE 時的 CASE 判斷
      ]);
    }
  } catch (error) {
    console.error('Error updating group conversations:', error);
    throw error;
  }
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
        a.description as contact_name,
        a.profile_image_url as contact_avatar 
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
        description,
        customer_id,
        profile_image_url  -- ✨ 新增大頭照
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
        accountName: row.description,
        customerId : row.customer_id,
        profileImageUrl: row.profile_image_url, // ✨ 新增
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
        ou.description as sender_name,
        ou.profile_image_url as sender_avatar, 
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
        m.reply_to_image_url ,
        ru.description as reply_to_sender_name,
        ru.profile_image_url as reply_to_sender_avatar
      FROM ${schemaName}.messages m
      LEFT JOIN ${schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN app_order.accounts ou ON m.sender_account = ou.account
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
        senderName:row.sender_name,
        senderAvatar: row.sender_avatar, // ✨ 新增
        receiverAccount: row.receiver_account,
        message: row.message,
        messageType: row.message_type,
        imageUrl: row.image_url,
        thumbnailUrl: row.thumbnail_url,
        replyToMessageId: row.reply_to_message_id,
        replyToMessage: row.reply_to_message,
        replyToSender: row.reply_to_sender,
        replyToSenderName: row.reply_to_sender_name,
        replyToImageUrl : row.reply_to_image_url,
        replyToSenderAvatar: row.reply_to_sender_avatar,
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
    
     // ✨ 取得被回覆訊息的圖片 URL
    const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);   
    // ✅ 插入訊息並立即返回 timestamp
    console.log('📝 發送訊息:', {
      messageId,
      replyToMessageId,
      replyToImageUrl // ✨ 記錄取得的圖片 URL
    });
    
    // ✅ 插入訊息,包含 reply_to_image_url
    const result = await client.query(`
      INSERT INTO ${schemaName}.messages (
        message_id, sender_account, receiver_account, 
        message, message_type, reply_to_message_id, 
        reply_to_image_url, timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      RETURNING timestamp
    `, [
      messageId, senderAccount, receiverAccount, 
      message, type, replyToMessageId || null,
      replyToImageUrl // ✨ 新增欄位
    ]);
    
    const messageTime = result.rows[0].timestamp;
    
    // 更新對話記錄
    await updateConversations(client, senderAccount, receiverAccount, message, messageTime);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      messageId: messageId,
      timestamp: messageTime,
      replyToImageUrl: replyToImageUrl // ✅ 返回給前端
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
    const { senderAccount, receiverAccount, replyToMessageId } = req.body;
    
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

      // ✨ 取得被回覆訊息的圖片 URL
      const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);
      // ✅ 插入訊息
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
          message_id, sender_account, receiver_account,
          message_type, image_url, reply_to_message_id,
          reply_to_image_url, timestamp
        )
        VALUES ($1, $2, $3, 'image', $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [
        messageId, senderAccount, receiverAccount, 
        imageUrl, replyToMessageId || null,
        replyToImageUrl // ✨ 新增
      ]);
      
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
        timestamp: messageTime,
        replyToImageUrl: replyToImageUrl // ✅ 返回
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

    // ✅ 為每則訊息插入已讀記錄
    for (const messageId of messageIds) {
      await client.query(`
        INSERT INTO ${schemaName}.message_read_status (
          read_id, 
          message_id, 
          user_account, 
          read_at
        )
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (message_id, user_account) 
        DO NOTHING
      `, [
        generateId('read'),
        messageId,
        userAccount
      ]);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '已標記為已讀',
      count: messageIds.length
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error marking messages as read:', error);
    res.status(500).json({ 
      success: false, 
      message: '標記已讀失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});
// GET /api/messages/:messageId/read-by
router.get('/messages/:messageId/read-by', async (req, res) => {
  const { messageId } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        mrs.user_account,
        mrs.read_at,
        a.description as user_name,
        a.profile_image_url as user_avatar
      FROM ${schemaName}.message_read_status mrs
      JOIN ${schemaName}.accounts a ON mrs.user_account = a.account
      WHERE mrs.message_id = $1
      ORDER BY mrs.read_at ASC
    `, [messageId]);

    res.json({
      success: true,
      readBy: result.rows.map(row => ({
        userAccount: row.user_account,
        userName: row.user_name,
        userAvatar: row.user_avatar,
        readAt: row.read_at
      })),
      readCount: result.rows.length
    });

  } catch (error) {
    console.error('Error getting message read status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});
// GET /api/messages/:messageId/is-read-by/:userAccount
router.get('/messages/:messageId/is-read-by/:userAccount', async (req, res) => {
  const { messageId, userAccount } = req.params;

  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 
        FROM ${schemaName}.message_read_status
        WHERE message_id = $1 
          AND user_account = $2
      ) as is_read
    `, [messageId, userAccount]);

    res.json({
      success: true,
      isRead: result.rows[0].is_read
    });

  } catch (error) {
    console.error('Error checking read status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});


// GET /api/groups/:groupId/unread-count
router.get('/groups/:groupId/unread-count', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount } = req.query;

  try {
    const result = await pool.query(`
      SELECT COUNT(*) as unread_count
      FROM ${schemaName}.messages m
      WHERE m.group_id = $1
        AND m.is_group_message = true
        AND m.sender_account != $2  -- 排除自己發送的
        AND NOT EXISTS (
          SELECT 1 
          FROM ${schemaName}.message_read_status mrs
          WHERE mrs.message_id = m.message_id
            AND mrs.user_account = $2
        )
    `, [groupId, userAccount]);

    res.json({
      success: true,
      unreadCount: parseInt(result.rows[0].unread_count) || 0
    });

  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
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

// 1. 建立群組
router.post('/groups/create', async (req, res) => {
  const { groupName, createdBy, description, memberAccounts } = req.body;

  if (!groupName || !createdBy) {
    return res.status(400).json({ 
      success: false, 
      message: '群組名稱和創建者為必填' 
    });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const groupId = generateId('group');

    // ✅ 使用 CURRENT_TIMESTAMP 取得 Server 時間
    const result = await client.query(`
      INSERT INTO ${schemaName}.chat_groups (
        group_id, group_name, group_description, 
        created_by, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING created_at
    `, [groupId, groupName, description || null, createdBy]);

    const createdAt = result.rows[0].created_at;

    // 新增創建者為管理員
    await client.query(`
      INSERT INTO ${schemaName}.group_members (member_id, group_id, user_account, role, joined_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [generateId('gm'), groupId, createdBy, 'admin', createdAt]);

    // 新增其他成員
    if (memberAccounts && Array.isArray(memberAccounts)) {
      for (const account of memberAccounts) {
        if (account !== createdBy) {
          await client.query(`
            INSERT INTO ${schemaName}.group_members (member_id, group_id, user_account, role, joined_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [generateId('gm'), groupId, account, 'member', createdAt]);
        }
      }
    }

    // 初始化群組對話摘要
    const allMembers = memberAccounts || [createdBy];
    for (const account of allMembers) {
      await client.query(`
        INSERT INTO ${schemaName}.group_conversations (
          conversation_id, group_id, user_account,
          last_message, last_message_time, unread_count
        )
        VALUES ($1, $2, $3, $4, $5, 0)
      `, [generateId('gconv'), groupId, account, '', createdAt]);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '群組建立成功',
      group: {
        groupId,
        groupName,
        groupDescription: description,
        createdBy,
        createdAt
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating group:', error);
    res.status(500).json({ 
      success: false, 
      message: '建立群組失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 2. 取得用戶所屬的群組列表
router.get('/groups/user/:account', async (req, res) => {
  const { account } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        g.group_id,
        g.group_name,
        g.group_description,
        g.group_avatar_url,
        g.created_by,
        g.created_at,
        g.updated_at,
        gm.role,
        gm.joined_at,
        gc.last_message,
        gc.last_message_time,
        gc.unread_count,
        (SELECT COUNT(*) FROM ${schemaName}.group_members WHERE group_id = g.group_id) as member_count
      FROM ${schemaName}.chat_groups g
      JOIN ${schemaName}.group_members gm ON g.group_id = gm.group_id
      LEFT JOIN ${schemaName}.group_conversations gc ON g.group_id = gc.group_id AND gc.user_account = $1
      WHERE gm.user_account = $1
      ORDER BY gc.updated_at DESC NULLS LAST, g.updated_at DESC
    `, [account]);

    res.json({
      success: true,
      groups: result.rows
    });

  } catch (error) {
    console.error('Error getting user groups:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得群組列表失敗',
      error: error.message 
    });
  }
});

// 3. 取得群組詳情
router.get('/groups/:groupId', async (req, res) => {
  const { groupId } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        g.*,
        u.description as creator_name,
        (SELECT COUNT(*) FROM ${schemaName}.group_members WHERE group_id = g.group_id) as member_count
      FROM ${schemaName}.chat_groups g
      JOIN ${schemaName}.accounts u ON g.created_by = u.account
      WHERE g.group_id = $1
    `, [groupId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: '群組不存在' 
      });
    }

    res.json({
      success: true,
      group: result.rows[0]
    });

  } catch (error) {
    console.error('Error getting group details:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得群組詳情失敗',
      error: error.message 
    });
  }
});

// 4. 取得群組成員列表
router.get('/groups/:groupId/members', async (req, res) => {
  const { groupId } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        gm.member_id,
        gm.group_id,
        gm.user_account,
        gm.role,
        gm.joined_at,
        gm.last_read_message_id,
        u.description as member_name,
        u.customer_id,
        u.profile_image_url as member_avatar
      FROM ${schemaName}.group_members gm
      JOIN ${schemaName}.accounts u ON gm.user_account = u.account
      WHERE gm.group_id = $1
      ORDER BY 
        CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END,
        gm.joined_at ASC
    `, [groupId]);

    res.json({
      success: true,
      members: result.rows
    });

  } catch (error) {
    console.error('Error getting group members:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得群組成員失敗',
      error: error.message 
    });
  }
});

// 5. 新增群組成員
router.post('/groups/:groupId/members/add', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount, role = 'member' } = req.body;

  if (!userAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '用戶帳號為必填' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 檢查用戶是否已在群組中
    const checkResult = await client.query(
      `SELECT * FROM ${schemaName}.group_members WHERE group_id = $1 AND user_account = $2`,
      [groupId, userAccount]
    );

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: '該用戶已在群組中' 
      });
    }

    // ✅ 使用 Server 時間
    const result = await client.query(`
      INSERT INTO ${schemaName}.group_members (member_id, group_id, user_account, role, joined_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING joined_at
    `, [generateId('gm'), groupId, userAccount, role]);

    const joinedAt = result.rows[0].joined_at;

    // 初始化該成員的群組對話摘要
    await client.query(`
      INSERT INTO ${schemaName}.group_conversations (
        conversation_id, group_id, user_account,
        last_message, last_message_time, unread_count
      )
      VALUES ($1, $2, $3, $4, $5, 0)
    `, [generateId('gconv'), groupId, userAccount, '', joinedAt]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '成員新增成功'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding group member:', error);
    res.status(500).json({ 
      success: false, 
      message: '新增成員失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 6. 移除群組成員
router.delete('/groups/:groupId/members/remove', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount } = req.body;

  if (!userAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '用戶帳號為必填' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 檢查是否為創建者
    const groupResult = await client.query(
      `SELECT created_by FROM ${schemaName}.chat_groups WHERE group_id = $1`,
      [groupId]
    );

    if (groupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        message: '群組不存在' 
      });
    }

    if (groupResult.rows[0].created_by === userAccount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: '無法移除群組創建者' 
      });
    }

    // 移除成員
    const deleteResult = await client.query(
      `DELETE FROM ${schemaName}.group_members WHERE group_id = $1 AND user_account = $2`,
      [groupId, userAccount]
    );

    if (deleteResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        message: '該用戶不在群組中' 
      });
    }

    // 刪除該成員的群組對話摘要
    await client.query(
      `DELETE FROM ${schemaName}.group_conversations WHERE group_id = $1 AND user_account = $2`,
      [groupId, userAccount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '成員移除成功'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error removing group member:', error);
    res.status(500).json({ 
      success: false, 
      message: '移除成員失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 7. 退出群組
router.post('/groups/:groupId/leave', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount } = req.body;

  if (!userAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '用戶帳號為必填' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 檢查是否為創建者
    const groupResult = await client.query(
      `SELECT created_by FROM ${schemaName}.chat_groups WHERE group_id = $1`,
      [groupId]
    );

    if (groupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        message: '群組不存在' 
      });
    }

    if (groupResult.rows[0].created_by === userAccount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: '創建者無法退出群組,請先轉移群組或刪除群組' 
      });
    }

    // 移除成員
    await client.query(
      `DELETE FROM ${schemaName}.group_members WHERE group_id = $1 AND user_account = $2`,
      [groupId, userAccount]
    );

    // 刪除對話摘要
    await client.query(
      `DELETE FROM ${schemaName}.group_conversations WHERE group_id = $1 AND user_account = $2`,
      [groupId, userAccount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '已退出群組'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error leaving group:', error);
    res.status(500).json({ 
      success: false, 
      message: '退出群組失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 8. 更新群組資訊
router.put('/groups/:groupId/update', async (req, res) => {
  const { groupId } = req.params;
  const { groupName, description } = req.body;

  try {
    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (groupName) {
      updateFields.push(`group_name = $${paramCount++}`);
      values.push(groupName);
    }

    if (description !== undefined) {
      updateFields.push(`group_description = $${paramCount++}`);
      values.push(description);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: '沒有要更新的欄位' 
      });
    }

    // ✅ 使用 CURRENT_TIMESTAMP
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(groupId);

    await client.query(`
      UPDATE ${schemaName}.chat_groups 
      SET ${updateFields.join(', ')}
      WHERE group_id = $${paramCount}
    `, values);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '群組資訊更新成功'
    });

  } catch (error) {
    console.error('Error updating group info:', error);
    res.status(500).json({ 
      success: false, 
      message: '更新群組資訊失敗',
      error: error.message 
    });
  }
});

// ==================== 群組訊息 API ====================

// 9. 取得群組訊息
router.get('/groups/:groupId/messages', async (req, res) => {
  const { groupId } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        m.message_id,
        m.sender_account,
        m.message,
        m.message_type,
        m.image_url,
        m.thumbnail_url,
        m.reply_to_message_id,
        m.timestamp,
        m.group_id,
        m.is_group_message,
        u.description as sender_name,
        u.profile_image_url as sender_avatar,  
        rm.message as reply_to_message,
        ru.description as reply_to_sender_name,
        m.reply_to_image_url,
        ru.profile_image_url as reply_to_sender_avatar,
        (
          SELECT COUNT(DISTINCT mrs.user_account)
          FROM ${schemaName}.message_read_status mrs
          WHERE mrs.message_id = m.message_id
            AND mrs.user_account != m.sender_account
        ) as read_count 
      FROM ${schemaName}.messages m
      JOIN ${schemaName}.accounts u ON m.sender_account = u.account
      LEFT JOIN ${schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN ${schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE m.group_id = $1 AND m.is_group_message = true
      ORDER BY m.timestamp ASC
    `, [groupId]);

    res.json({
      success: true,
      messages: result.rows
    });

  } catch (error) {
    console.error('Error getting group messages:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得群組訊息失敗',
      error: error.message 
    });
  }
});

// 10. 發送群組文字訊息
router.post('/groups/:groupId/messages/send', async (req, res) => {
  const { groupId } = req.params;
  const { senderAccount, message, messageType = 'text', replyToMessageId } = req.body;

  if (!senderAccount || !message) {
    return res.status(400).json({ 
      success: false, 
      message: '發送者和訊息內容為必填' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const messageId = generateId('msg');
   // ✨ 取得被回覆訊息的圖片 URL
    const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);


    console.log('📝 發送群組訊息:', {
      groupId,
      messageId,
      replyToMessageId,
      replyToImageUrl
    });

    // ✅ 插入訊息,包含 reply_to_image_url
    const result = await client.query(`
      INSERT INTO ${schemaName}.messages (
        message_id, sender_account, message, message_type,
        reply_to_message_id, reply_to_image_url,
        timestamp, group_id, is_group_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, true)
      RETURNING timestamp
    `, [
      messageId,
      senderAccount,
      message,
      replyToMessageId ? 'reply' : messageType,
      replyToMessageId,
      replyToImageUrl, // ✨ 新增
      groupId
    ]);

    const timestamp = result.rows[0].timestamp;

    // 更新群組對話摘要
    await updateGroupConversations(client, schemaName, groupId, message, timestamp,senderAccount);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '訊息發送成功',
      messageId,
      timestamp,
      replyToImageUrl // ✅ 返回
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error sending group message:', error);
    res.status(500).json({ 
      success: false, 
      message: '發送訊息失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});
// 11. 發送群組圖片訊息 (使用 Supabase)
router.post('/groups/:groupId/messages/send-image', upload.single('image'), async (req, res) => {
  const { groupId } = req.params;
  const { senderAccount, message, messageType = 'image', replyToMessageId } = req.body;

  if (!senderAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '發送者為必填' 
    });
  }

  if (!req.file) {
    return res.status(400).json({ 
      success: false, 
      message: '請上傳圖片' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ✅ 上傳圖片到 Supabase
    const imageUrl = await uploadToSupabase(req.file);
    const messageId = generateId('msg');
    const displayMessage = message || '';

    // ✨ 取得被回覆訊息的圖片 URL
    const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);


    // ✅ 插入訊息
    const result = await client.query(`
      INSERT INTO ${schemaName}.messages (
        message_id, sender_account, message, message_type,
        image_url, thumbnail_url, reply_to_message_id,
        reply_to_image_url, timestamp, group_id, is_group_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9, true)
      RETURNING timestamp
    `, [
      messageId,
      senderAccount,
      displayMessage,
      replyToMessageId ? 'reply' : messageType,
      imageUrl,
      imageUrl,
      replyToMessageId,
      replyToImageUrl, // ✨ 新增
      groupId
    ]);

    const timestamp = result.rows[0].timestamp;

    // 更新群組對話摘要
    await updateGroupConversations(client, schemaName, groupId, displayMessage, timestamp,senderAccount);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '圖片發送成功',
      messageId,
      imageUrl,
      thumbnailUrl: imageUrl,
      timestamp,
      replyToImageUrl // ✅ 返回
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error sending group image:', error);
    res.status(500).json({ 
      success: false, 
      message: '發送圖片失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 12. 標記群組訊息為已讀
router.put('/groups/:groupId/messages/read', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount } = req.body;

  if (!userAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '用戶帳號為必填' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ✅ 批次插入已讀記錄（使用 ON CONFLICT 避免重複）
    await client.query(`
      INSERT INTO ${schemaName}.message_read_status (
        read_id, 
        message_id, 
        user_account, 
        read_at
      )
      SELECT 
        CONCAT('read_', m.message_id, '_', $2) as read_id,
        m.message_id,
        $2 as user_account,
        CURRENT_TIMESTAMP
      FROM ${schemaName}.messages m
      WHERE m.group_id = $1 
        AND m.is_group_message = true
        AND m.sender_account != $2  -- ✅ 排除自己發送的訊息
        AND NOT EXISTS (
          -- ✅ 避免重複插入
          SELECT 1 FROM ${schemaName}.message_read_status mrs
          WHERE mrs.message_id = m.message_id 
            AND mrs.user_account = $2
        )
      ON CONFLICT (message_id, user_account) 
      DO NOTHING
    `, [groupId, userAccount]);

    // ✅ 更新 group_conversations 的未讀數
    await client.query(`
      UPDATE ${schemaName}.group_conversations
      SET unread_count = 0, 
          updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $1 
        AND user_account = $2
    `, [groupId, userAccount]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '已標記為已讀'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error marking group messages as read:', error);
    res.status(500).json({ 
      success: false, 
      message: '標記已讀失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 13. 取得群組未讀訊息數量
router.get('/groups/unread/count/:account', async (req, res) => {
  const { account } = req.params;

  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(unread_count), 0) as total_unread FROM ${schemaName}.group_conversations WHERE user_account = $1`,
      [account]
    );

    res.json({
      success: true,
      count: parseInt(result.rows[0].total_unread)
    });

  } catch (error) {
    console.error('Error getting group unread count:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得未讀數量失敗',
      error: error.message 
    });
  }
});

// 14. 搜尋群組
router.get('/groups/search', async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ 
      success: false, 
      message: '請提供搜尋關鍵字' 
    });
  }

  try {
    const result = await pool.query(`
      SELECT 
        g.*,
        (SELECT COUNT(*) FROM ${schemaName}.group_members WHERE group_id = g.group_id) as member_count
      FROM ${schemaName}.chat_groups g
      WHERE g.group_name ILIKE $1
      ORDER BY g.updated_at DESC
      LIMIT 50
    `, [`%${q}%`]);

    res.json({
      success: true,
      groups: result.rows
    });

  } catch (error) {
    console.error('Error searching groups:', error);
    res.status(500).json({ 
      success: false, 
      message: '搜尋群組失敗',
      error: error.message 
    });
  }
});

// ==================== 多圖上傳 API ====================

// 發送多圖訊息 (個人對話)
router.post(
  '/messages/send-images',
  upload.array('images', 9), // 最多9張圖片
  async (req, res) => {
    const { senderAccount, receiverAccount, message, replyToMessageId } = req.body;
    
    if (!senderAccount || !receiverAccount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '請至少上傳一張圖片' 
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const imageCount = req.files.length;
 
      // ✨ 取得被回覆訊息的圖片 URL
      const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);     

      // 上傳所有圖片到 Supabase
      const imageUrls = [];
      for (let i = 0; i < req.files.length; i++) {
        const imageUrl = await uploadToSupabase(req.files[i]);
        imageUrls.push(imageUrl);
      }

      // ✅ 插入訊息
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
          message_id, sender_account, receiver_account,
          message, message_type, image_url, reply_to_message_id,
          reply_to_image_url, timestamp
        )
        VALUES ($1, $2, $3, $4, 'multi_image', $5, $6, $7, CURRENT_TIMESTAMP)
        RETURNING timestamp
      `, [
        messageId, 
        senderAccount, 
        receiverAccount, 
        displayMessage,
        JSON.stringify(imageUrls),
        replyToMessageId || null,
        replyToImageUrl // ✨ 新增
      ]);
      
      const messageTime = result.rows[0].timestamp;

      // 插入圖片關聯資料
      for (let i = 0; i < imageUrls.length; i++) {
        const imageId = `img_${messageId}_${i}`;
        await client.query(`
          INSERT INTO ${schemaName}.message_images (
            image_id, message_id, image_url, thumbnail_url, image_order
          )
          VALUES ($1, $2, $3, $4, $5)
        `, [imageId, messageId, imageUrls[i], imageUrls[i], i]);
      }

      // 更新對話記錄
      const displayMessage = message || `[${imageCount}張圖片]`;
      await updateConversations(
        client,
        senderAccount,
        receiverAccount,
        displayMessage,
        messageTime
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        messageId: messageId,
        imageUrls: imageUrls,
        imageCount: imageCount,
        timestamp: messageTime,
        replyToImageUrl // ✅ 返回
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error sending multiple images:', err);
      res.status(500).json({ 
        success: false, 
        error: err.message 
      });
    } finally {
      client.release();
    }
  }
);

// 發送多圖訊息 (群組對話)
router.post(
  '/groups/:groupId/messages/send-images',
  upload.array('images', 9),
  async (req, res) => {
    const { groupId } = req.params;
    const { senderAccount, message, replyToMessageId } = req.body;

    if (!senderAccount) {
      return res.status(400).json({ 
        success: false, 
        message: '發送者為必填' 
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: '請至少上傳一張圖片' 
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const messageId = generateId('msg');
      const imageCount = req.files.length;
        // ✨ 取得被回覆訊息的圖片 URL
      const replyToImageUrl = await getReplyToImageUrl(client, schemaName, replyToMessageId);    
      // 上傳所有圖片到 Supabase
      const imageUrls = [];
      for (let i = 0; i < req.files.length; i++) {
        const imageUrl = await uploadToSupabase(req.files[i]);
        imageUrls.push(imageUrl);
      }

      // ✅ 插入訊息
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
          message_id, sender_account, message, message_type,
          image_url, reply_to_message_id, reply_to_image_url,
          timestamp, group_id, is_group_message
        )
        VALUES ($1, $2, $3, 'multi_image', $4, $5, $6, CURRENT_TIMESTAMP, $7, true)
        RETURNING timestamp
      `, [
        messageId,
        senderAccount,
        displayMessage,
        JSON.stringify(imageUrls),
        replyToMessageId || null,
        replyToImageUrl, // ✨ 新增
        groupId
      ]);

      const timestamp = result.rows[0].timestamp;

      // 插入圖片關聯資料
      for (let i = 0; i < imageUrls.length; i++) {
        const imageId = `img_${messageId}_${i}`;
        await client.query(`
          INSERT INTO ${schemaName}.message_images (
            image_id, message_id, image_url, thumbnail_url, image_order
          )
          VALUES ($1, $2, $3, $4, $5)
        `, [imageId, messageId, imageUrls[i], imageUrls[i], i]);
      }

      // 更新群組對話摘要
      const displayMessage = message || `[${imageCount}張圖片]`;
      await updateGroupConversations(client, schemaName, groupId, displayMessage, timestamp);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: '圖片發送成功',
        messageId,
        imageUrls,
        imageCount,
        timestamp,
        replyToImageUrl // ✅ 返回
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error sending group images:', error);
      res.status(500).json({ 
        success: false, 
        message: '發送圖片失敗',
        error: error.message 
      });
    } finally {
      client.release();
    }
  }
);

// 取得訊息的所有圖片
router.get('/messages/:messageId/images', async (req, res) => {
  const { messageId } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        image_id,
        message_id,
        image_url,
        thumbnail_url,
        image_order
      FROM ${schemaName}.message_images
      WHERE message_id = $1
      ORDER BY image_order ASC
    `, [messageId]);

    res.json({
      success: true,
      images: result.rows
    });

  } catch (error) {
    console.error('Error getting message images:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// 修改取得訊息的 API,包含圖片資訊
router.get('/messages-with-images', async (req, res) => {
  const { account1, account2 } = req.query;
  
  if (!account1 || !account2) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 查詢訊息
    const messagesResult = await client.query(`
      SELECT 
        m.message_id,
        m.sender_account,
        ou.description as sender_name,
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
        rm.sender_account as reply_to_sender,
        ru.description as reply_to_sender_name
      FROM ${schemaName}.messages m
      LEFT JOIN ${schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN app_order.accounts ou ON m.sender_account = ou.account
      LEFT JOIN ${schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE (m.sender_account = $1 AND m.receiver_account = $2)
         OR (m.sender_account = $2 AND m.receiver_account = $1)
      ORDER BY m.timestamp ASC
    `, [account1, account2]);

    // 為每個訊息取得圖片
    const messagesWithImages = [];
    for (const msg of messagesResult.rows) {
      const messageData = {
        messageId: msg.message_id,
        senderAccount: msg.sender_account,
        senderName:msg.sender_name,
        receiverAccount: msg.receiver_account,
        message: msg.message,
        messageType: msg.message_type,
        imageUrl: msg.image_url,
        thumbnailUrl: msg.thumbnail_url,
        imageCount: msg.image_count || 0,
        replyToMessageId: msg.reply_to_message_id,
        replyToMessage: msg.reply_to_message,
        replyToSender: msg.reply_to_sender,
        replyToSenderName: msg.reply_to_sender_name,
        timestamp: msg.timestamp,
        isRead: msg.is_read,
        readAt: msg.read_at,
        images: []
      };

      // 如果有多張圖片,取得圖片列表
      if (msg.image_count > 0) {
        const imagesResult = await client.query(`
          SELECT image_url, thumbnail_url, image_order
          FROM ${schemaName}.message_images
          WHERE message_id = $1
          ORDER BY image_order ASC
        `, [msg.message_id]);
        
        messageData.images = imagesResult.rows;
      }

      messagesWithImages.push(messageData);
    }
    
    // 標記訊息為已讀
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
      messages: messagesWithImages
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error fetching messages with images:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// 修改群組訊息 API,包含圖片資訊
router.get('/groups/:groupId/messages-with-images', async (req, res) => {
  const { groupId } = req.params;

  try {
    // 查詢訊息
    const messagesResult = await pool.query(`
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
        ru.description as reply_to_sender_name
      FROM ${schemaName}.messages m
      JOIN ${schemaName}.accounts u ON m.sender_account = u.account
      LEFT JOIN ${schemaName}.messages rm ON m.reply_to_message_id = rm.message_id
      LEFT JOIN ${schemaName}.accounts ru ON rm.sender_account = ru.account
      WHERE m.group_id = $1 AND m.is_group_message = true
      ORDER BY m.timestamp ASC
    `, [groupId]);

    // 為每個訊息取得圖片
    const messagesWithImages = [];
    for (const msg of messagesResult.rows) {
      const messageData = {
        message_id: msg.message_id,
        sender_account: msg.sender_account,
        message: msg.message,
        message_type: msg.message_type,
        image_url: msg.image_url,
        thumbnail_url: msg.thumbnail_url,
        image_count: msg.image_count || 0,
        reply_to_message_id: msg.reply_to_message_id,
        timestamp: msg.timestamp,
        group_id: msg.group_id,
        is_group_message: msg.is_group_message,
        sender_name: msg.sender_name,
        reply_to_message: msg.reply_to_message,
        reply_to_sender_name: msg.reply_to_sender_name,
        images: []
      };

      // 如果有多張圖片,取得圖片列表
      if (msg.image_count > 0) {
        const imagesResult = await pool.query(`
          SELECT image_url, thumbnail_url, image_order
          FROM ${schemaName}.message_images
          WHERE message_id = $1
          ORDER BY image_order ASC
        `, [msg.message_id]);
        
        messageData.images = imagesResult.rows;
      }

      messagesWithImages.push(messageData);
    }

    res.json({
      success: true,
      messages: messagesWithImages
    });

  } catch (error) {
    console.error('Error getting group messages with images:', error);
    res.status(500).json({ 
      success: false, 
      message: '取得群組訊息失敗',
      error: error.message 
    });
  }
});
/**
 * GET /api/messages/unread-count/:userAccount
 * 獲取用戶的未讀訊息總數（個人對話 + 群組對話）
 */
router.get('/messages/unread-count/:userAccount', async (req, res) => {
  const { userAccount } = req.params;
  
  try {
    // 1. 獲取個人對話未讀數
    const personalResult = await pool.query(`
      SELECT COALESCE(SUM(unread_count), 0) as count
      FROM ${schemaName}.conversations
      WHERE user_account = $1
    `, [userAccount]);
    
    const personalUnread = parseInt(personalResult.rows[0]?.count) || 0;
    
    // 2. 獲取群組對話未讀數
    const groupResult = await pool.query(`
      SELECT COALESCE(SUM(unread_count), 0) as count
      FROM ${schemaName}.group_conversations
      WHERE user_account = $1
    `, [userAccount]);
    
    const groupUnread = parseInt(groupResult.rows[0]?.count) || 0;
    
    // 3. 計算總未讀數
    const totalUnread = personalUnread + groupUnread;
    
    // console.log(`📊 未讀訊息數 [${userAccount}]:`, {
    //   personal: personalUnread,
    //   group: groupUnread,
    //   total: totalUnread
    // });
    
    res.json({
      success: true,
      unreadCount: totalUnread,
      details: {
        personal: personalUnread,
        group: groupUnread
      }
    });
    
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({
      success: false,
      message: '獲取未讀訊息數失敗',
      error: error.message
    });
  }
});

/**
 * POST /api/messages/mark-read
 * 標記個人對話訊息為已讀
 */
router.post('/messages/mark-read', async (req, res) => {
  const { senderAccount, receiverAccount } = req.body;
  
  if (!senderAccount || !receiverAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '缺少必要參數' 
    });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 標記訊息為已讀
    const updateResult = await client.query(`
      UPDATE ${schemaName}.messages
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
      WHERE sender_account = $1
        AND receiver_account = $2
        AND is_read = FALSE
    `, [senderAccount, receiverAccount]);
    
    // 清除未讀數量
    await client.query(`
      UPDATE ${schemaName}.conversations
      SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE user_account = $1 
        AND contact_account = $2
    `, [receiverAccount, senderAccount]);
    
    await client.query('COMMIT');
    
    console.log(`✅ 標記已讀: ${receiverAccount} ← ${senderAccount}, 更新 ${updateResult.rowCount} 則訊息`);
    
    res.json({
      success: true,
      message: '訊息已標記為已讀',
      updatedCount: updateResult.rowCount
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error marking messages as read:', error);
    res.status(500).json({
      success: false,
      message: '標記已讀失敗',
      error: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/groups/:groupId/messages/mark-read
 * 標記群組對話訊息為已讀
 */
router.post('/groups/:groupId/messages/mark-read', async (req, res) => {
  const { groupId } = req.params;
  const { userAccount } = req.body;
  
  if (!userAccount) {
    return res.status(400).json({ 
      success: false, 
      message: '缺少用戶帳號' 
    });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 批次插入已讀記錄
    const insertResult = await client.query(`
      INSERT INTO ${schemaName}.message_read_status (
        read_id, 
        message_id, 
        user_account, 
        read_at
      )
      SELECT 
        CONCAT('read_', m.message_id, '_', $2::text) as read_id,
        m.message_id,
        $2::text as user_account,
        CURRENT_TIMESTAMP
      FROM ${schemaName}.messages m
      WHERE m.group_id = $1 
        AND m.is_group_message = true
        AND m.sender_account != $2::text
        AND NOT EXISTS (
          SELECT 1 FROM ${schemaName}.message_read_status mrs
          WHERE mrs.message_id = m.message_id 
            AND mrs.user_account = $2::text
        )
      ON CONFLICT (message_id, user_account) 
      DO NOTHING
    `, [groupId, userAccount]);
    
    // 更新群組對話未讀數
    await client.query(`
      UPDATE ${schemaName}.group_conversations
      SET unread_count = 0, 
          updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $1 
        AND user_account = $2
    `, [groupId, userAccount]);
    
    await client.query('COMMIT');
    
    console.log(`✅ 群組已讀: 群組 ${groupId}, 用戶 ${userAccount}, 標記 ${insertResult.rowCount} 則訊息`);
    
    res.json({
      success: true,
      message: '群組訊息已標記為已讀',
      markedCount: insertResult.rowCount
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error marking group messages as read:', error);
    res.status(500).json({
      success: false,
      message: '標記群組訊息已讀失敗',
      error: error.message
    });
  } finally {
    client.release();
  }
});


// ==================== 多張圖片上傳 API ====================

// 個人訊息 - 發送多張圖片
router.post(
  '/messages/send-multi-images',
  upload.array('images', 9), // ✅ 注意:使用 upload.array
  async (req, res) => {
    const { senderAccount, receiverAccount, message, replyToMessageId } = req.body;
    
    console.log('📸 收到多圖上傳請求:', {
      senderAccount,
      receiverAccount,
      fileCount: req.files?.length || 0
    });
    
    if (!senderAccount || !receiverAccount || !req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters or no images uploaded' 
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 上傳所有圖片到 Supabase
      const imageUrls = [];
      for (const file of req.files) {
        console.log('📤 上傳圖片:', file.originalname);
        const imageUrl = await uploadToSupabase(file);
        imageUrls.push(imageUrl);
      }

      console.log('✅ 所有圖片上傳成功:', imageUrls.length);

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      // const displayMessage = message || `[${imageUrls.length} 張圖片]`;
      const displayMessage = message || '';

      // ✅ 插入訊息,將圖片 URLs 儲存為 JSON 陣列
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
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
        JSON.stringify(imageUrls), // ✅ 儲存為 JSON 陣列
        replyToMessageId || null
      ]);
      
      const messageTime = result.rows[0].timestamp;

      await updateConversations(
        client,
        senderAccount,
        receiverAccount,
        displayMessage,
        messageTime,
        senderAccount
      );

      await client.query('COMMIT');

      console.log('✅ 多圖訊息儲存成功:', messageId);

      res.json({
        success: true,
        messageId: messageId,
        imageUrls: imageUrls,
        imageCount: imageUrls.length,
        timestamp: messageTime
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error sending multi images message:', err);
      res.status(500).json({ 
        success: false, 
        error: err.message 
      });
    } finally {
      client.release();
    }
  }
);

// 群組訊息 - 發送多張圖片
router.post(
  '/groups/:groupId/messages/send-multi-images',
  upload.array('images', 9),
  async (req, res) => {
    const { groupId } = req.params;
    const { senderAccount, message, replyToMessageId } = req.body;

    console.log('📸 收到群組多圖上傳請求:', {
      groupId,
      senderAccount,
      fileCount: req.files?.length || 0
    });

    if (!senderAccount || !req.files || req.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: '發送者為必填且至少需要一張圖片' 
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 上傳所有圖片到 Supabase
      const imageUrls = [];
      for (const file of req.files) {
        const imageUrl = await uploadToSupabase(file);
        imageUrls.push(imageUrl);
      }

      const messageId = generateId('msg');
      const displayMessage = message || `[${imageUrls.length} 張圖片]`;

      // ✅ 插入訊息
      const result = await client.query(`
        INSERT INTO ${schemaName}.messages (
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
        replyToMessageId || null,
        groupId
      ]);

      const timestamp = result.rows[0].timestamp;

      // 更新群組對話摘要
      await updateGroupConversations(client, schemaName, groupId, displayMessage, timestamp);

      await client.query('COMMIT');

      console.log('✅ 群組多圖訊息儲存成功:', messageId);

      res.json({
        success: true,
        message: '圖片發送成功',
        messageId,
        imageUrls,
        imageCount: imageUrls.length,
        timestamp
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error sending group multi images:', error);
      res.status(500).json({ 
        success: false, 
        message: '發送圖片失敗',
        error: error.message 
      });
    } finally {
      client.release();
    }
  }
);

// ==========================================
// 群組照片上傳相關 API
// ==========================================

// 上傳群組大頭照
router.post('/groups/:groupId/upload-avatar', upload.single('group_avatar'), async (req, res) => {
  const { groupId } = req.params;
  const { updatedBy } = req.body; // 執行更新的用戶帳號

  console.log('📸 收到群組大頭照上傳請求:', groupId);

  if (!req.file) {
    return res.status(400).json({ 
      success: false, 
      message: '未上傳圖片' 
    });
  }

  if (!updatedBy) {
    return res.status(400).json({ 
      success: false, 
      message: '缺少用戶帳號' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 檢查群組是否存在
    const groupCheck = await client.query(
      `SELECT group_id, group_avatar_url, created_by FROM ${schemaName}.chat_groups WHERE group_id = $1`,
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        message: '群組不存在' 
      });
    }

    // 檢查用戶是否為群組創建者或管理員
    const memberCheck = await client.query(
      `SELECT role FROM ${schemaName}.group_members 
       WHERE group_id = $1 AND user_account = $2`,
      [groupId, updatedBy]
    );

    const isCreator = groupCheck.rows[0].created_by === updatedBy;
    const isAdmin = memberCheck.rows.length > 0 && memberCheck.rows[0].role === 'admin';

    if (!isCreator && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false, 
        message: '只有創建者或管理員可以更新群組照片' 
      });
    }

    const oldAvatarUrl = groupCheck.rows[0].group_avatar_url;

    console.log('✅ 權限驗證通過，開始上傳圖片');

    // 上傳新圖片到 Supabase
    const avatarUrl = await uploadToSupabase(req.file);

    console.log('✅ 圖片上傳成功:', avatarUrl);

    // 更新資料庫
    const updateResult = await client.query(`
      UPDATE ${schemaName}.chat_groups 
      SET group_avatar_url = $1, updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $2
      RETURNING group_id, group_name, group_avatar_url, updated_at
    `, [avatarUrl, groupId]);

    // 刪除舊圖片（如果存在）
    if (oldAvatarUrl) {
      await deleteFromSupabase(oldAvatarUrl);
    }

    await client.query('COMMIT');

    console.log('✅ 群組大頭照更新成功');

    res.json({
      success: true,
      message: '群組照片上傳成功',
      data: updateResult.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 上傳群組照片失敗:', error);
    res.status(500).json({ 
      success: false, 
      message: '上傳失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// 刪除群組大頭照
router.delete('/groups/:groupId/delete-avatar', async (req, res) => {
  const { groupId } = req.params;
  const { updatedBy } = req.body;

  if (!updatedBy) {
    return res.status(400).json({ 
      success: false, 
      message: '缺少用戶帳號' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 檢查群組和權限
    const groupCheck = await client.query(
      `SELECT group_id, group_avatar_url, created_by FROM ${schemaName}.chat_groups WHERE group_id = $1`,
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        message: '群組不存在' 
      });
    }

    const memberCheck = await client.query(
      `SELECT role FROM ${schemaName}.group_members 
       WHERE group_id = $1 AND user_account = $2`,
      [groupId, updatedBy]
    );

    const isCreator = groupCheck.rows[0].created_by === updatedBy;
    const isAdmin = memberCheck.rows.length > 0 && memberCheck.rows[0].role === 'admin';

    if (!isCreator && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false, 
        message: '只有創建者或管理員可以刪除群組照片' 
      });
    }

    const avatarUrl = groupCheck.rows[0].group_avatar_url;

    if (!avatarUrl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        message: '群組沒有照片' 
      });
    }

    // 從 Supabase 刪除圖片
    await deleteFromSupabase(avatarUrl);

    // 更新資料庫
    await client.query(`
      UPDATE ${schemaName}.chat_groups 
      SET group_avatar_url = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $1
    `, [groupId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: '群組照片已刪除'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 刪除群組照片失敗:', error);
    res.status(500).json({ 
      success: false, 
      message: '刪除失敗',
      error: error.message 
    });
  } finally {
    client.release();
  }
});

// ==========================================
// 輔助函數：從 Supabase 刪除圖片
// ==========================================

async function deleteFromSupabase(imageUrl) {
  if (!imageUrl) return;

  try {
    console.log('🗑️ 準備刪除舊圖片:', imageUrl);
    const urlParts = imageUrl.split('/');
    const bucketIndex = urlParts.indexOf('chat-images');
    
    if (bucketIndex === -1) {
      console.log('⚠️ URL 格式不正確，無法刪除');
      return;
    }

    const filePath = urlParts.slice(bucketIndex + 1).join('/');
    console.log('🔍 解析到的檔案路徑:', filePath);

    const { error } = await supabase.storage
      .from('chat-images')
      .remove([filePath]);

    if (error) {
      console.error('❌ 刪除舊圖片失敗:', error);
    } else {
      console.log('✅ 舊圖片已刪除');
    }
  } catch (err) {
    console.error('❌ 解析或刪除圖片 URL 失敗:', err);
  }
}

  // 返回 router 物件
  return router;
};