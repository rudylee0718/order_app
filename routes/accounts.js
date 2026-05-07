// routes/accounts.js

const express = require('express');
const multer = require('multer');
const supabase = require('./supabase'); // 調整路徑根據你的專案結構
const path = require('path');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');
const router = express.Router();

// 設定 multer 用於圖片上傳
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 限制 10MB
  // fileFilter: (req, file, cb) => {
  //   // 只接受圖片格式
  //   const allowedTypes = /jpeg|jpg|png|gif|webp/;
  //   const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  //   const mimetype = allowedTypes.test(file.mimetype);

  //   if (mimetype && extname) {
  //     return cb(null, true);
  //   } else {
  //     cb(new Error('只允許上傳圖片格式 (jpeg, jpg, png, gif, webp)'));
  //   }
  // }
});


// 上傳到 Supabase Storage 的輔助函式
async function uploadProfileImageToSupabase(file, account) {
  const ext = path.extname(file.originalname);
  const fileName = `profile_${account}_${Date.now()}${ext}`;
  const filePath = `profiles/${fileName}`;

  const { error } = await supabase.storage
    .from('profile-images') // 使用你現有的 bucket，或創建新的 'profile-images'
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage
    .from('profile-images')
    .getPublicUrl(filePath);

  return data.publicUrl;
}

// ── 上傳到 Supabase (與 conversation.js 相同邏輯) ──
async function uploadProfileImageToSupabaseWeb(file) {
  const ext = path.extname(file.originalname);
  const fileName = `profile_${Date.now()}${ext}`;
  const filePath = `profiles/${fileName}`;

  const { error } = await supabase.storage
    .from('profile-images')          // 沿用同一個 bucket，可改為 'account-avatars'
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from('profile-images')
    .getPublicUrl(filePath);

  return data.publicUrl;
}
// 刪除 Supabase Storage 中的舊圖片
async function deleteProfileImageFromSupabase(imageUrl) {
  if (!imageUrl) return;

  try {
    // 從 URL 中提取檔案路徑
    const urlParts = imageUrl.split('/');
    const bucketIndex = urlParts.indexOf('profile-images');
    if (bucketIndex === -1) return;

    const filePath = urlParts.slice(bucketIndex + 1).join('/');

    const { error } = await supabase.storage
      .from('profile-images')
      .remove([filePath]);

    if (error) {
      console.error('刪除舊圖片失敗：', error);
    }
  } catch (err) {
    console.error('解析或刪除圖片 URL 失敗：', err);
  }
}

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

  // 新增帳號資料的 API
  router.post('/', async (req, res) => {
    const { account, password, description, customer_id } = req.body;

    // 檢查所有必需的欄位
    if (!account || !password || !customer_id) {
      return res.status(400).json({ status: 'Error', message: '缺少必要的欄位: account, password 和 customer_id' });
    }
    
    try {
      // 檢查 customer_id 是否存在於客戶資料表中
      const customerCheckQuery = `
        SELECT id FROM ${schemaName}.customers WHERE id = $1;
      `;
      const customerCheckResult = await pool.query(customerCheckQuery, [customer_id]);
      
      if (customerCheckResult.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '提供的客戶ID不存在' });
      }

      const query = `
        INSERT INTO ${schemaName}.accounts (account, password, description, customer_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (account) DO NOTHING
        RETURNING *;
      `;
      const values = [account, password, description, customer_id];
      
      const result = await pool.query(query, values);
      
      if (result.rows.length > 0) {
        res.status(201).json({ status: 'Success', message: '帳號資料已成功新增', data: result.rows[0] });
      } else {
        res.status(409).json({ status: 'Error', message: '帳號名稱已存在，無法新增' });
      }

    } catch (err) {
      console.error('新增帳號資料失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '新增帳號資料失敗' });
    }
  });

  // 查詢單一帳號資料的 API (用於 Flutter 頁面中的自動帶入功能)
  router.get('/', async (req, res) => {
    const { account } = req.query;
    if (!account) {
      return res.status(400).json({ status: 'Error', message: '缺少帳號參數' });
    }
    try {
      const query = `
        SELECT 
          a.account, 
          a.description as accountName,
          a.profile_image_url,
          b.description as customerName, 
          a.customer_id 
        FROM ${schemaName}.accounts as a 
        LEFT JOIN ${schemaName}.customers as b ON a.customer_id = b.id 
        WHERE a.account = $1;
      `;
      const values = [account];
      const result = await pool.query(query, values);
      if (result.rows.length > 0) {
        res.status(200).json({ status: 'Success', message: '帳號查詢成功', data: result.rows[0] });
      } else {
        res.status(404).json({ status: 'Error', message: '帳號不存在' });
      }
    } catch (err) {
      console.error('帳號查詢失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '帳號查詢失敗' });
    }
  });
  // 🌟 新增：上傳/更新用戶大頭照 API
  router.post('/upload-profile-image', upload.single('profile_image'), async (req, res) => {
    const { account } = req.body;

    if (!account) {
      return res.status(400).json({ status: 'Error', message: '缺少帳號參數' });
    }

    if (!req.file) {
      return res.status(400).json({ status: 'Error', message: '未上傳圖片' });
    }

    try {
      // 1. 查詢當前帳號的舊圖片 URL
      const getOldImageQuery = `
        SELECT profile_image_url FROM ${schemaName}.accounts WHERE account = $1;
      `;
      const oldImageResult = await pool.query(getOldImageQuery, [account]);

      if (oldImageResult.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '帳號不存在' });
      }

      const oldImageUrl = oldImageResult.rows[0].profile_image_url;

      // 2. 上傳新圖片到 Supabase
      const newImageUrl = await uploadProfileImageToSupabase(req.file, account);

      // 3. 更新資料庫中的圖片 URL
      const updateQuery = `
        UPDATE ${schemaName}.accounts 
        SET profile_image_url = $1 
        WHERE account = $2
        RETURNING account, profile_image_url;
      `;
      const updateResult = await pool.query(updateQuery, [newImageUrl, account]);

      // 4. 刪除舊圖片（如果存在）
      if (oldImageUrl) {
        await deleteProfileImageFromSupabase(oldImageUrl);
      }

      res.status(200).json({
        status: 'Success',
        message: '大頭照上傳成功',
        data: updateResult.rows[0]
      });

    } catch (err) {
      console.error('上傳大頭照失敗：', err);
      res.status(500).json({ status: 'Error', message: '上傳大頭照失敗', error: err.message });
    }
  });

  // 🌟 新增：刪除用戶大頭照 API
  router.delete('/delete-profile-image', async (req, res) => {
    const { account } = req.body;

    if (!account) {
      return res.status(400).json({ status: 'Error', message: '缺少帳號參數' });
    }

    try {
      // 1. 查詢當前圖片 URL
      const getImageQuery = `
        SELECT profile_image_url FROM ${schemaName}.accounts WHERE account = $1;
      `;
      const imageResult = await pool.query(getImageQuery, [account]);

      if (imageResult.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '帳號不存在' });
      }

      const imageUrl = imageResult.rows[0].profile_image_url;

      if (!imageUrl) {
        return res.status(400).json({ status: 'Error', message: '該帳號沒有大頭照' });
      }

      // 2. 從 Supabase 刪除圖片
      await deleteProfileImageFromSupabase(imageUrl);

      // 3. 更新資料庫，將 profile_image_url 設為 NULL
      const updateQuery = `
        UPDATE ${schemaName}.accounts 
        SET profile_image_url = NULL 
        WHERE account = $1
        RETURNING account;
      `;
      await pool.query(updateQuery, [account]);

      res.status(200).json({
        status: 'Success',
        message: '大頭照已刪除'
      });

    } catch (err) {
      console.error('刪除大頭照失敗：', err);
      res.status(500).json({ status: 'Error', message: '刪除大頭照失敗', error: err.message });
    }
  });
  // ==================== web開始 ====================
 // ==================== 上傳大頭照 ====================
  // POST /api/accounts/web/upload-profile-image
  router.post('/web/upload-profile-image',
    authenticateToken,
    upload.single('image'),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ status: 'Error', message: '請上傳圖片' });
      }
      try {
        const imageUrl = await uploadProfileImageToSupabaseWeb(req.file);
        res.json({ status: 'Success', imageUrl });
      } catch (err) {
        console.error('❌ 上傳大頭照失敗:', err);
        res.status(500).json({ status: 'Error', message: '圖片上傳失敗', error: err.message });
      }
    }
  );

  // ==================== 查詢帳號列表 ====================
  // GET /api/accounts?customer_id=&page=&limit=&search=
  // 權限：masters:account:read
  router.get('/web/',
    authenticateToken,
    requirePermission('users:accounts:read'),
    async (req, res) => {
      try {
        const { customer_id, page = 1, limit = 10, search = '' } = req.query;

        if (!customer_id) {
          return res.status(400).json({ status: 'Error', message: '請提供客戶代號 customer_id' });
        }

        const offset = (page - 1) * limit;
        const params = [customer_id];
        let whereClause = `WHERE a.customer_id = $1`;

        if (search) {
          whereClause += ` AND (a.account ILIKE $${params.length + 1} OR a.description ILIKE $${params.length + 1})`;
          params.push(`%${search}%`);
        }

        // 總數
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.accounts a ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count);

        // 資料
        const dataResult = await pool.query(`
          SELECT
            a.account,
            a.password,
            a.description,
            a.email,
            a.phone,
            a.status,
            a.remark,
            a.profile_image_url,
            a.customer_id,
            a.created_at,
            a.updated_at,
            a.created_by,
            a.updated_by
          FROM ${schemaName}.accounts a
          ${whereClause}

          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          accounts: dataResult.rows,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        });

      } catch (error) {
        console.error('❌ 查詢帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢帳號失敗', error: error.message });
      }
    }
  );

  // ==================== 查詢單一帳號 ====================
  // GET /api/accounts/:account
  router.get('/web/:account',
    authenticateToken,
    requirePermission('users:accounts:read'),
    async (req, res) => {
      try {
        const { account } = req.params;
        const result = await pool.query(
          `SELECT * FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }
        res.json({ status: 'Success', account: result.rows[0] });
      } catch (error) {
        console.error('❌ 查詢帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢帳號失敗', error: error.message });
      }
    }
  );

  // ==================== 新增帳號 ====================
  // POST /api/accounts
  // 權限：masters:account:create
  router.post('/web/',
    authenticateToken,
    requirePermission('users:accounts:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const {
          account,
          password,
          description,
          email,
          phone,
          status = 'active',
          remark,
          profile_image_url,
          customer_id
        } = req.body;

        // 必填驗證
        if (!account || !description || !customer_id || !password) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'Error',
            message: '帳號、姓名、客戶、密碼代號為必填欄位'
          });
        }

        // 帳號格式驗證
        if (!/^[A-Z0-9_@.-]+$/i.test(account)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '帳號格式不正確' });
        }

        // Email 格式驗證
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: 'Email 格式不正確' });
        }

        // 確認客戶存在
        const customerCheck = await client.query(
          `SELECT id FROM ${schemaName}.customers WHERE id = $1`,
          [customer_id]
        );
        if (customerCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '指定的客戶不存在' });
        }

        // 確認帳號不重複
        const accountCheck = await client.query(
          `SELECT account FROM ${schemaName}.accounts WHERE account = $1`,
          [account.toUpperCase()]
        );
        if (accountCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '此帳號已存在' });
        }

        const insertResult = await client.query(`
          INSERT INTO ${schemaName}.accounts (
            account, description, password,email, phone,
            status, remark, profile_image_url, customer_id,
            created_by, updated_by
          ) VALUES ($1, $2, $3,$4, $5, $6, $7, $8, $9, $10, $10)
          RETURNING *
        `, [
          account.toUpperCase(),
          description,
          password,
          email || null,
          phone || null,
          status,
          remark || null,
          profile_image_url || null,
          customer_id,
          req.user.account
        ]);

        await client.query('COMMIT');
        res.status(201).json({
          status: 'Success',
          message: '帳號新增成功',
          account: insertResult.rows[0]
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 新增帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '新增帳號失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 更新帳號 ====================
  // PUT /api/accounts/:account
  // 權限：masters:account:update
  router.put('/web/:account',
    authenticateToken,
    requirePermission('users:accounts:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { account } = req.params;
        const { description, password,email, phone, status, remark, profile_image_url } = req.body;

        if (!description) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '姓名為必填欄位' });
        }
        if (!password) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '密碼為必填欄位' });
        }

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: 'Email 格式不正確' });
        }

        // 確認帳號存在並取得舊大頭照
        const checkResult = await client.query(
          `SELECT account, profile_image_url FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }

        const oldImageUrl = checkResult.rows[0].profile_image_url;

        const updateResult = await client.query(`
          UPDATE ${schemaName}.accounts SET
            description = $1,
            password=$2,
            email = $3,
            phone = $4,
            status = $5,
            remark = $6,
            profile_image_url = $7,
            updated_by = $8,
            updated_at = CURRENT_TIMESTAMP
          WHERE account = $9
          RETURNING *
        `, [
          description,
          password,
          email || null,
          phone || null,
          status,
          remark || null,
          profile_image_url || null,
          req.user.account,
          account
        ]);

        // 若大頭照有更換，刪除舊圖
        if (oldImageUrl && oldImageUrl !== profile_image_url) {
          await deleteProfileImageFromSupabase(oldImageUrl);
        }

        await client.query('COMMIT');
        res.json({
          status: 'Success',
          message: '帳號更新成功',
          account: updateResult.rows[0]
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 更新帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '更新帳號失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ==================== 刪除帳號 ====================
  // DELETE /api/accounts/:account
  // 權限：masters:account:delete
  router.delete('/web/:account',
    authenticateToken,
    requirePermission('users:accounts:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { account } = req.params;

        const checkResult = await client.query(
          `SELECT account, profile_image_url FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );
        if (checkResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '帳號不存在' });
        }

        const imageUrl = checkResult.rows[0].profile_image_url;

        // TODO: 檢查關聯資料（訊息、訂單等）
        /*
        const msgCheck = await client.query(
          `SELECT COUNT(*) FROM ${schemaName}.messages WHERE sender_account = $1`,
          [account]
        );
        if (parseInt(msgCheck.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'Error',
            message: '此帳號已有訊息記錄，無法刪除。建議改為停用。',
            code: 'HAS_RELATIONS'
          });
        }
        */

        await client.query(
          `DELETE FROM ${schemaName}.accounts WHERE account = $1`,
          [account]
        );

        // 刪除 Supabase 上的大頭照
        if (imageUrl) await deleteProfileImageFromSupabase(imageUrl);

        await client.query('COMMIT');
        res.json({
          status: 'Success',
          message: '帳號刪除成功',
          deletedAccount: account
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除帳號失敗:', error);
        res.status(500).json({ status: 'Error', message: '刪除帳號失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );  
// ==================== 新增路由：取得單一帳號資料（含餘額） ====================
// GET /api/accounts/:account
// 供 Flutter App 使用（不需要管理員權限），僅能查詢自己的資料
// 回傳欄位包含 balance，對應 api_service.dart 的 getUserBalance()
 
router.get('/:account', async (req, res) => {
  const { account } = req.params;
 
  if (!account) {
    return res.status(400).json({ status: 'Error', message: '缺少帳號參數' });
  }
 
  try {
    const result = await pool.query(`
      SELECT
        a.account,
        a.description        AS account_name,
        a.email,
        a.phone,
        a.status,
        a.profile_image_url,
        a.balance,
        a.customer_id,
        b.description        AS customer_name
      FROM ${schemaName}.accounts a
      LEFT JOIN ${schemaName}.customers b ON a.customer_id = b.id
      WHERE a.account = $1
    `, [account]);
 
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '帳號不存在' });
    }
 
    // 將 balance 轉為數字（PostgreSQL NUMERIC 序列化後為字串）
    const row = result.rows[0];
    row.balance = parseFloat(row.balance) || 0.0;
 
    res.json({ status: 'Success', data: row });
 
  } catch (err) {
    console.error('查詢帳號失敗：', err.stack);
    res.status(500).json({ status: 'Error', message: '查詢帳號失敗' });
  }
});


  // 返回 router 物件
  return router;
};