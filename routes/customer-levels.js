// routes/customer-levels.js
// 掛載：app.use('/api/customer-levels', require('./routes/customer-levels')(pool, schemaName))

const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ──────────────────────────────────────────────
  // 輔助：產生版本號 YYMMXXXXXX
  // ──────────────────────────────────────────────
  async function generateVersionCode(client, year, month) {
    const yy     = String(year).slice(-2).padStart(2, '0');
    const mm     = String(month).padStart(2, '0');
    const prefix = `${yy}${mm}`;
    const result = await client.query(`
      SELECT version_code
      FROM ${schemaName}.customer_level_versions
      WHERE version_code LIKE $1
      ORDER BY version_code DESC LIMIT 1
    `, [`${prefix}%`]);
    const seq = result.rows.length > 0 ? parseInt(result.rows[0].version_code.slice(4)) + 1 : 1;
    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  // ──────────────────────────────────────────────
  // 輔助：找出某客戶的 active 版本（今天在區間，start最近優先，code最新次之）
  // ──────────────────────────────────────────────
  async function getActiveVersion(client, customerId) {
    const r = await client.query(`
      SELECT version_code
      FROM ${schemaName}.customer_level_versions
      WHERE cust_id = $1
        AND start_date <= CURRENT_DATE
        AND end_date   >= CURRENT_DATE
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `, [customerId]);
    return r.rows.length > 0 ? r.rows[0].version_code : null;
  }

  // ──────────────────────────────────────────────
  // 輔助：找出某日期區間對應的 active products_grade_version
  // 規則：在 [start_date, end_date] 區間內的 grade version，
  //       取 start_date 最近 + version_code 最新
  // ──────────────────────────────────────────────
  async function getEffectiveGradeVersion(client, targetDate) {
    const r = await client.query(`
      SELECT version_code, start_date::text AS start_date, end_date::text AS end_date
      FROM ${schemaName}.products_grade_versions
      WHERE start_date <= $1 AND end_date >= $1
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `, [targetDate]);
    return r.rows.length > 0 ? r.rows[0] : null;
  }

  // ══════════════════════════════════════════════
  // 1. 查詢客戶清單（含 active 版本資訊）
  // GET /api/customer-levels/customers
  //   ?search=&page=&limit=
  // ══════════════════════════════════════════════
  router.get('/customers',
    authenticateToken,
    requirePermission('sales:customer-level:read'),
    async (req, res) => {
      try {
        const { search = '', page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;
        const params = [];

        let where = 'WHERE c.status = \'active\'';
        if (search) {
          params.push(`%${search}%`);
          where += ` AND (c.id ILIKE $${params.length} OR c.description ILIKE $${params.length})`;
        }

        const countR = await pool.query(
          `SELECT COUNT(*) FROM ${schemaName}.customers c ${where}`, params
        );

        // 同時算出每個客戶的 active version + 版本總數
        const dataR = await pool.query(`
          SELECT
            c.id, c.description, c.tel, c.address, c.status,
            (
              SELECT version_code
              FROM ${schemaName}.customer_level_versions v
              WHERE v.cust_id = c.id
                AND v.start_date <= CURRENT_DATE
                AND v.end_date   >= CURRENT_DATE
              ORDER BY v.start_date DESC, v.version_code DESC
              LIMIT 1
            ) AS active_version_code,
            (
              SELECT COUNT(*)
              FROM ${schemaName}.customer_level_versions v2
              WHERE v2.cust_id = c.id
            ) AS version_count
          FROM ${schemaName}.customers c
          ${where}
          ORDER BY c.id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
          status: 'Success',
          customers: dataR.rows,
          total: parseInt(countR.rows[0].count),
          page: parseInt(page),
          totalPages: Math.ceil(parseInt(countR.rows[0].count) / limit)
        });
      } catch (err) {
        console.error('❌ 查詢客戶失敗:', err);
        res.status(500).json({ status: 'Error', message: '查詢客戶失敗', error: err.message });
      }
    }
  );

   // ══════════════════════════════════════════════
  // 2. 查詢某客戶的版本清單
  // GET /api/customer-levels/:customerId/versions
  // ══════════════════════════════════════════════
  router.get('/:customerId/versions',
    authenticateToken,
    requirePermission('sales:customer-level:read'),
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const client = await pool.connect();
 
        const activeCode = await getActiveVersion(client, customerId);
        client.release();
 
        const result = await pool.query(`
          SELECT
            v.version_code, v.cust_id, v.start_date::text AS start_date, v.end_date::text AS end_date,
            v.ref_grade_version, v.remark,
            v.created_at, v.updated_at, v.created_by, v.updated_by,
            COUNT(r.id) AS row_count
          FROM ${schemaName}.customer_level_versions v
          LEFT JOIN ${schemaName}.customer_level_rows r ON r.version_code = v.version_code
          WHERE v.cust_id = $1
          GROUP BY v.version_code, v.cust_id, v.start_date, v.end_date,
                   v.ref_grade_version, v.remark, v.created_at, v.updated_at,
                   v.created_by, v.updated_by
          ORDER BY v.version_code DESC
        `, [customerId]);
 
        res.json({
          status: 'Success',
          versions: result.rows,
          active_version_code: activeCode
        });
      } catch (err) {
        console.error('❌ 查詢版本清單失敗:', err);
        res.status(500).json({ status: 'Error', message: '查詢版本清單失敗', error: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 3. 查詢版本明細（含折扣資訊）
  // GET /api/customer-levels/:customerId/versions/:versionCode/rows
  // ══════════════════════════════════════════════
  router.get('/:customerId/versions/:versionCode/rows',
    authenticateToken,
    requirePermission('sales:customer-level:read'),
    async (req, res) => {
      try {
        const { versionCode } = req.params;

        const result = await pool.query(`
          SELECT
            r.id, r.version_code, r.class_code, r.class_name,
            r.grade, r.discount, r.pmcode, r.remark,
            r.created_at, r.updated_at, r.created_by, r.updated_by
          FROM ${schemaName}.customer_level_rows r
          WHERE r.version_code = $1
          ORDER BY r.class_code ASC
        `, [versionCode]);

        res.json({ status: 'Success', rows: result.rows });
      } catch (err) {
        console.error('❌ 查詢版本明細失敗:', err);
        res.status(500).json({ status: 'Error', message: '查詢版本明細失敗', error: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 4. 查詢某日期對應的可用等級（建立/編輯版本時使用）
  // GET /api/customer-levels/available-grades?date=2026-03-17
  //   回傳：{ grade_version, rows: [{class_code, grade, discount, pmcode}] }
  //   同一 class 可能有多個 grade（A/B/C/D/E）
  // ══════════════════════════════════════════════
  router.get('/available-grades',
    authenticateToken,
    requirePermission('sales:customer-level:read'),
    async (req, res) => {
      try {
        const { date } = req.query;
        const targetDate = date || new Date().toISOString().slice(0, 10);

        const client = await pool.connect();
        const gradeVer = await getEffectiveGradeVersion(client, targetDate);
        client.release();

        if (!gradeVer) {
          return res.json({
            status: 'Success',
            grade_version: null,
            rows: [],
            message: '指定日期無有效的等級版本'
          });
        }

        const result = await pool.query(`
          SELECT class_code, class_name, grade, discount, pmcode
          FROM ${schemaName}.products_grade_rows
          WHERE version_code = $1
          ORDER BY class_code ASC, grade ASC
        `, [gradeVer.version_code]);

        res.json({
          status: 'Success',
          grade_version: gradeVer,
          rows: result.rows
        });
      } catch (err) {
        console.error('❌ 查詢可用等級失敗:', err);
        res.status(500).json({ status: 'Error', message: '查詢可用等級失敗', error: err.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 5. 建立新版本 + 儲存明細（一次完成）
  // POST /api/customer-levels/:customerId/versions
  // Body: {
  //   start_date, end_date, remark?,
  //   rows: [{ class_code, class_name, grade, discount?, pmcode?, remark? }]
  // }
  // ══════════════════════════════════════════════
  router.post('/:customerId/versions',
    authenticateToken,
    requirePermission('sales:customer-level:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { customerId } = req.params;
        const { start_date, end_date, remark, rows } = req.body;

        // ── 基本驗證 ──
        if (!start_date || !end_date) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '開始與結束日期為必填' });
        }
        if (new Date(start_date) > new Date(end_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '開始日期不可晚於結束日期' });
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請至少填寫一筆等級資料' });
        }

        // ── 確認客戶存在 ──
        const custCheck = await client.query(
          `SELECT id FROM ${schemaName}.customers WHERE id = $1`, [customerId]
        );
        if (custCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '客戶不存在' });
        }

        // ── 找出 start_date 當天有效的 grade version（用來驗證 grade 合法性）──
        const gradeVer = await getEffectiveGradeVersion(client, start_date);
        const refGradeVersion = gradeVer?.version_code || null;

        // ── 若有 grade version，驗證每列的 grade 是否在允許範圍內 ──
        if (refGradeVersion) {
          const validGrades = await client.query(`
            SELECT class_code, grade FROM ${schemaName}.products_grade_rows
            WHERE version_code = $1
          `, [refGradeVersion]);
          const validSet = new Set(validGrades.rows.map(r => `${r.class_code}|${r.grade}`));
          for (const row of rows) {
            if (!validSet.has(`${row.class_code}|${row.grade}`)) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                status: 'Error',
                message: `${row.class_code} 的等級 ${row.grade} 在當前等級版本中不存在`
              });
            }
          }
        }

        // ── 產生版本號 ──
        const sd = new Date(start_date);
        const versionCode = await generateVersionCode(client, sd.getFullYear(), sd.getMonth() + 1);

        // ── 插入版本頭 ──
        await client.query(`
          INSERT INTO ${schemaName}.customer_level_versions
            (version_code, cust_id, start_date, end_date, ref_grade_version, remark, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        `, [versionCode, customerId, start_date, end_date, refGradeVersion, remark || null, req.user.account]);

        // ── 插入明細 ──
        for (const row of rows) {
          await client.query(`
            INSERT INTO ${schemaName}.customer_level_rows
              (version_code, class_code, class_name, grade, discount, pmcode, remark, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          `, [
            versionCode, row.class_code, row.class_name || '',
            row.grade, row.discount ?? null, row.pmcode || null,
            row.remark || null, req.user.account
          ]);
        }

        await client.query('COMMIT');

        // 回傳完整版本資料
        const finalVer = await pool.query(
          `SELECT * FROM ${schemaName}.customer_level_versions WHERE version_code = $1`,
          [versionCode]
        );

        res.status(201).json({
          status: 'Success',
          message: `版本 ${versionCode} 建立成功，共 ${rows.length} 筆等級資料`,
          version: { ...finalVer.rows[0], row_count: rows.length }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 建立版本失敗:', err);
        res.status(500).json({ status: 'Error', message: '建立版本失敗', error: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 6. 更新版本明細（覆寫）
  // PUT /api/customer-levels/:customerId/versions/:versionCode/rows
  // ══════════════════════════════════════════════
  router.put('/:customerId/versions/:versionCode/rows',
    authenticateToken,
    requirePermission('sales:customer-level:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { versionCode } = req.params;
        const { rows } = req.body;

        if (!Array.isArray(rows) || rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請提供至少一筆等級資料' });
        }

        // 確認版本存在並取得 ref_grade_version
        const verCheck = await client.query(
          `SELECT version_code, ref_grade_version, start_date
           FROM ${schemaName}.customer_level_versions WHERE version_code = $1`,
          [versionCode]
        );
        if (verCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '版本不存在' });
        }

        const { ref_grade_version, start_date } = verCheck.rows[0];

        // 驗證 grade 合法性（用 ref_grade_version，若無則用 start_date 重新查）
        const gradeVerCode = ref_grade_version ||
          (await getEffectiveGradeVersion(client, start_date))?.version_code;

        if (gradeVerCode) {
          const validGrades = await client.query(`
            SELECT class_code, grade FROM ${schemaName}.products_grade_rows
            WHERE version_code = $1
          `, [gradeVerCode]);
          const validSet = new Set(validGrades.rows.map(r => `${r.class_code}|${r.grade}`));
          for (const row of rows) {
            if (!validSet.has(`${row.class_code}|${row.grade}`)) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                status: 'Error',
                message: `${row.class_code} 的等級 ${row.grade} 不在允許範圍內`
              });
            }
          }
        }

        // 覆寫明細
        await client.query(
          `DELETE FROM ${schemaName}.customer_level_rows WHERE version_code = $1`, [versionCode]
        );

        for (const row of rows) {
          await client.query(`
            INSERT INTO ${schemaName}.customer_level_rows
              (version_code, class_code, class_name, grade, discount, pmcode, remark, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          `, [
            versionCode, row.class_code, row.class_name || '',
            row.grade, row.discount ?? null, row.pmcode || null,
            row.remark || null, req.user.account
          ]);
        }

        // 更新版本 updated_at
        await client.query(
          `UPDATE ${schemaName}.customer_level_versions
           SET updated_at = NOW(), updated_by = $1 WHERE version_code = $2`,
          [req.user.account, versionCode]
        );

        await client.query('COMMIT');
        res.json({ status: 'Success', message: `已儲存 ${rows.length} 筆等級資料`, version_code: versionCode });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 更新版本明細失敗:', err);
        res.status(500).json({ status: 'Error', message: '更新版本明細失敗', error: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 7. 刪除版本（含明細）
  // DELETE /api/customer-levels/:customerId/versions/:versionCode
  // ══════════════════════════════════════════════
  router.delete('/:customerId/versions/:versionCode',
    authenticateToken,
    requirePermission('sales:customer-level:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { versionCode } = req.params;

        const verCheck = await client.query(
          `SELECT version_code FROM ${schemaName}.customer_level_versions WHERE version_code = $1`,
          [versionCode]
        );
        if (verCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '版本不存在' });
        }

        await client.query(
          `DELETE FROM ${schemaName}.customer_level_rows WHERE version_code = $1`, [versionCode]
        );
        await client.query(
          `DELETE FROM ${schemaName}.customer_level_versions WHERE version_code = $1`, [versionCode]
        );

        await client.query('COMMIT');
        res.json({ status: 'Success', message: '版本已刪除', deleted_version_code: versionCode });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除版本失敗:', err);
        res.status(500).json({ status: 'Error', message: '刪除版本失敗', error: err.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 8. 查詢某客戶當前生效的等級（供報價/訂單使用）
  // GET /api/customer-levels/:customerId/active
  // ══════════════════════════════════════════════
  router.get('/:customerId/active',
    authenticateToken,
    requirePermission('sales:customer-level:read'),
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const client = await pool.connect();
        const activeCode = await getActiveVersion(client, customerId);
        client.release();

        if (!activeCode) {
          return res.json({
            status: 'Success',
            active_version_code: null,
            rows: [],
            message: '此客戶目前無生效中的等級版本'
          });
        }

        const result = await pool.query(`
          SELECT r.*, v.start_date::text AS start_date, v.end_date::text AS end_date
          FROM ${schemaName}.customer_level_rows r
          JOIN ${schemaName}.customer_level_versions v ON r.version_code = v.version_code
          WHERE r.version_code = $1
          ORDER BY r.class_code ASC
        `, [activeCode]);

        res.json({
          status: 'Success',
          active_version_code: activeCode,
          rows: result.rows
        });
      } catch (err) {
        console.error('❌ 查詢生效等級失敗:', err);
        res.status(500).json({ status: 'Error', message: '查詢生效等級失敗', error: err.message });
      }
    }
  );

  return router;
};