# Alat Download Suno Ajaib — Versi Vercel

Downloader Suno bernuansa Doraemon: gate password, set token Suno, load lagu per workspace/playlist, download batch, dan download by ID/URL. Hasil download berupa file **.m4a** (audio Suno di-decrypt di serverless function, bukan mp3).

## Isi Project

```
index.html          -> tampilan + semua logika di browser (gate, token, daftar lagu, simpan file)
package.json        -> penanda project Node ESM (tanpa dependency, tanpa build)
api/download.js     -> POST {id, token?} : ambil lagu dari Suno, decrypt, kirim file .m4a
api/clip.js         -> GET  /api/clip?id=... : info lagu
api/keys.js         -> GET  /api/keys?song_id=... : proxy layanan kunci decrypt
api/workspaces.js   -> POST {token} : validasi token + daftar workspace/playlist
api/feed.js         -> POST {token, workspaceId, type, page} : daftar lagu
api/_suno.js        -> helper bersama (bukan endpoint)
```

Tidak ada database, tidak ada environment variable yang wajib diisi.

## Cara Deploy

### Lewat GitHub (disarankan)

1. Extract zip ini.
2. Buat repository baru di GitHub, upload semua file ini (pastikan `index.html` dan folder `api` ada di root repository), atau `git push` dari komputer.
3. Di Vercel: **Add New → Project → Import** repository itu.
4. Framework Preset pilih **Other**. Build Command dan Output Directory dikosongkan saja.
5. **Deploy**. Selesai — alamatnya jadi `nama-project.vercel.app`.

### Tanpa GitHub

1. Extract zip ini.
2. Di Vercel: **Add New → Project**, lalu drag & drop folder hasil extract (atau pakai Vercel CLI: `npm i -g vercel` lalu jalankan `vercel --prod` di dalam folder ini).

## Cara Pakai

1. Buka webnya, masukkan password gate (password-nya tersimpan sebagai `GATE_PASSWORD` di `index.html` — ganti di situ kalau mau password lain, lalu deploy ulang).
2. **Kantong Token**: ambil token Suno dari suno.com (F12 → Network → request ke studio-api-prod.suno.com → header `authorization: Bearer eyJ…`, copy bagian `eyJ…` saja). Token hidup ±1 jam.
3. **Lemari Lagu**: pilih workspace/playlist → LOAD LAGU → centang lagu → DOWNLOAD SEMUA. Tiap lagu disiapkan server, lalu klik **SIMPAN** di kartunya (dialog Save As / unduhan browser). Ada juga tombol TAB BARU sebagai cadangan.
4. **Pintu Kemana Saja**: download 1 lagu dari UUID / URL suno.com/song/… tanpa token untuk lagu publik.

## Perbaikan v4 (pagination NEXT/PREV)

- Model pagination sesuai aplikasi referensi: **20 lagu per halaman**, tombol **NEXT/PREV** jalan antar halaman sampai lagu terakhir (workspace 100 lagu = 5 halaman).
- Cara kerjanya: server mengumpulkan dulu daftar lengkap workspace dari Suno (di-cache 10 menit), lalu memotongnya per halaman 20 — jadi NEXT dijamin lanjut ke urutan berikutnya, tidak mentok di 20 pertama.
- Di atas daftar tampil keterangan "Halaman X dari Y — total Z lagu di workspace ini". NEXT mati sendiri di halaman terakhir, PREV mati di halaman pertama.
- Download per halaman: PILIH SEMUA → DOWNLOAD SEMUA, lalu NEXT untuk halaman berikutnya.

## Perbaikan v3 (pagination)

- Suno membatasi ±20 lagu per halaman di semua endpoint daftar. Server sekarang menarik **semua halaman sekaligus** sampai lagu habis (maks 12 halaman / 600 lagu), jadi playlist 30/58 lagu tampil lengkap dalam sekali LOAD LAGU.
- Tombol PREV/NEXT otomatis nonaktif setelah semua lagu termuat, dengan keterangan "Semua N lagu sudah dimuat".

## Perbaikan v2 (load lagu)

- Load lagu sekarang memakai strategi waterfall per jenis daftar: playlist mencoba `/api/playlist/v2/{id}`, `/api/playlist/{id}`, `/api/playlist/{id}/clips`, lalu `POST /api/feed/v3` dengan filter playlist; "Semua Lagu" mencoba `/api/library`, feed v3, feed v2; project mencoba `/api/project/{id}` dan variasinya.
- Bentuk respon playlist yang bersarang (`playlist_clips: [{ clip: {...} }]`) sekarang dikenali.
- Header `browser-token` dan `device-id` (yang dipakai web Suno sekarang) ikut dikirim.
- Kalau semua endpoint balas kosong, halaman menampilkan detail teknisnya (endpoint + HTTP status), bukan lagi pesan "ambil token baru" yang menyesatkan.

## Catatan

- Token Suno hanya disimpan di browser pemakai (sessionStorage), tidak disimpan di server.
- Kunci decrypt diambil dari layanan kunci yang sama dengan aplikasi referensi (`/api/keys`), audio diambil dari CDN Suno lalu di-decrypt AES-128-CTR di `api/download.js`.
- Kalau daftar lagu kosong padahal token baru saja diambil, biasanya token sudah kedaluwarsa — ambil token baru.
