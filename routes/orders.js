const express = require('express');
const router = express.Router();

// --- 全域資料定義 ---

// 這是為了確保插入時的欄位順序與資料表結構完全匹配
const PROCESS_RECORD_COLUMNS = [
    'uid', 'cust_id', 'qono', 'qo_date', 'ship_date', 'set_location', 'window_no', 'color_no', 'product', 'fabric', 
    'process', 'width', 'height', 'sewing_add', 'open_style', 'process_times', 'joining_fabric', 'symm_pattern', 
    'petal_qty', 'v_petal_length', 'h_petal_length', 'frames', 'least_qty', 'cutain_hem', 'label', 'band_type', 
    'iron', 'neck_style', 'sketch', 'hook_type', 'head_style', 'last_qty', 'urgent', 'pcs', 'qty_che', 'qty_yd', 
    'width_left', 'width_right', 'height_left', 'height_right', 'large_and_small', 'sew_together', 'st_group', 
    'comment', 'crew_cut', 'cust_name', 'unit', 'o_width_left', 'o_width_right', 'o_height', 'o_height_left', 
    'o_height_right', 'selfde_frames', 'band_needed', 'hook_qty', 'hook_length', 'lead', 'keep_pattern', 'process_qty', 
    'process_unit', 'join_fabric_qty_yd', 'join_fabric_qty_che', 'ship_type', 'shipping_locate', 'erp_custid', 
    'case_name', 'shared_fabric', 'shared_group', 'roman_track', 'process_frame_qty', 'band_qty', 'make_hole', 
    'hole_qty', 'velcro', 'velcro_qty', 'special_sew', 'hidden_sew', 'mark_line', 'side_loop_fasteners', 
    'band_with_velcro', 'band_on_side', 'iron_hole_qty', 'itemno', 'real_frame_width','o_width'
];

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

  // 取得預覽訂單號碼
router.get('/qo-orders/preview-number', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 'Q' || TO_CHAR(CURRENT_DATE, 'YYMM') || LPAD((last_value + 1)::TEXT, 5, '0') as preview_number
      FROM app_order.qo_order_number_seq
    `);

    res.json({
      previewNumber: result.rows[0].preview_number,
      note: '此為預覽號碼,實際號碼以儲存後為準'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// ========================================
// 2. 保留 qo_no (建立草稿主檔)
// ========================================
router.post('/qo-orders/reserve', async (req, res) => {
  const { custId, newCaseName, phone, address } = req.body;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 產生 qo_no 並建立草稿主檔
    const result = await client.query(`
      INSERT INTO ${schemaName}.qo_orders 
        (qono, cust_id, newcasename, phone, address, status)
      VALUES 
        (${schemaName}.generate_qo_order_number(), $1, $2, $3, $4, 'DRAFT')
      RETURNING *
    `, [custId, newCaseName, phone, address]);
    
    await client.query('COMMIT');
    
    console.log('訂單草稿已建立:', result.rows[0].qono);
    res.status(201).json({
      success: true,
      order: result.rows[0],
      qono: result.rows[0].qono
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error reserving qo_no:', error);
    res.status(500).json({
      success: false,
      message: '保留訂單號碼失敗',
      error: error.message,
      code: error.code
    });
  } finally {
    if (client) client.release();
  }
});



// ========================================
// 3. 新增明細記錄 (自動分配 uid 和 window_no)
// ========================================
router.post('/qo-orders/:qono/records', async (req, res) => {
  const { qono } = req.params;
  const recordData = req.body;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 檢查主檔是否存在
    const orderCheck = await client.query(
      `SELECT * FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該訂單,請先保留訂單號碼'
      });
    }
    
    // 檢查訂單狀態
    if (orderCheck.rows[0].status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '只能在草稿狀態下新增明細'
      });
    }
    
    // 取得下一個 uid
    const uidResult = await client.query(
      `SELECT ${schemaName}.get_next_uid($1) as next_uid`,
      [qono]
    );
    const uid = uidResult.rows[0].next_uid;
    
    // 取得當前最大的 window_no
    const windowResult = await client.query(
      `SELECT COALESCE(MAX(window_no), 0) + 1 as next_window_no 
       FROM ${schemaName}.process_record 
       WHERE qono = $1`,
      [qono]
    );
    const windowNo = windowResult.rows[0].next_window_no;
    
    // 準備插入資料
    // 覆蓋 recordData 中的 uid, qono, window_no
    recordData.uid = uid;
    recordData.qono = qono;
    recordData.window_no = windowNo;
    
    // 準備 SQL 查詢的參數陣列
    const values = PROCESS_RECORD_COLUMNS.map(col => 
      recordData[col] === undefined ? null : recordData[col]
    );
    
    // 建立 parameterized query 的 placeholder 字串
    const placeholders = PROCESS_RECORD_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
    
    // 建立完整的 SQL 語句
    const columns = PROCESS_RECORD_COLUMNS.join(', ');
    const sql = `INSERT INTO ${schemaName}.process_record (${columns}) VALUES (${placeholders}) RETURNING *`;
    
    // 執行插入操作
    const result = await client.query(sql, values);
    
    await client.query('COMMIT');
    
    console.log('明細記錄成功新增:', result.rows[0]);
    res.status(201).json({
      success: true,
      message: '明細記錄成功新增',
      record: result.rows[0],
      qono: qono,
      uid: uid,
      window_no: windowNo
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('新增明細記錄時發生錯誤:', error);
    res.status(400).json({
      success: false,
      message: '新增明細記錄失敗',
      error: error.message,
      code: error.code
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 4. 查詢訂單 (含所有明細)
// ========================================
router.get('/qo-orders/:qono', async (req, res) => {
  const { qono } = req.params;
  
  let client;
  
  try {
    client = await pool.connect();
    
    // 查詢主檔
    const orderResult = await client.query(
      `SELECT * FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '找不到該訂單'
      });
    }
    
    // 查詢明細 (依 window_no 排序)
    const recordsResult = await client.query(
      `SELECT * FROM ${schemaName}.process_record 
       WHERE qono = $1 
       ORDER BY window_no`,
      [qono]
    );
    
    res.json({
      success: true,
      order: {
        ...orderResult.rows[0],
        records: recordsResult.rows,
        recordCount: recordsResult.rows.length
      }
    });
    
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 5. 查詢訂單列表
// ========================================
router.get('/qo-orders', async (req, res) => {
  const { page = 1, limit = 100, status, custId, startDate, endDate, keyword } = req.query;
  // const { page = 1, limit = 20, status, custId } = req.query;
  // const offset = (page - 1) * limit;
  const offset = (parseInt(page) - 1) * parseInt(limit)
  try {
    // 建立查詢條件
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (custId) {
      whereClause += ` AND cust_id = $${paramIndex}`;
      params.push(custId);
      paramIndex++;
    }

// 3. 日期範圍篩選 (QODATE)
    if (startDate) {
      // 使用 >= 起始日期
      whereClause += ` AND o.qodate >= $${paramIndex}`;
      params.push(startDate); // 假設 startDate 格式為 'YYYY-MM-DD'
      paramIndex++;
    }
    
    if (endDate) {
      // 使用 <= 結束日期，確保包含該日期的所有訂單
      whereClause += ` AND o.qodate <= $${paramIndex}`;
      params.push(endDate); // 假設 endDate 格式為 'YYYY-MM-DD'
      paramIndex++;
    }

    // 4. 關鍵字模糊查詢 (QONO, NEWCASENAME, PHONE, ADDRESS)
    if (keyword) {
      const searchKeyword = `%${keyword.toLowerCase()}%`;
      whereClause += ` AND (
        LOWER(o.qono) LIKE $${paramIndex} OR
        LOWER(o.newcasename) LIKE $${paramIndex} OR
        LOWER(o.phone) LIKE $${paramIndex} OR
        LOWER(o.address) LIKE $${paramIndex}
      )`;
      params.push(searchKeyword);
      paramIndex++;
    }    

// 查詢訂單列表
    // 注意：LIMIT 和 OFFSET 的參數索引需要調整
    const ordersResult = await pool.query(
      `SELECT o.*, 
              (SELECT COUNT(*) FROM ${schemaName}.process_record WHERE qono = o.qono) as record_count
       FROM ${schemaName}.qo_orders o
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset] // 將 limit 和 offset 放在參數列表的最後
    );
    
    // 查詢總數
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schemaName}.qo_orders o ${whereClause}`,
      params
    );    
    
    res.json({
      success: true,
      orders: ordersResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
    
  } catch (error) {
    console.error('Error getting orders:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 6. 刪除明細記錄 (自動重排 window_no)
// ========================================
router.delete('/qo-orders/:qono/records/:uid', async (req, res) => {
  const { qono, uid } = req.params;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 檢查訂單狀態
    const orderCheck = await client.query(
      `SELECT status FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該訂單'
      });
    }
    
    if (orderCheck.rows[0].status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '只能刪除草稿狀態訂單的明細'
      });
    }
    
    // 刪除記錄 (trigger 會自動重排 window_no)
    const result = await client.query(
      `DELETE FROM ${schemaName}.process_record 
       WHERE qono = $1 AND uid = $2 
       RETURNING *`,
      [qono, uid]
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該明細記錄'
      });
    }
    
    await client.query('COMMIT');
    
    console.log('明細記錄已刪除:', qono, uid);
    res.json({
      success: true,
      message: '明細記錄已刪除',
      deletedRecord: result.rows[0]
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error deleting record:', error);
    res.status(500).json({
      success: false,
      message: '刪除明細記錄失敗',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 7. 更新明細記錄
// ========================================
router.put('/qo-orders/:qono/records/:uid', async (req, res) => {
  const { qono, uid } = req.params;
  const updateData = req.body;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 檢查訂單狀態
    const orderCheck = await client.query(
      `SELECT status FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該訂單'
      });
    }
    
    if (orderCheck.rows[0].status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '只能修改草稿狀態訂單的明細'
      });
    }
    
    // 建立更新語句
    // 過濾掉不該更新的欄位 (qono, uid, window_no)
    const forbiddenFields = ['qono', 'uid', 'window_no'];
    const updateFields = PROCESS_RECORD_COLUMNS.filter(col => 
      !forbiddenFields.includes(col) && updateData[col] !== undefined
    );
    
    if (updateFields.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '沒有可更新的欄位'
      });
    }
    
    // 建立 SET 子句
    const setClause = updateFields.map((col, index) => 
      `${col} = $${index + 3}`
    ).join(', ');
    
    const values = [qono, uid, ...updateFields.map(col => updateData[col])];
    
    // 執行更新
    const result = await client.query(
      `UPDATE ${schemaName}.process_record 
       SET ${setClause}, updated_at = NOW()
       WHERE qono = $1 AND uid = $2
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該明細記錄'
      });
    }
    
    await client.query('COMMIT');
    
    console.log('明細記錄已更新:', result.rows[0]);
    res.json({
      success: true,
      message: '明細記錄已更新',
      record: result.rows[0]
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating record:', error);
    res.status(400).json({
      success: false,
      message: '更新明細記錄失敗',
      error: error.message,
      code: error.code
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 8. 確認訂單 (將狀態從 DRAFT 改為 CONFIRMED)
// ========================================
router.post('/qo-orders/:qono/confirm', async (req, res) => {
  const { qono } = req.params;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 檢查是否有明細
    const recordCount = await client.query(
      `SELECT COUNT(*) as count FROM ${schemaName}.process_record WHERE qono = $1`,
      [qono]
    );
    
    if (parseInt(recordCount.rows[0].count) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '訂單至少需要一筆明細才能確認'
      });
    }
    
    // 更新狀態為 CONFIRMED
    const result = await client.query(
      `UPDATE ${schemaName}.qo_orders 
       SET status = 'CONFIRMED', updated_at = NOW()
       WHERE qono = $1 AND status = 'DRAFT'
       RETURNING *`,
      [qono]
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '訂單狀態異常或已確認'
      });
    }
    
    await client.query('COMMIT');
    
    console.log('訂單已確認:', qono);
    res.json({
      success: true,
      message: '訂單已確認',
      order: result.rows[0]
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error confirming order:', error);
    res.status(500).json({
      success: false,
      message: '確認訂單失敗',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 9. 取消/刪除草稿訂單
// ========================================
router.delete('/qo-orders/:qono', async (req, res) => {
  const { qono } = req.params;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 只能刪除草稿狀態的訂單
    const result = await client.query(
      `DELETE FROM ${schemaName}.qo_orders 
       WHERE qono = $1 AND status = 'DRAFT' 
       RETURNING *`,
      [qono]
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '只能刪除草稿狀態的訂單'
      });
    }
    
    // CASCADE 會自動刪除相關明細
    
    await client.query('COMMIT');
    
    console.log('訂單已刪除:', qono);
    res.json({
      success: true,
      message: '訂單已刪除'
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error deleting order:', error);
    res.status(500).json({
      success: false,
      message: '刪除訂單失敗',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});
// ========================================
// 10. 取得預覽窗號 (即時計算)
// ========================================
router.get('/qo-orders/:qono/preview-window-no', async (req, res) => {
  const { qono } = req.params;
  
  try {
    // 方法1: 使用資料庫函數
    const result = await pool.query(
      `SELECT ${schemaName}.get_preview_window_no($1) as preview_window_no`,
      [qono]
    );
        
    res.json({
      success: true,
      qono: qono,
      previewWindowNo: result.rows[0].preview_window_no,
      note: '此為預覽窗號,實際窗號以儲存後為準'
    });
    
  } catch (error) {
    console.error('Error getting preview window number:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 11. 查詢訂單uid明細
// ========================================
router.get('/qo-orders/:qono/records/:uid', async (req, res) => {
  const { qono, uid } = req.params;
  
  let client;
  
  try {
    client = await pool.connect();
        
    // 查詢明細 (依 window_no 排序)
    const recordsResult = await client.query(
      `SELECT * FROM ${schemaName}.process_record 
       WHERE qono = $1 and uid=$2
       ORDER BY window_no`,
      [qono, uid]
    );

    res.json({
        success: true,
        record: recordsResult.rows[0],
      }
    );
    
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } 
});


// ========================================
// 11. 取得客戶預設選項
// ========================================
router.get('/customer-defaults/:custId/:product', async (req, res) => {
  const { custId, product } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT element_id, value 
       FROM ${schemaName}.customer_default_options 
       WHERE cust_id = $1 AND product = $2
       ORDER BY element_id`,
      [custId, product]
    );
    
    // 轉換成 Map 格式,方便前端使用
    const defaults = {};
    result.rows.forEach(row => {
      defaults[row.element_id] = row.value;
    });
    
    res.json({
      success: true,
      custId: custId,
      product: product,
      defaults: defaults,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Error getting customer defaults:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 12. 統計草稿訂單數量
// ========================================
router.get('/qo-orders/draft-count/:custId', async (req, res) => {
  const { custId } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count 
       FROM ${schemaName}.qo_orders 
       WHERE cust_id = $1 AND status = 'DRAFT'`,
      [custId]
    );
    
    const count = parseInt(result.rows[0].count) || 0;
    
    res.json({
      success: true,
      custId: custId,
      draftCount: count
    });
    
  } catch (error) {
    console.error('Error getting draft count:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 根據色號查詢目錄資料
// GET /api/items/by-color/:colorNo
// ========================================
router.get('/items/by-color/:colorNo', async (req, res) => {
  const { colorNo } = req.params;
  
  console.log(`🔍 查詢色號: ${colorNo}`);
  
  try {
    // 查詢資料庫
    const query = `
      SELECT 
        item_no,
        color_no,
        list_price,
        unit,
        real_width,
        theoretical_width,
        pattern_height,
        class,
        description,
        fabric_type,
        remark,
        default_process
      FROM ${schemaName}.fabric_info
      WHERE color_no = $1
      LIMIT 1
    `;
     // ✅ PostgreSQL 正確用法
    const result = await pool.query(query, [colorNo]);
    const rows = result.rows;

    // const [rows] = await pool.query(query, [colorNo]);
    
    if (rows.length === 0) {
      console.log(`⚠️ 色號不存在: ${colorNo}`);
      return res.status(404).json({
        success: false,
        message: `色號 ${colorNo} 不存在於目錄中`
      });
    }
    
    const item = rows[0];
    
    console.log(`✅ 找到色號: ${colorNo}`, {
      item_no: item.item_no,
      fabric_type: item.fabric_type,
      default_process: item.default_process
    });
    
    res.json({
      success: true,
      item: {
        item_no: item.item_no,
        color_no: item.color_no,
        list_price: item.list_price,
        unit: item.unit,
        real_width: item.real_width,
        theoretical_width: item.theoretical_width,
        pattern_height: item.pattern_height,
        class: item.class,
        description: item.description,
        fabric_type: item.fabric_type,
        remark: item.remark,
        default_process: item.default_process
      }
    });
    
  } catch (error) {
    console.error('❌ 查詢色號失敗:', error);
    res.status(500).json({
      success: false,
      message: '查詢色號時發生錯誤',
      error: error.message
    });
  }
});
// ========================================
// 1. 計算訂單金額 (完整明細)
// POST /api/qo-orders/calculate-pricing
// ========================================
router.post('/qo-orders/calculate-pricing', async (req, res) => {
  const orderData = req.body;
  
  console.log('📊 開始計算訂單金額:', {
    cust_id: orderData.cust_id,
    color_no: orderData.color_no,
    product: orderData.product
  });
  
  let client;
  
  try {
    client = await pool.connect();
    
    // 呼叫計價函式
    const result = await client.query(
      `SELECT * FROM ${schemaName}.calculate_order_pricing($1::jsonb)`,
      [JSON.stringify(orderData)]
    );
    
    console.log(`✅ 計算完成，共 ${result.rows.length} 個項目`);
    
    res.json({
      success: true,
      items: result.rows,
      itemCount: result.rows.length
    });
    
  } catch (error) {
    console.error('❌ 計算訂單金額失敗:', error);
    res.status(500).json({
      success: false,
      message: '計算訂單金額失敗',
      error: error.message,
      detail: error.detail
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 2. 計算訂單金額 (格式化輸出，含中文欄位)
// POST /api/qo-orders/calculate-pricing-formatted
// ========================================
router.post('/qo-orders/calculate-pricing-formatted', async (req, res) => {
  const orderData = req.body;
  
  console.log('📊 開始計算訂單金額 (格式化):', {
    cust_id: orderData.cust_id,
    color_no: orderData.color_no,
    product: orderData.product
  });
  
  let client;
  
  try {
    client = await pool.connect();
    
    // 呼叫格式化計價函式
    const result = await client.query(
      `SELECT * FROM ${schemaName}.calculate_order_pricing_formatted($1::jsonb)`,
      [JSON.stringify(orderData)]
    );
    
    console.log(`✅ 計算完成，共 ${result.rows.length} 個項目`);
    
    res.json({
      success: true,
      items: result.rows,
      itemCount: result.rows.length
    });
    
  } catch (error) {
    console.error('❌ 計算訂單金額失敗:', error);
    res.status(500).json({
      success: false,
      message: '計算訂單金額失敗',
      error: error.message,
      detail: error.detail
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 3. 只取得訂單總計
// POST /api/qo-orders/calculate-total
// ========================================
router.post('/qo-orders/calculate-total', async (req, res) => {
  const orderData = req.body;
  
  console.log('💰 計算訂單總金額:', {
    cust_id: orderData.cust_id,
    color_no: orderData.color_no
  });
  
  let client;
  
  try {
    client = await pool.connect();
    
    // 呼叫總計函式
    const result = await client.query(
      `SELECT * FROM ${schemaName}.calculate_order_total($1::jsonb)`,
      [JSON.stringify(orderData)]
    );
    
    const totals = result.rows[0];
    
    console.log('✅ 總計計算完成:', {
      布料小計: totals['布料小計'],
      加工小計: totals['加工小計'],
      總金額: totals['總金額']
    });
    
    res.json({
      success: true,
      totals: {
        fabricSubtotal: parseFloat(totals['布料小計'] || 0),
        processSubtotal: parseFloat(totals['加工小計'] || 0),
        totalAmount: parseFloat(totals['總金額'] || 0),
        itemCount: parseInt(totals['項目數'] || 0)
      }
    });
    
  } catch (error) {
    console.error('❌ 計算總金額失敗:', error);
    res.status(500).json({
      success: false,
      message: '計算總金額失敗',
      error: error.message,
      detail: error.detail
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 1. 新增明細記錄時同時建立 order_detail
// ========================================
router.post('/qo-orders/:qono/records-with-detail', async (req, res) => {
  const { qono } = req.params;
  const recordData = req.body;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 1. 檢查主檔是否存在
    const orderCheck = await client.query(
      `SELECT * FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該訂單'
      });
    }
    
    // 2. 取得下一個 uid
    const uidResult = await client.query(
      `SELECT ${schemaName}.get_next_uid($1) as next_uid`,
      [qono]
    );
    const uid = uidResult.rows[0].next_uid;
    
    // 3. 取得 window_no
    const windowResult = await client.query(
      `SELECT COALESCE(MAX(window_no), 0) + 1 as next_window_no 
       FROM ${schemaName}.process_record 
       WHERE qono = $1`,
      [qono]
    );
    const windowNo = windowResult.rows[0].next_window_no;
    
    // 4. 插入 process_record
    recordData.uid = uid;
    recordData.qono = qono;
    recordData.window_no = windowNo;
    
    const values = PROCESS_RECORD_COLUMNS.map(col => 
      recordData[col] === undefined ? null : recordData[col]
    );
    
    const placeholders = PROCESS_RECORD_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
    const columns = PROCESS_RECORD_COLUMNS.join(', ');
    const sql = `INSERT INTO ${schemaName}.process_record (${columns}) VALUES (${placeholders}) RETURNING *`;
    
    const recordResult = await client.query(sql, values);
 

    // 5. 建立 order_data JSONB
    const orderData = {
      cust_id: recordData.cust_id,
      color_no: recordData.color_no,
      qty_yd: recordData.qty_yd,
      product: recordData.product,
      width: recordData.width,
      height: recordData.height,
      frames: recordData.frames,
      process_qty: recordData.process_qty,
      process_times: recordData.process_times,
      pcs: recordData.pcs,
      fabric:recordData.fabric,
      process:recordData.process,
      open_style:recordData.open_style,
      joining_fabric:recordData.joining_fabric,
      cutain_hem:recordData.cutain_hem,
      label:recordData.label,
      band_type:recordData.band_type,
      iron:recordData.iron,
      lead:recordData.lead,
      hook_type:recordData.hook_type,
      neck_style:recordData.neck_style,
      band_with_velcro:recordData.band_with_velcro,
      urgent:recordData.urgent,
      band_on_side:recordData.band_on_side,
      make_hole:recordData.make_hole,
      velcro:recordData.velcro,
      mark_line:recordData.mark_line,
      special_sew:recordData.special_sew,
      side_loop_fasteners:recordData.side_loop_fasteners,
      hidden_sew:recordData.hidden_sew,
      
    };
    
    // 6. 插入 order_detail
    const detailResult = await client.query(
      `SELECT ${schemaName}.insert_order_detail($1, $2, $3, $4::jsonb) as inserted_count`,
      [qono, uid, windowNo, JSON.stringify(orderData)]
    );
    
    const insertedCount = detailResult.rows[0].inserted_count;
    
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      message: '明細記錄和計價明細成功新增',
      record: recordResult.rows[0],
      qono: qono,
      uid: uid,
      window_no: windowNo,
      detail_count: insertedCount
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('新增明細記錄時發生錯誤:', error);
    res.status(400).json({
      success: false,
      message: '新增明細記錄失敗',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});


// ========================================
// 2. 查詢 order_detail
// ========================================
router.get('/qo-orders/:qono/order-details', async (req, res) => {
  const { qono } = req.params;
  const { uid } = req.query;
  
  try {
    let query;
    let params;
    
    if (uid) {
      // 查詢特定 uid 的明細
      query = `
        SELECT * FROM ${schemaName}.order_detail 
        WHERE qono = $1 AND uid = $2 
        ORDER BY seq_no
      `;
      params = [qono, uid];
    } else {
      // 查詢整個訂單的所有明細
      query = `
        SELECT * FROM ${schemaName}.order_detail 
        WHERE qono = $1 
        ORDER BY uid, seq_no
      `;
      params = [qono];
    }
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      qono: qono,
      uid: uid || null,
      details: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('查詢 order_detail 失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 3. 查詢訂單總金額統計
// ========================================
router.get('/qo-orders/:qono/order-summary', async (req, res) => {
  const { qono } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        qono,
        COUNT(DISTINCT uid) as record_count,
        COUNT(*) as detail_count,
        SUM(origin_amount) as total_origin_amount,
        SUM(amount) as total_amount,
        SUM(amount) - SUM(origin_amount) as total_discount_amount
      FROM ${schemaName}.order_detail 
      WHERE qono = $1
      GROUP BY qono
    `, [qono]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '找不到該訂單的明細'
      });
    }
    
    res.json({
      success: true,
      summary: result.rows[0]
    });
    
  } catch (error) {
    console.error('查詢訂單摘要失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// 🌟 新增 1: 更新明細記錄並同步更新 order_detail
// PUT /api/qo-orders/:qono/records-with-detail/:uid
// ========================================
router.put('/qo-orders/:qono/records-with-detail/:uid', async (req, res) => {
  const { qono, uid } = req.params;
  const updateData = req.body;
  
  let client;
  
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // 1. 檢查訂單狀態
    const orderCheck = await client.query(
      `SELECT status FROM ${schemaName}.qo_orders WHERE qono = $1`,
      [qono]
    );
    
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該訂單'
      });
    }
    
    if (orderCheck.rows[0].status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '只能修改草稿狀態訂單的明細'
      });
    }
    
    // 2. 檢查 uid 是否存在
    const recordCheck = await client.query(
      `SELECT window_no FROM ${schemaName}.process_record WHERE qono = $1 AND uid = $2`,
      [qono, uid]
    );
    
    if (recordCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: '找不到該明細記錄'
      });
    }
    
    const windowNo = recordCheck.rows[0].window_no;
    
    // 3. 更新 process_record
    const forbiddenFields = ['qono', 'uid', 'window_no'];
    const updateFields = PROCESS_RECORD_COLUMNS.filter(col => 
      !forbiddenFields.includes(col) && updateData[col] !== undefined
    );
    
    if (updateFields.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: '沒有可更新的欄位'
      });
    }
    
    const setClause = updateFields.map((col, index) => 
      `${col} = $${index + 3}`
    ).join(', ');
    
    const values = [qono, uid, ...updateFields.map(col => updateData[col])];
    
    const recordResult = await client.query(
      `UPDATE ${schemaName}.process_record 
       SET ${setClause}, updated_at = NOW()
       WHERE qono = $1 AND uid = $2
       RETURNING *`,
      values
    );
    
    // 4. 刪除舊的 order_detail
    await client.query(
      `DELETE FROM ${schemaName}.order_detail 
       WHERE qono = $1 AND uid = $2`,
      [qono, uid]
    );
    
    console.log(`🗑️ 已刪除 order_detail (qono: ${qono}, uid: ${uid})`);
    
    // 5. 重新建立 order_detail
    const orderData = {
      cust_id: updateData.cust_id,
      color_no: updateData.color_no,
      qty_yd: updateData.qty_yd,
      product: updateData.product,
      width: updateData.width,
      height: updateData.height,
      frames: updateData.frames,
      process_qty: updateData.process_qty,
      process_times: updateData.process_times,
      pcs: updateData.pcs,
      fabric: updateData.fabric,
      process: updateData.process,
      open_style: updateData.open_style,
      joining_fabric: updateData.joining_fabric,
      cutain_hem: updateData.cutain_hem,
      label: updateData.label,
      band_type: updateData.band_type,
      iron: updateData.iron,
      lead: updateData.lead,
      hook_type: updateData.hook_type,
      neck_style: updateData.neck_style,
      band_with_velcro: updateData.band_with_velcro,
      urgent: updateData.urgent,
      band_on_side: updateData.band_on_side,
      make_hole: updateData.make_hole,
      velcro: updateData.velcro,
      mark_line: updateData.mark_line,
      special_sew: updateData.special_sew,
      side_loop_fasteners: updateData.side_loop_fasteners,
      hidden_sew: updateData.hidden_sew,
    };
    
    const detailResult = await client.query(
      `SELECT ${schemaName}.insert_order_detail($1, $2, $3, $4::jsonb) as inserted_count`,
      [qono, uid, windowNo, JSON.stringify(orderData)]
    );
    
    const insertedCount = detailResult.rows[0].inserted_count;
    
    console.log(`✅ 已重新建立 ${insertedCount} 筆 order_detail`);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: '明細記錄和計價明細已更新',
      record: recordResult.rows[0],
      qono: qono,
      uid: parseInt(uid),
      window_no: windowNo,
      detail_count: insertedCount
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('更新明細記錄時發生錯誤:', error);
    res.status(400).json({
      success: false,
      message: '更新明細記錄失敗',
      error: error.message,
      detail: error.detail
    });
  } finally {
    if (client) client.release();
  }
});

// ========================================
// 🌟 新增 2: 查詢特定 UID 的 order_detail（用於修改頁面載入）
// GET /api/qo-orders/:qono/order-details/:uid
// ========================================
router.get('/qo-orders/:qono/order-details/:uid', async (req, res) => {
  const { qono, uid } = req.params;
  
  try {
    // 查詢該 uid 的所有計價明細
    const result = await pool.query(`
      SELECT 
        qono,
        uid,
        window_no,
        seq_no,
        product,
        color_no,
        itemno,
        description,
        width,
        height,
        qty
        unit,
        list_price,
        pcs,
        discount,
        unit_price,
        origin_amount,
        amount,
        pmcode,
        stock_qty,
        stock_unit,
        item_type
      FROM ${schemaName}.order_detail 
      WHERE qono = $1 AND uid = $2 
      ORDER BY seq_no
    `, [qono, parseInt(uid)]);
    
    if (result.rows.length === 0) {
      // 該 UID 尚未建立計價明細（正常情況）
      return res.status(404).json({
        success: false,
        message: '該明細尚未建立計價資料',
        qono: qono,
        uid: parseInt(uid)
      });
    }
    
    // 計算統計資訊
    let fabricSubtotal = 0;
    let processSubtotal = 0;
    
    result.rows.forEach(item => {
      const amount = parseFloat(item.amount || 0);
      if (item.item_type === 'FABRIC') {
        fabricSubtotal += amount;
      } else if (item.item_type === 'PROCESS') {
        processSubtotal += amount;
      }
    });
    
    const totalAmount = fabricSubtotal + processSubtotal;
    
    res.json({
      success: true,
      qono: qono,
      uid: parseInt(uid),
      window_no: result.rows[0].window_no,
      items: result.rows,
      summary: {
        item_count: result.rows.length,
        fabric_subtotal: fabricSubtotal,
        process_subtotal: processSubtotal,
        total_amount: totalAmount
      }
    });
    
  } catch (error) {
    console.error('查詢 order_detail 失敗:', error);
    res.status(500).json({
      success: false,
      message: '查詢計價明細失敗',
      error: error.message
    });
  }
});

  // 返回 router 物件
  return router;
};