# Alat Download Suno Ajaib — Versi Vercel (v7)

Downloader Suno bernuansa Doraemon: gate password, set token Suno, load lagu per workspace/playlist dengan pagination **NEXT / PREV** penuh (20 lagu per halaman), grid 3 kolom dengan tombol **DL** satuan + download batch, dan download by ID/URL. Hasil download berupa file **.m4a** (audio Suno di-decrypt di serverless function).

## Perbaikan v7 (Pagination NEXT/PREV penuh + Layout 3 Kolom)

- **Fix utama di `api/feed.js`**: Sebelumnya endpoint workspace (`/api/project/{id}`) cuma dipanggil sekali tanpa parameter `?page=`, sehingga selalu mentok di 20 lagu pertama dan rawan timeout di Vercel karena mencoba menarik semua halaman sekaligus. Sekarang `api/feed.js` menarik **1 halaman (20 lagu) per klik NEXT/PREV** langsung ke Suno (`GET /api/project/{id}?page=1, 2, 3, ...`), lengkap dengan deteksi otomatis halaman duplikat (`prevIds`) dan fallback ke `/api/feed/v3` (`project_id` / cursor) serta `/api/feed/v2`.
- **Cepat & bebas timeout**: Tiap klik `NEXT ›` langsung memuat 20 lagu berikutnya tanpa batas (50, 101, 279, atau 1000+ lagu), dan halaman yang sudah pernah dibuka di-cache di browser sehingga klik `‹ PREV` langsung instan.
- **Multi-halaman di `api/workspaces.js`**: Daftar workspace (`/api/project/me`) dan playlist (`/api/playlist/me`) sekarang juga ditarik multi-halaman.
- **Tampilan disamakan dengan referensi (tema Doraemon)**: Grid 3 kolom, badge header `NAMA WORKSPACE • 20 LAGU • HAL X/Y`, info durasi/status/model, dan tombol `DL` satuan di tiap kartu lagu.

## Cara Deploy ke GitHub + Vercel

1. Extract file zip ini.
2. Upload semua isi folder (`index.html`, `package.json`, `README.md`, dan folder `api/`) ke root repository GitHub kamu (replace file lama).
3. Vercel akan otomatis deploy ulang, atau klik **Redeploy** di dashboard Vercel.
