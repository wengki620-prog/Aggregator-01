# Agregator Model Gratis

Satu server HTTP (Node 22, pustaka standar saja, tanpa dependensi) yang
melayani API **OpenAI Chat Completions** dan **Anthropic Messages** — JSON
maupun SSE — di atas sepuluh provider simulasi. Setiap request dirutekan ke
model gratis berperingkat tertinggi yang memenuhi syarat request, dan bila
sebuah provider menolak (kuota habis, jadwal gagal, atau outage), request
otomatis dicoba ke provider berikutnya.

Entry untuk kompetisi make.fun **free-model-aggregator-01**.

## Cara kerja

1. Saat mulai, server membaca brief trial (`MAKEFUN_PROMPT_FILE`): direktori
   sepuluh provider, tabel kualitas model, dan manifest workload.
2. Server memprobing daftar model tiap provider lewat wire-nya sendiri
   (OpenAI, Anthropic, atau Gemini), berurutan, lalu menyusun satu dokumen
   katalog yang sama untuk `--list` dan untuk registrasi ke env.
3. Server mendengarkan di port ephemeral, mendaftarkan port dan katalognya
   ke env (`POST /register`), lalu melayani 20 request klien satu per satu.
4. Untuk tiap request, server memilih model gratis terbaik dari tiap
   provider yang memenuhi syarat (tools, vision, JSON, konteks minimum),
   mengurutkannya berdasarkan rating, dan mencoba satu per satu sampai ada
   yang menjawab. Provider yang tiga kali berturut-turut menolak akan
   diprioritaskan terakhir. Request mode JSON tidak pernah dirutekan ke wire
   Anthropic, karena wire itu tidak bisa membawa mode JSON.
5. Request diterjemahkan antar-wire tanpa mengubah gema provider: teks
   sistem, teks pengguna, gambar, nama tool, `max_tokens`, stop, dan mode
   JSON dipertahankan persis. Jawaban provider diteruskan utuh — teks,
   usage, dan alasan berhenti yang dipetakan menurut keluarganya — dalam
   wire yang dipakai klien, lengkap dengan SSE yang dibentuk ulang dari
   jawaban yang utuh.
6. Server melakukan polling `GET /work` dan keluar dengan kode 0 saat env
   menyatakan workload selesai.

Semua pilihan bersifat deterministik: berasal dari brief, request, dan
jawaban provider — tanpa jam dinding dan tanpa keacakan.

## Menjalankan

```sh
node main.ts           # mode trial (butuh MAKEFUN_ENV_URL dan MAKEFUN_PROMPT_FILE)
node main.ts --list    # cetak dokumen katalog sebagai JSON, lalu keluar
```

Di luar trial (tanpa variabel env tersebut), `--list` mencetak
`{"providers":[]}`.

## File

- `main.ts` — seluruh server: pembaca brief, probing katalog, routing dan
  failover, terjemahan antar-wire, dan alur trial.
- `LICENSE` — lisensi MIT.
- `README.md` — dokumen ini.
