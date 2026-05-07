// middleware/permissionCheck.js
// 權限檢查中介層 - 細粒度權限控制

/**
 * 檢查使用者是否有特定權限
 * @param {string|Array} requiredPermissions - 需要的權限 (單一或陣列)
 * @param {string} mode - 檢查模式: 'any' (任一) 或 'all' (全部)
 */
const requirePermission = (requiredPermissions, mode = 'any') => {
  // 如果傳入的是字串，轉換為陣列
  const permissionsArray = Array.isArray(requiredPermissions) 
    ? requiredPermissions 
    : [requiredPermissions];
  
  return (req, res, next) => {
    // 1. 確認使用者已認證
    if (!req.user) {
      return res.status(401).json({
        status: 'Error',
        message: '需要登入才能訪問此資源',
        code: 'AUTHENTICATION_REQUIRED'
      });
    }
    
    // 2. 取得使用者權限
    const userPermissions = req.user.permissions || [];
    
    // 3. 檢查權限
    let hasPermission = false;
    
    if (mode === 'all') {
      // 必須擁有所有權限
      hasPermission = permissionsArray.every(permission => 
        userPermissions.includes(permission)
      );
    } else {
      // 只需要擁有任一權限 (預設)
      hasPermission = permissionsArray.some(permission => 
        userPermissions.includes(permission)
      );
    }
    
    // 4. 權限不足時拒絕
    if (!hasPermission) {
      return res.status(403).json({
        status: 'Error',
        message: '您沒有權限執行此操作',
        code: 'INSUFFICIENT_PERMISSION',
        required: permissionsArray,
        mode: mode
      });
    }
    
    // 5. 通過檢查
    next();
  };
};

/**
 * 檢查資源的 CRUD 權限
 * @param {string} resource - 資源名稱 (如 'sales', 'finance')
 * @param {string} action - 動作 (create, read, update, delete)
 */
const requireResourcePermission = (resource, action) => {
  const permission = `${resource}:${action}`;
  return requirePermission(permission);
};

/**
 * 檢查是否可以新增資源
 */
const canCreate = (resource) => requireResourcePermission(resource, 'create');

/**
 * 檢查是否可以查看資源
 */
const canRead = (resource) => requireResourcePermission(resource, 'read');

/**
 * 檢查是否可以修改資源
 */
const canUpdate = (resource) => requireResourcePermission(resource, 'update');

/**
 * 檢查是否可以刪除資源
 */
const canDelete = (resource) => requireResourcePermission(resource, 'delete');

/**
 * 檢查是否可以管理資源 (需要 create, update, delete 權限)
 */
const canManage = (resource) => {
  return requirePermission([
    `${resource}:create`,
    `${resource}:update`,
    `${resource}:delete`
  ], 'all');
};

/**
 * 動態權限檢查 - 從請求參數中取得資源和動作
 * 使用方式: router.post('/:resource/:action', checkDynamicPermission, handler)
 */
const checkDynamicPermission = (req, res, next) => {
  const { resource, action } = req.params;
  
  if (!resource || !action) {
    return res.status(400).json({
      status: 'Error',
      message: '缺少資源或動作參數',
      code: 'MISSING_PARAMS'
    });
  }
  
  const permission = `${resource}:${action}`;
  return requirePermission(permission)(req, res, next);
};

/**
 * 檢查使用者是否為資源擁有者
 * @param {Function} getOwnerId - 取得資源擁有者 ID 的函數
 */
const requireOwnership = (getOwnerId) => {
  return async (req, res, next) => {
    try {
      // 確認使用者已認證
      if (!req.user) {
        return res.status(401).json({
          status: 'Error',
          message: '需要登入才能訪問此資源',
          code: 'AUTHENTICATION_REQUIRED'
        });
      }
      
      // 取得資源擁有者 ID
      const ownerId = await getOwnerId(req);
      
      // 檢查是否為擁有者或管理員
      const isOwner = req.user.account === ownerId;
      const isAdmin = req.user.roles.includes('super_admin') || req.user.roles.includes('admin');
      
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          status: 'Error',
          message: '您只能操作自己的資源',
          code: 'NOT_OWNER'
        });
      }
      
      next();
      
    } catch (error) {
      console.error('擁有權檢查錯誤:', error);
      return res.status(500).json({
        status: 'Error',
        message: '權限檢查失敗',
        code: 'OWNERSHIP_CHECK_ERROR'
      });
    }
  };
};

/**
 * 資料範圍過濾中介層
 * 根據使用者角色限制可訪問的資料範圍
 */
const filterDataByRole = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: 'Error',
      message: '需要登入才能訪問此資源',
      code: 'AUTHENTICATION_REQUIRED'
    });
  }
  
  // 超級管理員和管理員可以看所有資料
  if (req.user.roles.includes('super_admin') || req.user.roles.includes('admin')) {
    req.dataFilter = {}; // 無限制
    return next();
  }
  
  // 經理可以看部門內的資料
  const isManager = req.user.roles.some(role => role.endsWith('_manager'));
  if (isManager) {
    // 可以設定部門過濾條件
    req.dataFilter = {
      department: getDepartmentFromRoles(req.user.roles)
    };
    return next();
  }
  
  // 專員只能看自己的資料
  req.dataFilter = {
    created_by: req.user.account
  };
  
  next();
};

/**
 * 從角色中取得部門名稱
 */
function getDepartmentFromRoles(roles) {
  for (const role of roles) {
    if (role.startsWith('sales_')) return 'sales';
    if (role.startsWith('finance_')) return 'finance';
    if (role.startsWith('production_')) return 'production';
    if (role.startsWith('manufacturing_')) return 'manufacturing';
  }
  return null;
}

/**
 * 記錄操作日誌的中介層
 * @param {string} operation - 操作類型
 * @param {string} resource - 資源名稱
 */
const logOperation = (operation, resource) => {
  return async (req, res, next) => {
    // 儲存原始的 res.json 方法
    const originalJson = res.json.bind(res);
    
    // 覆寫 res.json 方法
    res.json = function(data) {
      // 只記錄成功的操作
      if (data.status === 'Success' && req.user) {
        // 非同步記錄，不阻塞回應
        logToDatabase(req, operation, resource, data).catch(err => {
          console.error('記錄操作日誌失敗:', err);
        });
      }
      
      // 呼叫原始的 json 方法
      return originalJson(data);
    };
    
    next();
  };
};

/**
 * 記錄到資料庫
 */
async function logToDatabase(req, operation, resource, responseData) {
  try {
    const pool = req.app.locals.pool;
    const schemaName = req.app.locals.schemaName;
    
    if (!pool || !schemaName) return;
    
    const ipAddress = req.ip || req.connection.remoteAddress;
    const resourceId = req.params.id || responseData.data?.id || null;
    
    const query = `
      INSERT INTO ${schemaName}.operation_logs 
        (account, operation, resource, resource_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6);
    `;
    
    const details = {
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query
    };
    
    await pool.query(query, [
      req.user.account,
      operation,
      resource,
      resourceId,
      JSON.stringify(details),
      ipAddress
    ]);
  } catch (error) {
    console.error('寫入操作日誌失敗:', error);
  }
}

/**
 * 組合認證和權限檢查
 */
const authAndPermission = (permission, mode = 'any') => {
  const { authenticateToken } = require('./jwtAuth');
  return [authenticateToken, requirePermission(permission, mode)];
};

module.exports = {
  // 基本權限檢查
  requirePermission,
  requireResourcePermission,
  
  // CRUD 權限快捷方法
  canCreate,
  canRead,
  canUpdate,
  canDelete,
  canManage,
  
  // 動態權限檢查
  checkDynamicPermission,
  
  // 擁有權檢查
  requireOwnership,
  
  // 資料範圍過濾
  filterDataByRole,
  
  // 操作日誌
  logOperation,
  
  // 組合中介層
  authAndPermission
};