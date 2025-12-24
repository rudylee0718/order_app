// middleware/validation.js

/**
 * 驗證必填參數
 * @param {Array<string>} requiredFields - 必填欄位陣列
 */
function validateRequired(requiredFields) {
  return (req, res, next) => {
    const missingFields = [];
    const data = { ...req.body, ...req.params, ...req.query };

    for (const field of requiredFields) {
      if (!data[field]) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: '缺少必填參數',
        missingFields
      });
    }

    next();
  };
}

/**
 * 驗證檔案上傳
 * @param {boolean} required - 是否必須上傳檔案
 */
function validateFileUpload(required = true) {
  return (req, res, next) => {
    if (required && (!req.file && !req.files)) {
      return res.status(400).json({
        success: false,
        error: '請上傳檔案'
      });
    }

    // 驗證檔案類型
    const files = req.files || (req.file ? [req.file] : []);
    const invalidFiles = files.filter(file => {
      const allowedTypes = /jpeg|jpg|png|gif|webp/;
      return !allowedTypes.test(file.mimetype);
    });

    if (invalidFiles.length > 0) {
      return res.status(400).json({
        success: false,
        error: '只允許上傳圖片檔案 (jpeg, jpg, png, gif, webp)'
      });
    }

    next();
  };
}

/**
 * 驗證帳號格式
 */
function validateAccount(req, res, next) {
  const accounts = [
    req.body.senderAccount,
    req.body.receiverAccount,
    req.body.userAccount,
    req.params.account
  ].filter(Boolean);

  const invalidAccounts = accounts.filter(account => {
    return typeof account !== 'string' || account.length === 0 || account.length > 50;
  });

  if (invalidAccounts.length > 0) {
    return res.status(400).json({
      success: false,
      error: '帳號格式不正確'
    });
  }

  next();
}

/**
 * 驗證訊息內容
 */
function validateMessage(req, res, next) {
  const { message, messageType } = req.body;

  // 如果是圖片訊息,訊息內容可以為空
  if (messageType === 'image' || messageType === 'multi_image') {
    return next();
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      success: false,
      error: '訊息內容不可為空'
    });
  }

  if (message.length > 5000) {
    return res.status(400).json({
      success: false,
      error: '訊息內容過長 (最多 5000 字元)'
    });
  }

  next();
}

/**
 * 驗證群組名稱
 */
function validateGroupName(req, res, next) {
  const { groupName } = req.body;

  if (!groupName || typeof groupName !== 'string') {
    return res.status(400).json({
      success: false,
      error: '群組名稱不可為空'
    });
  }

  if (groupName.length > 100) {
    return res.status(400).json({
      success: false,
      error: '群組名稱過長 (最多 100 字元)'
    });
  }

  next();
}

module.exports = {
  validateRequired,
  validateFileUpload,
  validateAccount,
  validateMessage,
  validateGroupName
};