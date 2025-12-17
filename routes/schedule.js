// routes/login.js

const express = require('express');
const router = express.Router();

// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

    router.get('/scheduling-data', async (req, res) => {
        try {
            const queryText = `
                SELECT 
                    wi.station_name,
                    wi.standard_output,
                    wi.min_batch,
                    wi.process_order,
                    ws.required_staff,
                    ws.current_staff,
                    wi.station_name AS wip_station,
                    wi.station_name AS order_station, -- 確保所有工站都返回
                    wip.wip_quantity
                FROM ${schemaName}.workstation_info wi
                JOIN ${schemaName}.workstation_staffing ws ON wi.station_name = ws.station_name
                JOIN ${schemaName}.wip_inventory wip ON wi.station_name = wip.station_name
                ORDER BY wi.process_order;
            `;
            const stationResults = await pool.query(queryText);
            
            // 額外查詢 Orders
            const orderResults = await pool.query(`SELECT order_id, quantity FROM ${schemaName}.projected_orders ORDER BY order_id;`);

            // 整理輸出格式
            const responseData = {
                stations: stationResults.rows.map(row => ({
                    name: row.station_name,
                    standard_output: row.standard_output,
                    min_batch: row.min_batch,
                    required_staff: row.required_staff,
                    current_staff: row.current_staff,
                    wip_quantity: row.wip_quantity
                })),
                orders: orderResults.rows
            };

            res.json(responseData);

        } catch (err) {
            console.error('Database query error:', err);
            res.status(500).json({ error: 'Failed to retrieve scheduling data' });
        }
    });

  // 返回 router 物件
  return router;
};