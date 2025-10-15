const express = require('express');
const router = express.Router();



// 這裡我們需要一個工廠函式來接收資料庫客戶端和 schema 名稱
module.exports = (pool, schemaName) => {

// 定義 API 端點來提供 UI 資料
router.get('/ui-data', async (req, res) => {
    try {

        // 取得 product 參數，如果沒有則使用預設值 'general'
        const product = req.query.product || 'W01';
        // 根據 product 參數篩選 ui_elements 和 ui_changed
        const [uiElementsResult, optionsDataResult, uiChangedResult] = await Promise.all([
            pool.query('SELECT * FROM '+schemaName+'.ui_elements WHERE product = $1 OR product = \'*\' ORDER BY seq_id ASC', [product]),
            pool.query('SELECT * FROM '+schemaName+'.options_data ORDER BY option_id ASC'),
            pool.query('SELECT * FROM '+schemaName+'.ui_changed ORDER BY change_id ASC')
        ]);        
        // 處理 ui_elements 資料
        const uiDataTable = uiElementsResult.rows.map(row => {
            const item = {
                element_id: row.element_id,
                seq_id: row.seq_id,
                element_type: row.element_type
            };
            
            if (row.label) item.label = row.label;
            // 新增邏輯：將 parent_id 欄位加入回傳的物件
            if (row.parent_id) item.parent_id = row.parent_id;
            if (row.initial_value) {
                if (row.initial_value === 'TRUE') {
                    item.initialValue = true;
                } else if (row.initial_value === 'FALSE') {
                    item.initialValue = false;
                } else {
                    item.initialValue = row.initial_value;
                }
            }
            if (row.options_key) item.options_key = row.options_key;
            if (row.properties) item.properties = row.properties;
            if (row.trigger_event) item.trigger_event = row.trigger_event;
            // 新增 product 欄位
            if (row.product) item.product = row.product;
             // 新增 db_column_name 欄位
            if (row.db_column_name) item.dbColumn = row.db_column_name;           
            return item;
        });


        // 處理 options_data 資料，並將其組合成 Map
        const optionsData = optionsDataResult.rows;
        const optionsDataTable = optionsData.reduce((acc, current) => {
            let table = acc.find(item => item.key === current.option_key);
            if (!table) {
                table = {
                    key: current.option_key,
                    options: []
                };
                acc.push(table);
            }

            const option = {
                value: current.value,
                label: current.label,
            };

            // 變更邏輯：將 parent_value 變更為 product
            if (current.product) {
                option.product = current.product;
            }            
            table.options.push(option);
            return acc;
        }, []);
        
        // 處理 ui_changed 資料
        const uiChangedTable = uiChangedResult.rows.map(row => {
            return {
                change_id: row.change_id,
                element_id: row.element_id,
                parent_value: row.parent_value,
                action_id: row.action_id,
                action_type: row.action_type
            };
        });

        const responseData = {
            uiDataTable: uiDataTable,
            optionsDataTable: optionsDataTable,
            uiChangedTable: uiChangedTable
        };


        res.json(responseData);

    } catch (err) {
        console.error('資料庫查詢錯誤', err);
        res.status(500).json({ error: '內部伺服器錯誤' });
    }
});

  return router;
};
