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

## Perbaikan v7 (lagu kurang + lagu tercampur)

Dari rekaman layar pemakaian v6 terlihat dua kerusakan: PHONK berhenti di 40 dari 60 lagu, dan halaman 2 "DJ AS REMIX" berisi lagu dari workspace lain. Penyebab + perbaikan:

- **Lagu tercampur**: v5 menggabungkan hasil semua strategi. Satu strategi feed yang filternya diabaikan Suno mengembalikan lagu acak dari library, lalu ikut tercampur. v7: **tidak ada penggabungan** — satu strategi menang utuh. Strategi feed hanya boleh menang kalau endpoint membership (playlist/project) kosong total, atau kalau hasilnya mencapai persis jumlah lagu workspace di dropdown.
- **Berhenti di tengah (40/60)**: halaman Suno yang menjawab error sesaat (429 rate-limit / 5xx) sebelumnya dianggap "daftar habis". v7: error di-retry sampai 3x dengan jeda, request antar-halaman diberi pacing, dan paging hanya berhenti pada respon 200 yang benar-benar kosong.
- **Satu tembakan besar dulu**: endpoint membership dicoba dengan `page_size=99999` (trik yang dipakai tools Suno lain di endpoint library) sebelum paging biasa — kalau Suno mengabulkan, seluruh isi workspace datang dalam 1 request.
- Panel "detail teknis" sekarang juga mencatat status HTTP tiap halaman + field respon, jadi kegagalan berikutnya terbaca persis.

## Perbaikan v6 (samakan contoh referensi)

- Header bagian Lemari Lagu sekarang punya badge **"TOTAL LAGU • HAL X"** seperti aplikasi referensi (mis. "101 LAGU • HAL 1"), berubah tiap pindah halaman.
- Ganti workspace/playlist di dropdown sekarang **langsung memuat lagu** halaman pertamanya (tanpa klik LOAD LAGU lagi), seperti di referensi.
- Mesin pagination tetap v5 (banyak strategi, target dari dropdown).

## Perbaikan v5 (kumpulan strategi pagination)

- Masalah v4: endpoint Suno yang pertama berhasil ternyata mengabaikan parameter halaman, jadi server berhenti di 20 lagu pertama ("Halaman 1 dari 1") padahal workspace berisi 60.
- Sekarang server mencoba **banyak strategi pagination** (playlist v1 per halaman, feed/v3 per halaman `{page:n}`, feed/v3 cursor, playlist v2 tracks, playlist/clips, basis halaman 0 dan 1) dan memakai hasil **terlengkap**; jumlah lagu di dropdown dikirim sebagai target (`expected`) supaya server tidak berhenti sebelum target tercapai.
- Di halaman ada panel **"detail teknis"** di bawah status daftar lagu: isinya catatan tiap endpoint Suno yang dicoba + hasilnya. Kalau jumlah lagu masih kurang, screenshot panel itu menunjukkan persis endpoint mana yang bermasalah.

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
