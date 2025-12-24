// middleware/errorHandler.js

/**
 * 全域錯誤處理中介軟體
 */
function errorHandler(err, req, res, next) {
  console.error('❌ 錯誤:', err);

  // Multer 檔案上傳錯誤
  if (err instanceof require('multer').MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: '檔案大小超過限制 (最大 10MB)'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: '檔案數量超過限制 (最多 9 個)'
      });
    }
    return res.status(400).json({
      success: false,
      error: `上傳錯誤: ${err.message}`
    });
  }

  // 資料庫錯誤
  if (err.code && err.code.startsWith('23')) {
    // PostgreSQL 約束錯誤
    return res.status(400).json({
      success: false,
      error: '資料庫約束錯誤',
      detail: process.env.NODE_ENV === 'development' ? err.detail : undefined
    });
  }

  // 自定義錯誤
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message
    });
  }

  // 預設錯誤
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

/**
 * 404 處理中介軟體
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: 'API 端點不存在',
    path: req.originalUrl
  });
}

/**
 * 非同步路由錯誤包裝器
 * 自動捕捉 async/await 錯誤
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler
};