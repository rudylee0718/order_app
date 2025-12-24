// config/upload.js

const multer = require('multer');

/**
 * Multer 配置 - 使用記憶體儲存
 * 適用於上傳到 Supabase 等雲端儲存
 */
const memoryStorage = multer.memoryStorage();

/**
 * 單檔上傳配置
 */
const singleUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳圖片檔案 (jpeg, jpg, png, gif, webp)'));
    }
  }
});

/**
 * 多檔上傳配置
 */
const multiUpload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 每個檔案 10MB
    files: 9 // 最多 9 個檔案
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳圖片檔案'));
    }
  }
});

module.exports = {
  singleUpload,
  multiUpload
};