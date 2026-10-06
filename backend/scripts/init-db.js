require('dotenv').config();
const fs = require('fs'), path = require('path');
const pool = require('../src/db');
(async () => {
  for (const f of ['schema.sql', 'seed.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../../database', f), 'utf8'));
    console.log('applied', f);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
