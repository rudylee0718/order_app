// services/groupService.js

const { 
  generateGroupId, 
  generateGroupMemberId, 
  generateGroupConversationId 
} = require('../utils/idGenerator');

/**
 * 群組服務 - 處理群組相關的業務邏輯
 */
class GroupService {
  constructor(pool, schemaName) {
    this.pool = pool;
    this.schemaName = schemaName;
  }

  /**
   * 建立群組
   * @param {string} groupName - 群組名稱
   * @param {string} createdBy - 創建者帳號
   * @param {string} description - 群組描述
   * @param {Array<string>} memberAccounts - 成員帳號列表
   * @returns {Promise<Object>} 群組資訊
   */
  async createGroup(groupName, createdBy, description, memberAccounts = []) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      const groupId = generateGroupId();

      // 建立群組
      const result = await client.query(`
        INSERT INTO ${this.schemaName}.chat_groups (
          group_id, group_name, group_description, 
          created_by, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING created_at
      `, [groupId, groupName, description || null, createdBy]);

      const createdAt = result.rows[0].created_at;

      // 新增創建者為管理員
      await client.query(`
        INSERT INTO ${this.schemaName}.group_members (
          member_id, group_id, user_account, role, joined_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `, [generateGroupMemberId(), groupId, createdBy, 'admin', createdAt]);

      // 新增其他成員
      const allMembers = [createdBy];
      if (memberAccounts && Array.isArray(memberAccounts)) {
        for (const account of memberAccounts) {
          if (account !== createdBy) {
            await client.query(`
              INSERT INTO ${this.schemaName}.group_members (
                member_id, group_id, user_account, role, joined_at
              )
              VALUES ($1, $2, $3, $4, $5)
            `, [generateGroupMemberId(), groupId, account, 'member', createdAt]);
            allMembers.push(account);
          }
        }
      }

      // 初始化群組對話摘要
      for (const account of allMembers) {
        await client.query(`
          INSERT INTO ${this.schemaName}.group_conversations (
            conversation_id, group_id, user_account,
            last_message, last_message_time, unread_count
          )
          VALUES ($1, $2, $3, $4, $5, 0)
        `, [generateGroupConversationId(), groupId, account, '', createdAt]);
      }

      await client.query('COMMIT');

      return {
        groupId,
        groupName,
        groupDescription: description,
        createdBy,
        createdAt
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 取得用戶所屬的群組列表
   * @param {string} account - 用戶帳號
   * @returns {Promise<Array>} 群組列表
   */
  async getUserGroups(account) {
    const result = await this.pool.query(`
      SELECT 
        g.group_id,
        g.group_name,
        g.group_description,
        g.created_by,
        g.created_at,
        g.updated_at,
        gm.role,
        gm.joined_at,
        gc.last_message,
        gc.last_message_time,
        gc.unread_count,
        (SELECT COUNT(*) FROM ${this.schemaName}.group_members 
         WHERE group_id = g.group_id) as member_count
      FROM ${this.schemaName}.chat_groups g
      JOIN ${this.schemaName}.group_members gm ON g.group_id = gm.group_id
      LEFT JOIN ${this.schemaName}.group_conversations gc 
        ON g.group_id = gc.group_id AND gc.user_account = $1
      WHERE gm.user_account = $1
      ORDER BY gc.updated_at DESC NULLS LAST, g.updated_at DESC
    `, [account]);

    return result.rows;
  }

  /**
   * 取得群組詳情
   * @param {string} groupId - 群組 ID
   * @returns {Promise<Object>} 群組詳情
   */
  async getGroupDetails(groupId) {
    const result = await this.pool.query(`
      SELECT 
        g.*,
        u.description as creator_name,
        (SELECT COUNT(*) FROM ${this.schemaName}.group_members 
         WHERE group_id = g.group_id) as member_count
      FROM ${this.schemaName}.chat_groups g
      JOIN ${this.schemaName}.accounts u ON g.created_by = u.account
      WHERE g.group_id = $1
    `, [groupId]);

    if (result.rows.length === 0) {
      throw new Error('群組不存在');
    }

    return result.rows[0];
  }

  /**
   * 取得群組成員列表
   * @param {string} groupId - 群組 ID
   * @returns {Promise<Array>} 成員列表
   */
  async getGroupMembers(groupId) {
    const result = await this.pool.query(`
      SELECT 
        gm.member_id,
        gm.group_id,
        gm.user_account,
        gm.role,
        gm.joined_at,
        gm.last_read_message_id,
        u.description as member_name,
        u.customer_id
      FROM ${this.schemaName}.group_members gm
      JOIN ${this.schemaName}.accounts u ON gm.user_account = u.account
      WHERE gm.group_id = $1
      ORDER BY 
        CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END,
        gm.joined_at ASC
    `, [groupId]);

    return result.rows;
  }

  /**
   * 新增群組成員
   * @param {string} groupId - 群組 ID
   * @param {string} userAccount - 用戶帳號
   * @param {string} role - 角色 (member/admin)
   */
  async addGroupMember(groupId, userAccount, role = 'member') {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 檢查用戶是否已在群組中
      const checkResult = await client.query(
        `SELECT * FROM ${this.schemaName}.group_members 
         WHERE group_id = $1 AND user_account = $2`,
        [groupId, userAccount]
      );

      if (checkResult.rows.length > 0) {
        throw new Error('該用戶已在群組中');
      }

      // 新增成員
      const result = await client.query(`
        INSERT INTO ${this.schemaName}.group_members (
          member_id, group_id, user_account, role, joined_at
        )
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING joined_at
      `, [generateGroupMemberId(), groupId, userAccount, role]);

      const joinedAt = result.rows[0].joined_at;

      // 初始化該成員的群組對話摘要
      await client.query(`
        INSERT INTO ${this.schemaName}.group_conversations (
          conversation_id, group_id, user_account,
          last_message, last_message_time, unread_count
        )
        VALUES ($1, $2, $3, $4, $5, 0)
      `, [generateGroupConversationId(), groupId, userAccount, '', joinedAt]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 移除群組成員
   * @param {string} groupId - 群組 ID
   * @param {string} userAccount - 用戶帳號
   */
  async removeGroupMember(groupId, userAccount) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 檢查是否為創建者
      const groupResult = await client.query(
        `SELECT created_by FROM ${this.schemaName}.chat_groups WHERE group_id = $1`,
        [groupId]
      );

      if (groupResult.rows.length === 0) {
        throw new Error('群組不存在');
      }

      if (groupResult.rows[0].created_by === userAccount) {
        throw new Error('無法移除群組創建者');
      }

      // 移除成員
      const deleteResult = await client.query(
        `DELETE FROM ${this.schemaName}.group_members 
         WHERE group_id = $1 AND user_account = $2`,
        [groupId, userAccount]
      );

      if (deleteResult.rowCount === 0) {
        throw new Error('該用戶不在群組中');
      }

      // 刪除該成員的群組對話摘要
      await client.query(
        `DELETE FROM ${this.schemaName}.group_conversations 
         WHERE group_id = $1 AND user_account = $2`,
        [groupId, userAccount]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新群組資訊
   * @param {string} groupId - 群組 ID
   * @param {Object} updates - 要更新的欄位
   */
  async updateGroupInfo(groupId, updates) {
    const { groupName, description } = updates;

    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (groupName) {
      updateFields.push(`group_name = $${paramCount++}`);
      values.push(groupName);
    }

    if (description !== undefined) {
      updateFields.push(`group_description = $${paramCount++}`);
      values.push(description);
    }

    if (updateFields.length === 0) {
      throw new Error('沒有要更新的欄位');
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(groupId);

    await this.pool.query(`
      UPDATE ${this.schemaName}.chat_groups 
      SET ${updateFields.join(', ')}
      WHERE group_id = $${paramCount}
    `, values);
  }

  /**
   * 搜尋群組
   * @param {string} keyword - 搜尋關鍵字
   * @returns {Promise<Array>} 群組列表
   */
  async searchGroups(keyword) {
    const result = await this.pool.query(`
      SELECT 
        g.*,
        (SELECT COUNT(*) FROM ${this.schemaName}.group_members 
         WHERE group_id = g.group_id) as member_count
      FROM ${this.schemaName}.chat_groups g
      WHERE g.group_name ILIKE $1
      ORDER BY g.updated_at DESC
      LIMIT 50
    `, [`%${keyword}%`]);

    return result.rows;
  }

  /**
   * 取得群組未讀訊息總數
   * @param {string} account - 用戶帳號
   * @returns {Promise<number>} 未讀訊息數量
   */
  async getGroupUnreadCount(account) {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(unread_count), 0) as total_unread 
       FROM ${this.schemaName}.group_conversations 
       WHERE user_account = $1`,
      [account]
    );

    return parseInt(result.rows[0].total_unread);
  }
}

module.exports = GroupService;