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
    'band_with_velcro', 'band_on_side', 'iron_hole_qty', 'itemno', 'real_frame_width'
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
    // const ordersResult = await pool.query(
    //   `SELECT o.*, 
    //           (SELECT COUNT(*) FROM ${schemaName}.process_record WHERE qono = o.qono) as record_count
    //    FROM ${schemaName}.qo_orders o
    //    ${whereClause}
    //    ORDER BY o.created_at DESC
    //    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    //   [...params, limit, offset] // 將 limit 和 offset 放在參數列表的最後
    // );
    
    // // 查詢總數
    // const countResult = await pool.query(
    //   `SELECT COUNT(*) FROM ${schemaName}.qo_orders o ${whereClause}`,
    //   params
    // );    

    // 查詢訂單列表
    const ordersResult = await pool.query(
      `SELECT o.*, 
              (SELECT COUNT(*) FROM ${schemaName}.process_record WHERE qono = o.qono) as record_count
       FROM ${schemaName}.qo_orders o
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );
    
    // 查詢總數
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schemaName}.qo_orders ${whereClause}`,
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

// 新增 API 端點：處理新增紀錄到 testapi.process_record (POST)
router.post('/add-record', async (req, res) => {
    let client;
    const recordData = req.body; // 獲取從 Flutter 傳來的 JSON 資料

    // 1. 準備 SQL 查詢的參數陣列
    // 按照 PROCESS_RECORD_COLUMNS 的順序，從 recordData 中提取值
    // 如果欄位在 recordData 中不存在，則使用 null
    const values = PROCESS_RECORD_COLUMNS.map(col => recordData[col] === undefined ? null : recordData[col]);
    
    // 2. 建立 parameterized query 的 placeholder 字串 ($1, $2, ...)
    const placeholders = PROCESS_RECORD_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
    
    // 3. 建立完整的 SQL 語句
    const columns = PROCESS_RECORD_COLUMNS.join(', ');
    const sql = `INSERT INTO ${schemaName}.process_record (${columns}) VALUES (${placeholders})`;

    try {
        client = await pool.connect();
        
        // 執行插入操作
        const result = await client.query(sql, values);

        console.log('紀錄成功新增:', result.rowCount, '列');
        res.status(201).json({ 
            message: '紀錄成功新增', 
            // 返回關鍵識別資訊，方便前端確認
            qono: recordData.qono, 
            uid: recordData.uid 
        });

    } catch (err) {
        // 處理資料庫錯誤，例如資料型別不匹配或 PRIMARY KEY 衝突
        console.error('新增紀錄時發生錯誤', err.message);
        // 返回 400 Bad Request 或 500 Internal Server Error
        res.status(400).json({ 
            error: '新增紀錄失敗', 
            details: err.message,
            code: err.code // 返回 PostgreSQL 錯誤碼 (例如 23505 for unique_violation)
        });
    } finally {
        // 確保釋放連線
        if (client) {
            client.release();
        }
    }
});
  // 返回 router 物件
  return router;
};