// routes/conversation/groups.js

const express = require('express');
const router = express.Router();
const { validateRequired, validateAccount, validateGroupName } = require('../../middleware/validation');
const { asyncHandler } = require('../../middleware/errorHandler');
const GroupService = require('../../services/groupService');

module.exports = (pool, schemaName) => {
  const groupService = new GroupService(pool, schemaName);

  /**
   * POST /api/groups/create
   * 建立群組
   */
  router.post('/create',
    validateRequired(['groupName', 'createdBy']),
    validateGroupName,
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupName, createdBy, description, memberAccounts } = req.body;

      const group = await groupService.createGroup(
        groupName,
        createdBy,
        description,
        memberAccounts
      );

      res.json({
        success: true,
        message: '群組建立成功',
        group
      });
    })
  );

  /**
   * GET /api/groups/user/:account
   * 取得用戶所屬的群組列表
   */
  router.get('/user/:account',
    validateAccount,
    asyncHandler(async (req, res) => {
      const { account } = req.params;

      const groups = await groupService.getUserGroups(account);

      res.json({
        success: true,
        groups
      });
    })
  );

  /**
   * GET /api/groups/:groupId
   * 取得群組詳情
   */
  router.get('/:groupId',
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;

      const group = await groupService.getGroupDetails(groupId);

      res.json({
        success: true,
        group
      });
    })
  );

  /**
   * GET /api/groups/:groupId/members
   * 取得群組成員列表
   */
  router.get('/:groupId/members',
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;

      const members = await groupService.getGroupMembers(groupId);

      res.json({
        success: true,
        members
      });
    })
  );

  /**
   * POST /api/groups/:groupId/members/add
   * 新增群組成員
   */
  router.post('/:groupId/members/add',
    validateRequired(['userAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { userAccount, role = 'member' } = req.body;

      await groupService.addGroupMember(groupId, userAccount, role);

      res.json({
        success: true,
        message: '成員新增成功'
      });
    })
  );

  /**
   * DELETE /api/groups/:groupId/members/remove
   * 移除群組成員
   */
  router.delete('/:groupId/members/remove',
    validateRequired(['userAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { userAccount } = req.body;

      await groupService.removeGroupMember(groupId, userAccount);

      res.json({
        success: true,
        message: '成員移除成功'
      });
    })
  );

  /**
   * POST /api/groups/:groupId/leave
   * 退出群組
   */
  router.post('/:groupId/leave',
    validateRequired(['userAccount']),
    validateAccount,
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { userAccount } = req.body;

      await groupService.removeGroupMember(groupId, userAccount);

      res.json({
        success: true,
        message: '已退出群組'
      });
    })
  );

  /**
   * PUT /api/groups/:groupId/update
   * 更新群組資訊
   */
  router.put('/:groupId/update',
    asyncHandler(async (req, res) => {
      const { groupId } = req.params;
      const { groupName, description } = req.body;

      await groupService.updateGroupInfo(groupId, { groupName, description });

      res.json({
        success: true,
        message: '群組資訊更新成功'
      });
    })
  );

  /**
   * GET /api/groups/search
   * 搜尋群組
   */
  router.get('/search',
    validateRequired(['q']),
    asyncHandler(async (req, res) => {
      const { q } = req.query;

      const groups = await groupService.searchGroups(q);

      res.json({
        success: true,
        groups
      });
    })
  );

  /**
   * GET /api/groups/unread/count/:account
   * 取得群組未讀訊息數量
   */
  router.get('/unread/count/:account',
    validateAccount,
    asyncHandler(async (req, res) => {
      const { account } = req.params;

      const count = await groupService.getGroupUnreadCount(account);

      res.json({
        success: true,
        count
      });
    })
  );

  return router;
};