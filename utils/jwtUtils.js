// utils/jwtUtils.js
// JWT Token 產生與驗證工具

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// JWT 密鑰 (正式環境應該從環境變數讀取)
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-this';

// Token 有效期
const ACCESS_TOKEN_EXPIRES_IN = '15m';    // Access Token 15分鐘
const REFRESH_TOKEN_EXPIRES_IN = '7d';    // Refresh Token 7天

/**
 * 產生 Access Token
 * @param {Object} payload - Token 內容
 * @returns {string} JWT Token
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    issuer: 'moradocasa-api',
    audience: 'moradocasa-client'
  });
}

/**
 * 產生 Refresh Token
 * @param {Object} payload - Token 內容
 * @returns {string} JWT Token
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    issuer: 'moradocasa-api',
    audience: 'moradocasa-client'
  });
}

/**
 * 驗證 Access Token
 * @param {string} token - JWT Token
 * @returns {Object|null} 解碼後的 payload 或 null
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'moradocasa-api',
      audience: 'moradocasa-client'
    });
  } catch (error) {
    console.error('Access Token 驗證失敗:', error.message);
    return null;
  }
}

/**
 * 驗證 Refresh Token
 * @param {string} token - JWT Token
 * @returns {Object|null} 解碼後的 payload 或 null
 */
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET, {
      issuer: 'moradocasa-api',
      audience: 'moradocasa-client'
    });
  } catch (error) {
    console.error('Refresh Token 驗證失敗:', error.message);
    return null;
  }
}

/**
 * 從請求中提取 Token
 * @param {Object} req - Express request 物件
 * @returns {string|null} Token 或 null
 */
function extractToken(req) {
  // 從 Authorization header 提取
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  // 從 cookie 提取 (如果使用 httpOnly cookie)
  if (req.cookies && req.cookies.accessToken) {
    return req.cookies.accessToken;
  }
  
  return null;
}

/**
 * 產生隨機 Token ID (用於 Refresh Token 追蹤)
 * @returns {string} 隨機 ID
 */
function generateTokenId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 計算 Token 過期時間
 * @param {string} expiresIn - 過期時間字串 (如 '15m', '7d')
 * @returns {Date} 過期時間
 */
function calculateExpiresAt(expiresIn) {
  const now = new Date();
  
  // 解析時間字串
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error('無效的過期時間格式');
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': // 秒
      now.setSeconds(now.getSeconds() + value);
      break;
    case 'm': // 分
      now.setMinutes(now.getMinutes() + value);
      break;
    case 'h': // 小時
      now.setHours(now.getHours() + value);
      break;
    case 'd': // 天
      now.setDate(now.getDate() + value);
      break;
    default:
      throw new Error('不支援的時間單位');
  }
  
  return now;
}

/**
 * 檢查 Token 是否即將過期
 * @param {Object} decoded - 解碼後的 Token
 * @param {number} thresholdMinutes - 閾值（分鐘）
 * @returns {boolean} 是否即將過期
 */
function isTokenExpiringSoon(decoded, thresholdMinutes = 5) {
  if (!decoded || !decoded.exp) {
    return true;
  }
  
  const now = Math.floor(Date.now() / 1000);
  const timeUntilExpiry = decoded.exp - now;
  const thresholdSeconds = thresholdMinutes * 60;
  
  return timeUntilExpiry < thresholdSeconds;
}

/**
 * 建立完整的 Token payload
 * @param {Object} user - 使用者資料
 * @param {Array} roles - 角色陣列
 * @param {Array} permissions - 權限陣列
 * @returns {Object} Token payload
 */
function createTokenPayload(user, roles, permissions) {
  return {
    // 基本資訊
    account: user.account,
    name: user.description || user.account,
    customer_id: user.customer_id,
    
    // 角色和權限
    roles: roles.map(r => r.role_code),
    permissions: permissions.map(p => p.permission_code),
    
    // 最高角色層級 (數字越小權限越大)
    level: Math.min(...roles.map(r => r.level)),
    
    // Token 元數據
    tokenId: generateTokenId(),
    type: 'access'
  };
}

/**
 * 建立 Refresh Token payload
 * @param {string} account - 帳號
 * @param {string} tokenId - Token ID
 * @returns {Object} Token payload
 */
function createRefreshTokenPayload(account, tokenId) {
  return {
    account,
    tokenId,
    type: 'refresh'
  };
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  extractToken,
  generateTokenId,
  calculateExpiresAt,
  isTokenExpiringSoon,
  createTokenPayload,
  createRefreshTokenPayload,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN
};