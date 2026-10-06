// Runs the three killer tests against a running server (npm start) + PostgreSQL.
const base = process.env.BASE_URL || 'http://localhost:3000';
(async () => {
  let fail = 0;
  for (const n of ['timezone', 'buffer', 'concurrent']) {
    const r = await fetch(`${base}/api/demo/${n}`, { method: 'POST' }).then(x => x.json());
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${n}`, JSON.stringify(r.slot ? { ...r, slot: undefined } : r));
    if (!r.pass) fail++;
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
