// routes/quiz.js
// 請在 index.js 加入：
//   const quizRouter = require('./routes/quiz')(pool, schemaName);
//   app.use('/api/quiz', quizRouter);

const express = require('express');
const router = express.Router();

module.exports = (pool, schemaName) => {

  // ==================== 取得帳號 ====================
  function getAccount(req) {
    if (req.user && req.user.account) return req.user.account;
    return req.headers['x-account'] || null;
  }

  // ==================== GET /api/quiz/units ====================
  // 取得所有課程單元（供下拉選單使用）
  router.get('/units', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id, unit, unit_name, semester, grade, subject, exam_scope
        FROM ${schemaName}.quiz_units
        WHERE status = 'active'
        ORDER BY
          CASE grade
            WHEN '一年級' THEN 1 WHEN '二年級' THEN 2
            WHEN '三年級' THEN 3 WHEN '四年級' THEN 4
            WHEN '五年級' THEN 5 WHEN '六年級' THEN 6
            ELSE 99
          END,
          semester, subject, exam_scope, unit, unit_name
      `);
      res.json({ status: 'Success', data: result.rows });
    } catch (err) {
      console.error('取得題庫單元失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== GET /api/quiz/units/options ====================
  // 取得各欄位的唯一值（供下拉選單用，支援串聯過濾）
  // Query params: grade, semester, subject, exam_scope, unit
  router.get('/units/options', async (req, res) => {
    const { grade, semester, subject, exam_scope, unit } = req.query;

    try {
      // 動態組合 WHERE 條件
      const conditions = ["status = 'active'"];
      const values = [];
      let idx = 1;

      if (grade)      { conditions.push(`grade = $${idx++}`);      values.push(grade); }
      if (semester)   { conditions.push(`semester = $${idx++}`);   values.push(semester); }
      if (subject)    { conditions.push(`subject = $${idx++}`);    values.push(subject); }
      if (exam_scope) { conditions.push(`exam_scope = $${idx++}`); values.push(exam_scope); }
      if (unit)       { conditions.push(`unit = $${idx++}`);       values.push(unit); }

      const where = conditions.join(' AND ');

      // 查詢各欄位唯一值
      const [grades, semesters, subjects, examScopes, units, unitNames] = await Promise.all([
        pool.query(`SELECT DISTINCT grade FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY CASE grade WHEN '一年級' THEN 1 WHEN '二年級' THEN 2 WHEN '三年級' THEN 3 WHEN '四年級' THEN 4 WHEN '五年級' THEN 5 WHEN '六年級' THEN 6 ELSE 99 END`, values),
        pool.query(`SELECT DISTINCT semester FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY semester`, values),
        pool.query(`SELECT DISTINCT subject FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY subject`, values),
        pool.query(`SELECT DISTINCT exam_scope FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY exam_scope`, values),
        pool.query(`SELECT DISTINCT unit FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY unit`, values),
        pool.query(`SELECT DISTINCT unit_name FROM ${schemaName}.quiz_units WHERE ${where} ORDER BY unit_name`, values),
      ]);

      res.json({
        status: 'Success',
        data: {
          grades:     grades.rows.map(r => r.grade),
          semesters:  semesters.rows.map(r => r.semester),
          subjects:   subjects.rows.map(r => r.subject),
          exam_scopes: examScopes.rows.map(r => r.exam_scope),
          units:      units.rows.map(r => r.unit),
          unit_names: unitNames.rows.map(r => r.unit_name),
        }
      });
    } catch (err) {
      console.error('取得選單選項失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== POST /api/quiz/challenge/complete ====================
  // 記錄挑戰結果 + 更新帳戶餘額（使用 Transaction）
  router.post('/challenge/complete', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    const {
      grade, semester, subject, exam_scope,
      unit, unit_name,
      question_count, correct_count, earned_coins,
      challenge_detail  // 詳細作答紀錄 (JSON array)
    } = req.body;

    if (question_count == null || correct_count == null || earned_coins == null) {
      return res.status(400).json({ status: 'Error', message: '請提供完整的挑戰結果資料' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 取得對應的 quiz_unit_id（若有）
      let quizUnitId = null;
      if (grade && semester && subject && exam_scope) {
        const unitQuery = unit && unit_name
          ? `SELECT id FROM ${schemaName}.quiz_units WHERE grade=$1 AND semester=$2 AND subject=$3 AND exam_scope=$4 AND unit=$5 AND unit_name=$6 AND status='active' LIMIT 1`
          : `SELECT id FROM ${schemaName}.quiz_units WHERE grade=$1 AND semester=$2 AND subject=$3 AND exam_scope=$4 AND status='active' LIMIT 1`;
        const unitValues = unit && unit_name
          ? [grade, semester, subject, exam_scope, unit, unit_name]
          : [grade, semester, subject, exam_scope];
        const unitResult = await client.query(unitQuery, unitValues);
        if (unitResult.rows.length > 0) quizUnitId = unitResult.rows[0].id;
      }

      // 2. 寫入挑戰紀錄
      await client.query(`
        INSERT INTO ${schemaName}.quiz_challenge_logs
          (account, quiz_unit_id, grade, semester, subject, exam_scope,
           unit, unit_name, question_count, correct_count, earned_coins, challenge_detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        account, quizUnitId, grade, semester, subject, exam_scope,
        unit || null, unit_name || null,
        question_count, correct_count, earned_coins,
        JSON.stringify(challenge_detail || [])
      ]);

      // 3. 若有獲得幣數，更新帳戶餘額
      let newBalance = null;
      if (earned_coins > 0) {
        const balResult = await client.query(
          `UPDATE ${schemaName}.accounts SET balance = balance + $1, updated_at = NOW(), updated_by = $2
           WHERE account = $2 RETURNING balance`,
          [earned_coins, account]
        );
        if (balResult.rows.length > 0) {
          newBalance = parseFloat(balResult.rows[0].balance);
        }
      } else {
        // 只查詢餘額，不更新
        const balResult = await client.query(
          `SELECT balance FROM ${schemaName}.accounts WHERE account = $1`, [account]
        );
        if (balResult.rows.length > 0) newBalance = parseFloat(balResult.rows[0].balance);
      }

      await client.query('COMMIT');

      res.json({
        status: 'Success',
        message: earned_coins > 0 ? `成功領取 ${earned_coins} 阿嬤幣！` : '挑戰紀錄已儲存',
        data: { new_balance: newBalance, earned_coins }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('記錄挑戰結果失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    } finally {
      client.release();
    }
  });

  // ==================== GET /api/quiz/challenge/history ====================
  // 取得挑戰歷史紀錄
  router.get('/challenge/history', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    try {
      const result = await pool.query(`
        SELECT id, grade, semester, subject, exam_scope, unit, unit_name,
               question_count, correct_count, earned_coins, created_at
        FROM ${schemaName}.quiz_challenge_logs
        WHERE account = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [account]);
      res.json({ status: 'Success', data: result.rows });
    } catch (err) {
      console.error('取得挑戰紀錄失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  // ==================== GET /api/quiz/balance ====================
  // 取得目前帳戶餘額（供會員頁面使用）
  router.get('/balance', async (req, res) => {
    const account = getAccount(req);
    if (!account) return res.status(401).json({ status: 'Error', message: '請先登入' });

    try {
      const result = await pool.query(
        `SELECT balance FROM ${schemaName}.accounts WHERE account = $1`, [account]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '找不到帳戶' });
      }
      res.json({ status: 'Success', data: { balance: parseFloat(result.rows[0].balance) } });
    } catch (err) {
      console.error('取得餘額失敗：', err.stack);
      res.status(500).json({ status: 'Error', message: '伺服器內部錯誤' });
    }
  });

  return router;
};