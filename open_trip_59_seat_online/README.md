# Open Trip 59 Seat — Online Prototype

Stack: Node.js + Express + PostgreSQL.
Target hosting: Render Web Service + PostgreSQL provider (contoh Supabase).

## Environment
Set `DATABASE_URL` ke connection string PostgreSQL.

## Local
npm install
DATABASE_URL="..." npm start

Participant: /
Admin: /admin.html

## Deploy
Upload this folder to a GitHub repository, create a Render Web Service from the repo, build command `npm install`, start command `npm start`, and set DATABASE_URL as an environment variable.

IMPORTANT:
- Admin page prototype belum punya login. Jangan dipakai publik untuk operasional sebelum diberi authentication.
- HOLD 15 menit.
- PostgreSQL dipakai agar status kursi sinkron antar perangkat.
