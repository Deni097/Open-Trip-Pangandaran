const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const HOLD_MINUTES = 15;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL belum di-set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static("public"));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      nama TEXT NOT NULL,
      nohp TEXT NOT NULL,
      alamat TEXT NOT NULL,
      seats INTEGER[] NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','paid','cancelled','expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hold_until TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  `);
}

async function releaseExpired() {
  await pool.query(`
    UPDATE bookings
    SET status='expired'
    WHERE status='pending' AND hold_until IS NOT NULL AND hold_until <= NOW()
  `);
}

function cleanSeats(seats) {
  if (!Array.isArray(seats)) return [];
  return [...new Set(seats.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 59)
    .sort((a,b) => a-b);
}

app.get("/api/seats", async (req,res) => {
  try {
    await releaseExpired();
    const { rows } = await pool.query(`
      SELECT id, seats, status, hold_until
      FROM bookings
      WHERE status IN ('pending','paid')
    `);
    const result = {};
    for (const r of rows) {
      for (const seat of r.seats) {
        result[seat] = {
          status: r.status,
          booking_id: r.id,
          hold_until: r.hold_until
        };
      }
    }
    res.json({ seats: result, total: 59, hold_minutes: HOLD_MINUTES });
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Gagal mengambil status kursi"});
  }
});

app.post("/api/bookings", async (req,res) => {
  const nama = String(req.body.nama || "").trim();
  const nohp = String(req.body.nohp || "").trim();
  const alamat = String(req.body.alamat || "").trim();
  const seats = cleanSeats(req.body.seats);

  if (!nama || !nohp || !alamat || seats.length === 0)
    return res.status(400).json({error:"Data pemesan dan kursi wajib diisi"});
  if (seats.length > 59)
    return res.status(400).json({error:"Jumlah kursi tidak valid"});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE bookings
      SET status='expired'
      WHERE status='pending' AND hold_until IS NOT NULL AND hold_until <= NOW()
    `);

    const { rows: conflicts } = await client.query(`
      SELECT id, seats, status, hold_until
      FROM bookings
      WHERE status IN ('pending','paid')
        AND seats && $1::integer[]
      FOR UPDATE
    `, [seats]);

    if (conflicts.length) {
      const blocked = new Set();
      conflicts.forEach(r => r.seats.forEach(s => blocked.add(s)));
      const taken = seats.filter(s => blocked.has(s));
      await client.query("ROLLBACK");
      return res.status(409).json({
        error:"Ada kursi yang baru saja dipilih orang lain.",
        taken
      });
    }

    const { rows } = await client.query(`
      INSERT INTO bookings (nama,nohp,alamat,seats,status,hold_until)
      VALUES ($1,$2,$3,$4,'pending',NOW() + ($5 || ' minutes')::interval)
      RETURNING id, hold_until
    `, [nama,nohp,alamat,seats,HOLD_MINUTES]);

    await client.query("COMMIT");
    res.json({ok:true, booking_id:rows[0].id, hold_until:rows[0].hold_until, hold_minutes:HOLD_MINUTES});
  } catch(e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"Booking gagal dibuat"});
  } finally {
    client.release();
  }
});

app.get("/api/bookings", async (req,res) => {
  try {
    await releaseExpired();
    const { rows } = await pool.query(`
      SELECT id,nama,nohp,alamat,seats,status,created_at,hold_until
      FROM bookings ORDER BY id DESC
    `);
    res.json(rows);
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Gagal mengambil booking"});
  }
});

async function changeStatus(id, status, res) {
  try {
    const { rows } = await pool.query(`
      UPDATE bookings
      SET status=$2, hold_until=CASE WHEN $2='paid' THEN NULL ELSE hold_until END
      WHERE id=$1 AND status IN ('pending','paid')
      RETURNING *
    `,[id,status]);
    if (!rows.length) return res.status(404).json({error:"Booking tidak ditemukan / sudah berubah"});
    res.json({ok:true, booking:rows[0]});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Gagal mengubah booking"});
  }
}
app.post("/api/bookings/:id/pay", (req,res)=>changeStatus(req.params.id,'paid',res));
app.post("/api/bookings/:id/cancel", (req,res)=>changeStatus(req.params.id,'cancelled',res));

app.get("/health", (req,res)=>res.json({ok:true}));

initDb().then(()=>{
  app.listen(PORT,()=>console.log(`Open Trip server running on ${PORT}`));
}).catch(e=>{
  console.error("DB init error:",e);
  process.exit(1);
});
