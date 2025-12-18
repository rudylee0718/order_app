// routes/login.js

const express = require('express');
const router = express.Router();

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

    router.get('/conversations/:account', async (req, res) => {
    const { account } = req.params;
    
    try {
        const result = await pool.query(`
        SELECT 
            c.*,
            u.account as contact_account,
            u.description as contact_name,
            u.customer_id as contact_customer_id
        FROM ${schemaName}.conversations c
        JOIN ${schemaName}.accounts u ON c.contact_account = u.account
        WHERE c.user_account = $1
        ORDER BY c.updated_at DESC
        `, [account]);
        
        res.json({
        success: true,
        conversations: result.rows.map(row => ({
            contactAccount: row.contact_account,
            contactName: row.contact_name,
            contactCustomerId: row.contact_customer_id,
            lastMessage: row.last_message,
            timestamp: row.last_message_time,
            unreadCount: row.unread_count
        }))
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
    });

    // ==================== 搜尋用戶 API ====================

    // GET /api/users/search?q=query&excludeAccount=account
    // 搜尋用戶
    router.get('/users/search', async (req, res) => {
    const { q, excludeAccount } = req.query;
    
    if (!q || q.trim().length === 0) {
        return res.json({ success: true, users: [] });
    }
    
    try {
        const searchTerm = `%${q}%`;
        const result = await pool.query(`
        SELECT account, description, customer_id
        FROM ${schemaName}.accounts
        WHERE (account ILIKE $1 OR description ILIKE $2)
            AND account != $3
        LIMIT 50
        `, [searchTerm, searchTerm, excludeAccount]);
        
        res.json({
        success: true,
        users: result.rows.map(row => ({
            account: row.account,
            accountName: row.description,
            customerId: row.customer_id
        }))
        });
    } catch (error) {
        console.error('Error searching users:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
    });

    // ==================== 訊息 API ====================

    // GET /api/messages?account1=xxx&account2=yyy
    // 取得兩個用戶之間的訊息
    router.get('/messages', async (req, res) => {
    const { account1, account2 } = req.query;
    
    if (!account1 || !account2) {
        return res.status(400).json({ success: false, error: 'Missing parameters' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 查詢訊息
        const messagesResult = await client.query(`
        SELECT *
        FROM ${schemaName}.messages
        WHERE (sender_account = $1 AND receiver_account = $2)
            OR (sender_account = $2 AND receiver_account = $1)
        ORDER BY timestamp ASC
        `, [account1, account2]);
        
        // 標記訊息為已讀
        await client.query(`
        UPDATE ${schemaName}.messages
        SET is_read = TRUE
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
            timestamp: row.timestamp,
            isRead: row.is_read
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

    // POST /api/messages/send
    // 發送訊息
    router.post('/messages/send', async (req, res) => {
    const { senderAccount, receiverAccount, message, timestamp } = req.body;
    
    if (!senderAccount || !receiverAccount || !message) {
        return res.status(400).json({ success: false, error: 'Missing parameters' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. 插入訊息
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const messageTime = timestamp || new Date().toISOString();
        
        await client.query(`
        INSERT INTO ${schemaName}.messages (message_id, sender_account, receiver_account, message, timestamp)
        VALUES ($1, $2, $3, $4, $5)
        `, [messageId, senderAccount, receiverAccount, message, messageTime]);
        
        // 2. 更新或創建發送者的對話記錄
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
        
        // 3. 更新或創建接收者的對話記錄 (未讀數量 +1)
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
        
        await client.query('COMMIT');
        
        res.json({
        success: true,
        messageId: messageId
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
    });

    // PUT /api/messages/read
    // 標記訊息為已讀
    router.put('/messages/read', async (req, res) => {
    const { userAccount, contactAccount } = req.body;
    
    if (!userAccount || !contactAccount) {
        return res.status(400).json({ success: false, error: 'Missing parameters' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        await client.query(`
        UPDATE ${schemaName}.messages
        SET is_read = TRUE
        WHERE receiver_account = $1 
            AND sender_account = $2 
            AND is_read = FALSE
        `, [userAccount, contactAccount]);
        
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

    // DELETE /api/conversations?userAccount=xxx&contactAccount=yyy
    // 刪除對話
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
    // 取得未讀訊息總數
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