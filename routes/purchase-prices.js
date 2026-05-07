// routes/purchase-prices.js
// 掛載方式：app.use('/api/purchase-prices', require('./routes/purchase-prices')(pool, schemaName))

const express = require('express');
const { authenticateToken } = require('../middleware/jwtAuth');
const { requirePermission } = require('../middleware/permissionCheck');

module.exports = (pool, schemaName) => {
  const router = express.Router();

  // ─────────────────────────────────────────────
  // 輔助：產生版本號  YYMMXXXXXX
  // 例：2026-03 → 2603000001
  // ─────────────────────────────────────────────
  async function generateVersionCode(client, year, month) {
    const yy = String(year).slice(-2).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    const prefix = `${yy}${mm}`;

    // 找本月最大流水號
    const result = await client.query(`
      SELECT version_code
      FROM ${schemaName}.purchase_price_versions
      WHERE version_code LIKE $1
      ORDER BY version_code DESC
      LIMIT 1
    `, [`${prefix}%`]);

    let seq = 1;
    if (result.rows.length > 0) {
      const last = result.rows[0].version_code;
      seq = parseInt(last.slice(4)) + 1;
    }
    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  // ─────────────────────────────────────────────
  // 輔助：計算 active 版本（與前端邏輯一致）
  // 規則：
  //   1. 今天在 start_date ~ end_date 區間內
  //   2. start_date 最接近今天（最大）優先
  //   3. version_code 最新（最大）優先
  // ─────────────────────────────────────────────
  async function getActiveVersionCode(client) {
    const result = await client.query(`
      SELECT version_code, start_date, end_date
      FROM ${schemaName}.purchase_price_versions
      WHERE start_date <= CURRENT_DATE
        AND end_date   >= CURRENT_DATE
      ORDER BY start_date DESC, version_code DESC
      LIMIT 1
    `);
    return result.rows.length > 0 ? result.rows[0].version_code : null;
  }

  // ══════════════════════════════════════════════
  // 1. 查詢版本清單
  // GET /api/purchase-prices/versions
  // ══════════════════════════════════════════════
  router.get('/versions',
    authenticateToken,
    requirePermission('purchase:price:read'),
    async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT
            v.version_code,
            v.start_date,
            v.end_date,
            v.created_at,
            v.updated_at,
            v.created_by,
            v.updated_by,
            COUNT(r.id) AS row_count
          FROM ${schemaName}.purchase_price_versions v
          LEFT JOIN ${schemaName}.purchase_price_rows r
            ON r.version_code = v.version_code
          GROUP BY v.version_code, v.start_date, v.end_date,
                   v.created_at, v.updated_at, v.created_by, v.updated_by
          ORDER BY v.version_code DESC
        `);

        // 計算 active（伺服器側也計算，回傳給前端對照）
        const client = await pool.connect();
        const activeCode = await getActiveVersionCode(client);
        client.release();

        res.json({
          status: 'Success',
          versions: result.rows,
          active_version_code: activeCode,
          total: result.rows.length
        });
      } catch (error) {
        console.error('❌ 查詢版本清單失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢版本清單失敗', error: error.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 2. 查詢單一版本明細（價格列）
  // GET /api/purchase-prices/versions/:versionCode/rows
  // ══════════════════════════════════════════════
  router.get('/versions/:versionCode/rows',
    authenticateToken,
    requirePermission('purchase:price:read'),
    async (req, res) => {
      try {
        const { versionCode } = req.params;

        // 確認版本存在
        const vCheck = await pool.query(
          `SELECT version_code FROM ${schemaName}.purchase_price_versions WHERE version_code = $1`,
          [versionCode]
        );
        if (vCheck.rows.length === 0) {
          return res.status(404).json({ status: 'Error', message: '版本不存在' });
        }

        const result = await pool.query(`
          SELECT
            id,
            version_code,
            product_code,
            product_name,
            unit,
            price,
            remark,
            created_at,
            updated_at,
            created_by,
            updated_by
          FROM ${schemaName}.purchase_price_rows
          WHERE version_code = $1
          ORDER BY product_code ASC, unit ASC
        `, [versionCode]);

        res.json({
          status: 'Success',
          rows: result.rows,
          total: result.rows.length
        });
      } catch (error) {
        console.error('❌ 查詢版本明細失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢版本明細失敗', error: error.message });
      }
    }
  );

  // ══════════════════════════════════════════════
  // 3. 新增版本（系統自動產生版本號）
  // POST /api/purchase-prices/versions
  // Body: { start_date, end_date, created_by? }
  // ══════════════════════════════════════════════
  router.post('/versions',
    authenticateToken,
    requirePermission('purchase:price:create'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
 
        const { start_date, end_date, copy_version_code } = req.body;
 
        if (!start_date || !end_date) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '開始與結束日期為必填' });
        }
        if (new Date(start_date) > new Date(end_date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '開始日期不可晚於結束日期' });
        }
 
        // 產生版本號（使用 start_date 的年月）
        const sd = new Date(start_date);
        const versionCode = await generateVersionCode(client, sd.getFullYear(), sd.getMonth() + 1);
 
        const insertResult = await client.query(`
          INSERT INTO ${schemaName}.purchase_price_versions (
            version_code, start_date, end_date,
            created_by, updated_by
          )
          VALUES ($1, $2, $3, $4, $4)
          RETURNING *
        `, [versionCode, start_date, end_date, req.user.account]);
 
        // ── 若指定 copy_version_code，複製該版本的明細 ──
        if (copy_version_code) {
          const srcCheck = await client.query(
            `SELECT version_code FROM ${schemaName}.purchase_price_versions WHERE version_code = $1`,
            [copy_version_code]
          );
          if (srcCheck.rows.length > 0) {
            await client.query(`
              INSERT INTO ${schemaName}.purchase_price_rows
                (version_code, product_code, product_name, unit, price, remark, created_by, updated_by)
              SELECT $1, product_code, product_name, unit, price, remark, $2, $2
              FROM ${schemaName}.purchase_price_rows
              WHERE version_code = $3
            `, [versionCode, req.user.account, copy_version_code]);
          }
        }
 
        await client.query('COMMIT');
 
        // 回傳含 row_count 的版本資料（方便前端直接使用）
        const finalVer = insertResult.rows[0];
        const countRes = await pool.query(
          `SELECT COUNT(*) AS cnt FROM ${schemaName}.purchase_price_rows WHERE version_code = $1`,
          [versionCode]
        );
        finalVer.row_count = parseInt(countRes.rows[0].cnt);
 
        res.status(201).json({
          status: 'Success',
          message: copy_version_code
            ? `版本建立成功，已從 ${copy_version_code} 複製 ${finalVer.row_count} 筆資料`
            : '版本建立成功',
          version: finalVer
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 建立版本失敗:', error);
        res.status(500).json({ status: 'Error', message: '建立版本失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 4. 批次儲存版本明細（覆寫）
  // PUT /api/purchase-prices/versions/:versionCode/rows
  // Body: { rows: [{ product_code, product_name, unit, price, remark }] }
  // ══════════════════════════════════════════════
  router.put('/versions/:versionCode/rows',
    authenticateToken,
    requirePermission('purchase:price:update'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { versionCode } = req.params;
        const { rows } = req.body;

        // 確認版本存在
        const vCheck = await client.query(
          `SELECT version_code FROM ${schemaName}.purchase_price_versions WHERE version_code = $1`,
          [versionCode]
        );
        if (vCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '版本不存在' });
        }

        // 驗證明細
        if (!Array.isArray(rows) || rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ status: 'Error', message: '請提供至少一筆價格資料' });
        }

        for (const row of rows) {
          if (!row.product_code || !row.unit || row.price === undefined || row.price === null) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'Error',
              message: `貨號、單位、價格為必填（貨號：${row.product_code || '未填'}）`
            });
          }
          if (isNaN(Number(row.price)) || Number(row.price) < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'Error',
              message: `貨號 ${row.product_code} 的價格格式不正確`
            });
          }
        }

        // 先刪除舊明細，再批次插入（覆寫策略）
        await client.query(
          `DELETE FROM ${schemaName}.purchase_price_rows WHERE version_code = $1`,
          [versionCode]
        );

        for (const row of rows) {
          await client.query(`
            INSERT INTO ${schemaName}.purchase_price_rows (
              version_code, product_code, product_name,
              unit, price, remark,
              created_by, updated_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
          `, [
            versionCode,
            row.product_code,
            row.product_name || '',
            row.unit,
            Number(row.price),
            row.remark || null,
            req.user.account
          ]);
        }

        // 更新版本 updated_at / updated_by
        await client.query(`
          UPDATE ${schemaName}.purchase_price_versions
          SET updated_at = CURRENT_TIMESTAMP,
              updated_by = $1
          WHERE version_code = $2
        `, [req.user.account, versionCode]);

        await client.query('COMMIT');

        res.json({
          status: 'Success',
          message: `已儲存 ${rows.length} 筆價格資料`,
          version_code: versionCode,
          saved_count: rows.length
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 儲存明細失敗:', error);
        res.status(500).json({ status: 'Error', message: '儲存明細失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 5. 刪除版本（連同明細）
  // DELETE /api/purchase-prices/versions/:versionCode
  // ══════════════════════════════════════════════
  router.delete('/versions/:versionCode',
    authenticateToken,
    requirePermission('purchase:price:delete'),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { versionCode } = req.params;

        const vCheck = await client.query(
          `SELECT version_code FROM ${schemaName}.purchase_price_versions WHERE version_code = $1`,
          [versionCode]
        );
        if (vCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'Error', message: '版本不存在' });
        }

        // 先刪明細，再刪版本頭
        await client.query(
          `DELETE FROM ${schemaName}.purchase_price_rows WHERE version_code = $1`,
          [versionCode]
        );
        await client.query(
          `DELETE FROM ${schemaName}.purchase_price_versions WHERE version_code = $1`,
          [versionCode]
        );

        await client.query('COMMIT');

        res.json({
          status: 'Success',
          message: '版本已刪除',
          deleted_version_code: versionCode
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 刪除版本失敗:', error);
        res.status(500).json({ status: 'Error', message: '刪除版本失敗', error: error.message });
      } finally {
        client.release();
      }
    }
  );

  // ══════════════════════════════════════════════
  // 6. 查詢當前生效版本的價格（供採購單使用）
  // GET /api/purchase-prices/active
  // GET /api/purchase-prices/active?product_code=TS0001
  // ══════════════════════════════════════════════
  router.get('/active',
    authenticateToken,
    requirePermission('purchase:price:read'),
    async (req, res) => {
      try {
        const { product_code } = req.query;

        const client = await pool.connect();
        const activeCode = await getActiveVersionCode(client);
        client.release();

        if (!activeCode) {
          return res.json({
            status: 'Success',
            active_version_code: null,
            rows: [],
            message: '目前無生效中的價格版本'
          });
        }

        let query = `
          SELECT
            r.id,
            r.version_code,
            r.product_code,
            r.product_name,
            r.unit,
            r.price,
            r.remark,
            v.start_date,
            v.end_date
          FROM ${schemaName}.purchase_price_rows r
          JOIN ${schemaName}.purchase_price_versions v ON r.version_code = v.version_code
          WHERE r.version_code = $1
        `;
        const params = [activeCode];

        if (product_code) {
          query += ` AND r.product_code = $2`;
          params.push(product_code);
        }

        query += ` ORDER BY r.product_code ASC, r.unit ASC`;

        const result = await pool.query(query, params);

        res.json({
          status: 'Success',
          active_version_code: activeCode,
          rows: result.rows,
          total: result.rows.length
        });
      } catch (error) {
        console.error('❌ 查詢生效價格失敗:', error);
        res.status(500).json({ status: 'Error', message: '查詢生效價格失敗', error: error.message });
      }
    }
  );

  return router;
};