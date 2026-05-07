// routes/login.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const {
  generateAccessToken,
  generateRefreshToken,
  createTokenPayload,
  createRefreshTokenPayload,
  calculateExpiresAt,
  REFRESH_TOKEN_EXPIRES_IN
} = require('../utils/jwtUtils');

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

  // 處理登入驗證的 API
  router.post('/', async (req, res) => {
    const { account, password } = req.body;

    if (!account || !password) {
      return res.status(400).json({ status: 'Error', message: '帳號和密碼不能為空' });
    }

    try {
      const query = `
        SELECT a.*,b.description as customername FROM ${schemaName}.accounts as a left join ${schemaName}.customers as b
         on a.customer_id=b.id  WHERE a.account = $1 AND a.password = $2;
      `;
      const values = [account, password];
      const result = await pool.query(query, values);

      if (result.rows.length > 0) {
        res.status(200).json({ status: 'Success', message: '登入成功', data: result.rows[0] });
      } else {
        res.status(401).json({ status: 'Error', message: '帳號或密碼錯誤' });
      }
    } catch (err) {
      console.error('登入驗證失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

 router.post('/server', async (req, res) => {
    const { account, password } = req.body;
    
    // 記錄登入嘗試的 IP 和 User Agent
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    try {
      // 1. 驗證輸入
      if (!account || !password) {
        await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, false, '帳號或密碼未提供');
        return res.status(400).json({
          status: 'Error',
          message: '請提供帳號和密碼'
        });
      }
      
      // 2. 查詢帳號資料
      const accountQuery = `
        SELECT 
          account,
          password,
          description,
          customer_id,
          profile_image_url
        FROM ${schemaName}.accounts
        WHERE account = $1;
      `;
      
      const accountResult = await pool.query(accountQuery, [account]);
      
      if (accountResult.rows.length === 0) {
        await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, false, '帳號不存在');
        return res.status(401).json({
          status: 'Error',
          message: '帳號或密碼錯誤'
        });
      }
      
      const user = accountResult.rows[0];
      
      // 3. 驗證密碼
      // 注意: 如果資料庫中的密碼是明文，需要改用 bcrypt 加密
      // 目前假設密碼已經用 bcrypt 加密
      // const isPasswordValid = await bcrypt.compare(password, user.password);

      
      // 如果密碼是明文 (臨時方案，正式環境必須改用 bcrypt)
      const isPasswordValid = password === user.password;
      
      if (!isPasswordValid) {
        await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, false, '密碼錯誤');
        return res.status(401).json({
          status: 'Error',
          message: '帳號或密碼錯誤'
        });
      }
      
      // 4. 查詢使用者的所有角色
      const rolesQuery = `
        SELECT 
          r.role_code,
          r.role_name,
          r.level,
          r.description
        FROM ${schemaName}.account_roles ar
        JOIN ${schemaName}.roles r ON ar.role_code = r.role_code
        WHERE ar.account = $1
        ORDER BY r.level ASC;
      `;
      
      const rolesResult = await pool.query(rolesQuery, [account]);
      
      if (rolesResult.rows.length === 0) {
        await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, false, '未分配角色');
        return res.status(403).json({
          status: 'Error',
          message: '此帳號尚未分配角色，請聯繫管理員'
        });
      }
      
      const roles = rolesResult.rows;
      
      // 5. 查詢使用者的所有權限 (根據角色取得，去重)
      const permissionsQuery = `
        SELECT DISTINCT
          p.permission_code,
          p.permission_name,
          p.resource,
          p.action
        FROM ${schemaName}.account_roles ar
        JOIN ${schemaName}.role_permissions rp ON ar.role_code = rp.role_code
        JOIN ${schemaName}.permissions p ON rp.permission_code = p.permission_code
        WHERE ar.account = $1
        ORDER BY p.resource, p.action;
      `;
      
      const permissionsResult = await pool.query(permissionsQuery, [account]);
      const permissions = permissionsResult.rows;
      
      // 6. 查詢客戶資訊 (如果有)
      let customerName = null;
      if (user.customer_id) {
        const customerQuery = `
          SELECT description as customername
          FROM ${schemaName}.customers
          WHERE id = $1;
        `;
        const customerResult = await pool.query(customerQuery, [user.customer_id]);
        if (customerResult.rows.length > 0) {
          customerName = customerResult.rows[0].customername;
        }
      }
      
      // 7. 建立 Token Payload
      const tokenPayload = createTokenPayload(user, roles, permissions);
      
      // 8. 產生 Access Token
      const accessToken = generateAccessToken(tokenPayload);
      
      // 9. 產生 Refresh Token
      const refreshTokenPayload = createRefreshTokenPayload(account, tokenPayload.tokenId);
      const refreshToken = generateRefreshToken(refreshTokenPayload);
      
      // 10. 儲存 Refresh Token 到資料庫
      const refreshTokenExpiresAt = calculateExpiresAt(REFRESH_TOKEN_EXPIRES_IN);
      const saveRefreshTokenQuery = `
        INSERT INTO ${schemaName}.refresh_tokens (account, token, expires_at)
        VALUES ($1, $2, $3)
        RETURNING id;
      `;
      
      await pool.query(saveRefreshTokenQuery, [account, refreshToken, refreshTokenExpiresAt]);
      
      // 11. 記錄成功登入
      await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, true, null);
      
      // 12. 回傳結果
      res.json({
        status: 'Success',
        message: '登入成功',
        data: {
          // 使用者資訊
          user: {
            account: user.account,
            name: user.description,
            customer_id: user.customer_id,
            customername: customerName,
            profile_image_url: user.profile_image_url
          },
          
          // 角色資訊
          roles: roles.map(r => ({
            code: r.role_code,
            name: r.role_name,
            level: r.level
          })),
          
          // 權限資訊
          permissions: permissions.map(p => p.permission_code),
          
          // Token
          accessToken,
          refreshToken,
          
          // Token 過期時間
          expiresIn: '15m',
          refreshExpiresIn: '7d'
        }
      });
      
    } catch (error) {
      console.error('登入錯誤:', error);
      await logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, false, '系統錯誤: ' + error.message);
      
      res.status(500).json({
        status: 'Error',
        message: '登入失敗，請稍後再試'
      });
    }
  });
  
  /**
   * POST /api/refresh-token
   * 使用 Refresh Token 取得新的 Access Token
   */
  router.post('/server/refresh-token', async (req, res) => {
    const { refreshToken } = req.body;
    
    try {
      if (!refreshToken) {
        return res.status(400).json({
          status: 'Error',
          message: '請提供 Refresh Token'
        });
      }
      
      // 1. 驗證 Refresh Token
      const { verifyRefreshToken } = require('../utils/jwtUtils');
      const decoded = verifyRefreshToken(refreshToken);
      
      if (!decoded) {
        return res.status(401).json({
          status: 'Error',
          message: 'Refresh Token 無效或已過期'
        });
      }
      
      // 2. 檢查 Refresh Token 是否在資料庫中且未被撤銷
      const checkTokenQuery = `
        SELECT id, account, revoked
        FROM ${schemaName}.refresh_tokens
        WHERE token = $1 AND expires_at > NOW();
      `;
      
      const tokenResult = await pool.query(checkTokenQuery, [refreshToken]);
      
      if (tokenResult.rows.length === 0) {
        return res.status(401).json({
          status: 'Error',
          message: 'Refresh Token 不存在或已過期'
        });
      }
      
      if (tokenResult.rows[0].revoked) {
        return res.status(401).json({
          status: 'Error',
          message: 'Refresh Token 已被撤銷'
        });
      }
      
      const account = tokenResult.rows[0].account;
      
      // 3. 重新查詢使用者資料、角色和權限 (與登入相同的邏輯)
      const accountQuery = `
        SELECT account, description, customer_id, profile_image_url
        FROM ${schemaName}.accounts
        WHERE account = $1;
      `;
      const accountResult = await pool.query(accountQuery, [account]);
      
      if (accountResult.rows.length === 0) {
        return res.status(401).json({
          status: 'Error',
          message: '使用者不存在'
        });
      }
      
      const user = accountResult.rows[0];
      
      // 查詢角色
      const rolesQuery = `
        SELECT r.role_code, r.role_name, r.level
        FROM ${schemaName}.account_roles ar
        JOIN ${schemaName}.roles r ON ar.role_code = r.role_code
        WHERE ar.account = $1
        ORDER BY r.level ASC;
      `;
      const rolesResult = await pool.query(rolesQuery, [account]);
      const roles = rolesResult.rows;
      
      // 查詢權限
      const permissionsQuery = `
        SELECT DISTINCT p.permission_code
        FROM ${schemaName}.account_roles ar
        JOIN ${schemaName}.role_permissions rp ON ar.role_code = rp.role_code
        JOIN ${schemaName}.permissions p ON rp.permission_code = p.permission_code
        WHERE ar.account = $1;
      `;
      const permissionsResult = await pool.query(permissionsQuery, [account]);
      const permissions = permissionsResult.rows;
      
      // 4. 產生新的 Access Token
      const tokenPayload = createTokenPayload(user, roles, permissions);
      const newAccessToken = generateAccessToken(tokenPayload);
      
      // 5. 回傳新的 Access Token
      res.json({
        status: 'Success',
        message: 'Token 刷新成功',
        data: {
          accessToken: newAccessToken,
          expiresIn: '15m'
        }
      });
      
    } catch (error) {
      console.error('刷新 Token 錯誤:', error);
      res.status(500).json({
        status: 'Error',
        message: 'Token 刷新失敗'
      });
    }
  });
  
  /**
   * POST /api/logout
   * 登出並撤銷 Refresh Token
   */
  router.post('/server/logout', async (req, res) => {
    const { refreshToken } = req.body;
    
    try {
      if (refreshToken) {
        // 撤銷 Refresh Token
        const revokeTokenQuery = `
          UPDATE ${schemaName}.refresh_tokens
          SET revoked = TRUE, revoked_at = NOW()
          WHERE token = $1;
        `;
        await pool.query(revokeTokenQuery, [refreshToken]);
      }
      
      res.json({
        status: 'Success',
        message: '登出成功'
      });
      
    } catch (error) {
      console.error('登出錯誤:', error);
      res.status(500).json({
        status: 'Error',
        message: '登出失敗'
      });
    }
  });  

  // 返回 router 物件
  return router;
};

/**
 * 記錄登入日誌
 */
async function logLoginAttempt(pool, schemaName, account, ipAddress, userAgent, success, failureReason) {
  try {
    const query = `
      INSERT INTO ${schemaName}.login_logs (account, ip_address, user_agent, success, failure_reason)
      VALUES ($1, $2, $3, $4, $5);
    `;
    await pool.query(query, [account || 'unknown', ipAddress, userAgent, success, failureReason]);
  } catch (error) {
    console.error('記錄登入日誌失敗:', error);
  }
}