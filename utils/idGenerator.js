// utils/idGenerator.js

/**
 * 生成唯一 ID
 * @param {string} prefix - ID 前綴 (例如: 'msg', 'group', 'gm', 'gconv')
 * @returns {string} 唯一 ID
 */
function generateId(prefix) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * 生成對話 ID
 * @param {string} account1 - 帳號1
 * @param {string} account2 - 帳號2
 * @returns {string} 對話 ID
 */
function generateConversationId(account1, account2) {
  return `conv_${account1}_${account2}`;
}

/**
 * 生成訊息 ID
 * @returns {string} 訊息 ID
 */
function generateMessageId() {
  return generateId('msg');
}

/**
 * 生成群組 ID
 * @returns {string} 群組 ID
 */
function generateGroupId() {
  return generateId('group');
}

/**
 * 生成群組成員 ID
 * @returns {string} 群組成員 ID
 */
function generateGroupMemberId() {
  return generateId('gm');
}

/**
 * 生成群組對話 ID
 * @returns {string} 群組對話 ID
 */
function generateGroupConversationId() {
  return generateId('gconv');
}

/**
 * 生成圖片 ID
 * @param {string} messageId - 訊息 ID
 * @param {number} index - 圖片索引
 * @returns {string} 圖片 ID
 */
function generateImageId(messageId, index) {
  return `img_${messageId}_${index}`;
}

module.exports = {
  generateId,
  generateConversationId,
  generateMessageId,
  generateGroupId,
  generateGroupMemberId,
  generateGroupConversationId,
  generateImageId
};