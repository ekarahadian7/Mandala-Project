# Mandala Tabel Tugas

Sistem online real-time dengan tampilan tabel sederhana untuk memberikan tugas harian dan memonitor progress bersama.

## Fitur

- Tambah dan edit tugas harian.
- PIC, project, deadline, prioritas, status, progress, catatan, dan update harian.
- Alarm per tugas dengan waktu pengingat, notifikasi browser, dan bunyi singkat selama aplikasi terbuka.
- Daftar tugas dalam satu tabel.
- Filter berdasarkan project, PIC, status, prioritas, dan pencarian bebas.
- Tombol cepat untuk edit, geser status, tandai selesai, dan hapus.
- Ringkasan total, aktif, selesai, terlambat, dan rata-rata progress.
- Data tersimpan otomatis di browser dengan `localStorage`.
- Mode online real-time dengan server Node.js, API `/api/tasks`, dan stream `/api/events`.
- Backup dan impor data JSON.
- Cetak laporan dari tombol `Cetak`.
- PWA/offline cache untuk hosting statis.
- Shortcut Windows tersedia di `BUKA_SISTEM_TUGAS_WINDOWS.bat`.

## Cara buka lokal

Jalankan server dari folder ini:

```bash
node server.js
```

Lalu buka:

```text
http://localhost:4173
```

## Cara buka di Windows

Double click file `BUKA_SISTEM_TUGAS_WINDOWS.bat` dari folder utama. Jika Windows belum punya Python, install Python 3 lalu jalankan lagi file tersebut.

## Catatan alarm

Klik `Aktifkan Alarm` di aplikasi untuk memberi izin notifikasi. Alarm berbunyi ketika waktu pada kolom `Alarm` sudah tercapai dan tugas belum selesai. Browser harus tetap terbuka agar alarm lokal ini berjalan.

## Deploy online

Folder ini sekarang membutuhkan hosting yang bisa menjalankan Node.js terus-menerus. Static hosting saja tidak cukup untuk real-time bersama.

Panduan lengkap ada di `../PANDUAN_ONLINE_REALTIME.md`.

Pengaturan umum:

- Root/project folder: `sistem-tugas-online`
- Start command: `npm start`
- Port: gunakan environment variable `PORT` dari hosting
- Data server tersimpan di `data/tasks.json`

Untuk produksi jangka panjang, gunakan hosting dengan persistent disk/storage agar file `data/tasks.json` tidak hilang saat server restart atau redeploy.
