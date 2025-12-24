// utils/supabase.js

const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// 初始化 Supabase 客戶端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * 上傳圖片到 Supabase Storage
 * @param {Object} file - Multer 處理後的檔案物件
 * @returns {Promise<string>} 圖片的公開 URL
 */
async function uploadImageToSupabase(file) {
  try {
    const ext = path.extname(file.originalname);
    const fileName = `img_${Date.now()}${ext}`;
    const filePath = `messages/${fileName}`;

    // 上傳檔案
    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw uploadError;
    }

    // 取得公開 URL
    const { data } = supabase.storage
      .from('chat-images')
      .getPublicUrl(filePath);

    return data.publicUrl;
  } catch (error) {
    console.error('❌ Supabase 上傳失敗:', error);
    throw new Error(`圖片上傳失敗: ${error.message}`);
  }
}

/**
 * 批次上傳多張圖片到 Supabase
 * @param {Array} files - Multer 處理後的檔案陣列
 * @returns {Promise<Array<string>>} 圖片 URL 陣列
 */
async function uploadMultipleImagesToSupabase(files) {
  const uploadPromises = files.map(file => uploadImageToSupabase(file));
  return Promise.all(uploadPromises);
}

/**
 * 刪除 Supabase 上的圖片
 * @param {string} imageUrl - 圖片 URL
 * @returns {Promise<boolean>} 是否刪除成功
 */
async function deleteImageFromSupabase(imageUrl) {
  try {
    // 從 URL 中提取檔案路徑
    const urlParts = imageUrl.split('/');
    const fileName = urlParts[urlParts.length - 1];
    const filePath = `messages/${fileName}`;

    const { error } = await supabase.storage
      .from('chat-images')
      .remove([filePath]);

    if (error) {
      throw error;
    }

    return true;
  } catch (error) {
    console.error('❌ Supabase 刪除失敗:', error);
    return false;
  }
}

module.exports = {
  supabase,
  uploadImageToSupabase,
  uploadMultipleImagesToSupabase,
  deleteImageFromSupabase
};