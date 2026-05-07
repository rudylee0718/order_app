// middleware/jwtAuth.js
// JWT Token 驗證中介層

const { verifyAccessToken, extractToken } = require('../utils/jwtUtils');

/**
 * JWT 認證中介層
 * 驗證請求中的 Access Token 是否有效
 */
const authenticateToken = (req, res, next) => {
  try {
    // 1. 從請求中提取 Token
    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({
        status: 'Error',
        message: '未提供認證 Token',
        code: 'NO_TOKEN'
      });
    }
    
    // 2. 驗證 Token
    const decoded = verifyAccessToken(token);
    
    if (!decoded) {
      return res.status(401).json({
        status: 'Error',
        message: 'Token 無效或已過期',
        code: 'INVALID_TOKEN'
      });
    }
    
    // 3. 將解碼後的使用者資訊附加到 request 物件
    req.user = {
      account: decoded.account,
      name: decoded.name,
      customer_id: decoded.customer_id,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
      level: decoded.level,
      tokenId: decoded.tokenId
    };
    
    // 4. 繼續處理請求
    next();
    
  } catch (error) {
    console.error('Token 驗證錯誤:', error);
    
    // 處理不同類型的錯誤
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'Error',
        message: 'Token 已過期，請重新登入',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'Error',
        message: 'Token 格式錯誤',
        code: 'INVALID_TOKEN_FORMAT'
      });
    }
    
    return res.status(500).json({
      status: 'Error',
      message: '認證過程發生錯誤',
      code: 'AUTH_ERROR'
    });
  }
};

/**
 * 可選的 JWT 認證中介層
 * Token 無效時不會中斷請求，但會設定 req.user = null
 */
const optionalAuth = (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (!token) {
      req.user = null;
      return next();
    }
    
    const decoded = verifyAccessToken(token);
    
    if (decoded) {
      req.user = {
        account: decoded.account,
        name: decoded.name,
        customer_id: decoded.customer_id,
        roles: decoded.roles || [],
        permissions: decoded.permissions || [],
        level: decoded.level,
        tokenId: decoded.tokenId
      };
    } else {
      req.user = null;
    }
    
    next();
    
  } catch (error) {
    req.user = null;
    next();
  }
};

/**
 * 檢查使用者是否已認證
 */
const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: 'Error',
      message: '需要登入才能訪問此資源',
      code: 'AUTHENTICATION_REQUIRED'
    });
  }
  next();
};

/**
 * 檢查使用者是否有特定角色
 * @param {Array|string} allowedRoles - 允許的角色陣列或單一角色
 */
const requireRole = (allowedRoles) => {
  // 如果傳入的是字串，轉換為陣列
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'Error',
        message: '需要登入才能訪問此資源',
        code: 'AUTHENTICATION_REQUIRED'
      });
    }
    
    // 檢查使用者是否有任一允許的角色
    const hasRole = req.user.roles.some(role => rolesArray.includes(role));
    
    if (!hasRole) {
      return res.status(403).json({
        status: 'Error',
        message: '您沒有權限訪問此資源',
        code: 'INSUFFICIENT_ROLE',
        required: rolesArray,
        current: req.user.roles
      });
    }
    
    next();
  };
};

/**
 * 檢查使用者角色層級是否足夠
 * @param {number} requiredLevel - 需要的最低層級 (數字越小權限越大)
 */
const requireLevel = (requiredLevel) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'Error',
        message: '需要登入才能訪問此資源',
        code: 'AUTHENTICATION_REQUIRED'
      });
    }
    
    if (req.user.level > requiredLevel) {
      return res.status(403).json({
        status: 'Error',
        message: '您的權限等級不足',
        code: 'INSUFFICIENT_LEVEL',
        required: requiredLevel,
        current: req.user.level
      });
    }
    
    next();
  };
};

/**
 * 檢查是否為管理員
 */
const requireAdmin = requireRole(['super_admin', 'admin']);

/**
 * 檢查是否為超級管理員
 */
const requireSuperAdmin = requireRole('super_admin');

/**
 * 組合多個中介層 - 同時檢查認證和角色
 * @param {Array|string} allowedRoles - 允許的角色
 */
const authWithRole = (allowedRoles) => {
  return [authenticateToken, requireRole(allowedRoles)];
};

/**
 * 組合多個中介層 - 同時檢查認證和層級
 * @param {number} requiredLevel - 需要的最低層級
 */
const authWithLevel = (requiredLevel) => {
  return [authenticateToken, requireLevel(requiredLevel)];
};

module.exports = {
  // 基本認證
  authenticateToken,
  optionalAuth,
  requireAuth,
  
  // 角色檢查
  requireRole,
  requireLevel,
  requireAdmin,
  requireSuperAdmin,
  
  // 組合中介層
  authWithRole,
  authWithLevel
};