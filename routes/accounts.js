// routes/accounts.js

const express = require('express');
const multer = require('multer');
const supabase = require('./supabase'); // 調整路徑根據你的專案結構
const path = require('path');
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
    .from('chat-images') // 使用你現有的 bucket，或創建新的 'profile-images'
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

// 刪除 Supabase Storage 中的舊圖片
async function deleteProfileImageFromSupabase(imageUrl) {
  if (!imageUrl) return;

  try {
    // 從 URL 中提取檔案路徑
    const urlParts = imageUrl.split('/');
    const bucketIndex = urlParts.indexOf('chat-images');
    if (bucketIndex === -1) return;

    const filePath = urlParts.slice(bucketIndex + 1).join('/');

    const { error } = await supabase.storage
      .from('chat-images')
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

  // 返回 router 物件
  return router;
};