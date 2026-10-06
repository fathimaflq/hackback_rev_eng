require('dotenv').config();
const { Pool } = require('pg');
module.exports = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/slotbooking', max: 10 });
