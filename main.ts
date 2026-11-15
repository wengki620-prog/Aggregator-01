// Agregator model gratis — satu server HTTP yang melayani API OpenAI Chat
// Completions dan Anthropic Messages di atas sepuluh provider simulasi.
// Setiap request dirutekan ke model gratis berperingkat tertinggi yang
// memenuhi syarat request; bila provider menolak, request dicoba ke
// provider berikutnya. Tidak ada panggilan model saat berjalan, tidak ada
// jam dinding atau keacakan dalam apa pun yang dikirim: semua pilihan
// berasal dari brief, request yang masuk, dan jawaban provider.
//
// Penggunaan:
//   node main.ts            jalankan server trial (butuh MAKEFUN_ENV_URL
//                           dan MAKEFUN_PROMPT_FILE dari sandbox)
//   node main.ts --list     cetak dokumen katalog sebagai JSON lalu keluar
//
// Hanya memakai pustaka standar Node dan sintaks TypeScript yang bisa
// dihapus (erasable), agar jalan di Node 22.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

const CREATED_TETAP = 1767225600;
const DIBUAT_TETAP = "2026-01-01T00:00:00Z";
const POTONG_SSE = 13;
const BATAS_BADAN = 4 * 1024 * 1024;

type Wire = "openai" | "anthropic" | "gemini";

interface DirektoriProvider {
  id: string;
  name: string;
  wire: Wire;
  auth: string;
  key_env: string;
  key: string;
  path: string;
}

interface BarisRating {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface InfoModel {
  id: string;
  free: boolean;
  context_length: number | null;
  tools: boolean | undefined;
  vision: boolean | undefined;
  json: boolean | undefined;
  rating: number;
}

interface InfoProvider {
  dir: DirektoriProvider;
  models: InfoModel[];
}

interface ModelKatalog {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface ProviderKatalog {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: ModelKatalog[];
}

interface Katalog {
  providers: ProviderKatalog[];
}

interface BarisManifest {
  id: string;
  api: string;
  stream: boolean;
  weight: number;
  requires: Record<string, unknown>;
}

interface Brief {
  providers: DirektoriProvider[];
  ratings: BarisRating[];
  manifest: BarisManifest[];
}

interface Syarat {
  tools: boolean;
  vision: boolean;
  json: boolean;
  minContext: number | null;
}

function adalahRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function angkaAtauNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function daftarString(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  const hasil: string[] = [];
  for (const x of v) if (typeof x === "string") hasil.push(x);
  return hasil;
}

function tidur(ms: number): Promise<void> {
  return new Promise((selesai) => setTimeout(selesai, ms));
}

// ---------------------------------------------------------------------------
// Membaca brief: tiga dokumen JSON satu-baris yang dikenali dari anggota
// `schema` masing-masing. Bila brief tidak ada, kembalikan null dan pemanggil
// memakai jalur darurat lewat GET /instance.
// ---------------------------------------------------------------------------

function bacaBrief(): Brief | null {
  const berkas = process.env.MAKEFUN_PROMPT_FILE;
  if (!berkas) return null;
  let teks: string;
  try {
    teks = readFileSync(berkas, "utf8");
  } catch {
    return null;
  }
  let providers: DirektoriProvider[] = [];
  let ratings: BarisRating[] = [];
  let manifest: BarisManifest[] = [];
  for (const baris of teks.split("\n")) {
    const potong = baris.trim();
    if (!potong.startsWith("{")) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(potong);
    } catch {
      continue;
    }
    if (!adalahRecord(doc) || typeof doc.schema !== "string") continue;
    if (doc.schema === "free-model-aggregator-01/providers/v1" && Array.isArray(doc.providers)) {
      providers = (doc.providers as unknown[]).filter(adalahRecord).map((p) => ({
        id: typeof p.id === "string" ? p.id : "",
        name: typeof p.name === "string" ? p.name : "",
        wire: (p.wire === "anthropic" || p.wire === "gemini" ? p.wire : "openai") as Wire,
        auth: typeof p.auth === "string" ? p.auth : "none",
        key_env: typeof p.key_env === "string" ? p.key_env : "",
        key: typeof p.key === "string" ? p.key : "",
        path: typeof p.path === "string" ? p.path : "",
      }));
    } else if (doc.schema === "free-model-aggregator-01/ratings/v1" && Array.isArray(doc.ratings)) {
      ratings = (doc.ratings as unknown[]).filter(adalahRecord).map((r) => ({
        model: typeof r.model === "string" ? r.model : "",
        provider: typeof r.provider === "string" ? r.provider : "",
        rating_milli: angkaAtauNull(r.rating_milli) ?? 0,
        context_length: angkaAtauNull(r.context_length),
        tools: r.tools === true,
        vision: r.vision === true,
        json: r.json === true,
        free: r.free === true,
      }));
    } else if (doc.schema === "free-model-aggregator-01/workload/v1" && Array.isArray(doc.manifest)) {
      manifest = (doc.manifest as unknown[]).filter(adalahRecord).map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        api: typeof m.api === "string" ? m.api : "",
        stream: m.stream === true,
        weight: angkaAtauNull(m.weight) ?? 1,
        requires: adalahRecord(m.requires) ? m.requires : {},
      }));
    }
  }
  if (providers.length === 0) return null;
  return { providers, ratings, manifest };
}

async function bacaInstance(envUrl: string): Promise<Brief | null> {
  try {
    const res = await fetch(`${envUrl}/instance`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const doc: unknown = await res.json();
    if (!adalahRecord(doc)) return null;
    const daftar = Array.isArray(doc.providers)
      ? doc.providers
      : Array.isArray(doc.directory)
        ? doc.directory
        : null;
    if (daftar === null) return null;
    const providers: DirektoriProvider[] = [];
    for (const item of daftar) {
      if (!adalahRecord(item) || typeof item.id !== "string") continue;
      let path = typeof item.path === "string" ? item.path : "";
      const base = typeof item.base_url === "string" ? item.base_url : "";
      if (!path && base) {
        try {
          path = new URL(base).pathname;
        } catch {
          path = base;
        }
      }
      providers.push({
        id: item.id,
        name: typeof item.name === "string" ? item.name : item.id,
        wire: (item.wire === "anthropic" || item.wire === "gemini" ? item.wire : "openai") as Wire,
        auth: typeof item.auth === "string" ? item.auth : "none",
        key_env: typeof item.key_env === "string" ? item.key_env : "",
        key: typeof item.key === "string" ? item.key : "",
        path,
      });
    }
    const manifest: BarisManifest[] = [];
    const mentah = Array.isArray(doc.manifest)
      ? doc.manifest
      : adalahRecord(doc.workload) && Array.isArray(doc.workload.manifest)
        ? doc.workload.manifest
        : [];
    for (const m of mentah) {
      if (!adalahRecord(m)) continue;
      manifest.push({
        id: typeof m.id === "string" ? m.id : "",
        api: typeof m.api === "string" ? m.api : "",
        stream: m.stream === true,
        weight: angkaAtauNull(m.weight) ?? 1,
        requires: adalahRecord(m.requires) ? m.requires : {},
      });
    }
    if (providers.length === 0) return null;
    return { providers, ratings: [], manifest };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Katalog: memprobing daftar model tiap provider lewat wire-nya sendiri,
// berurutan, sebelum trial dimulai. Satu objek katalog dipakai untuk --list
// dan untuk register, agar keduanya identik.
// ---------------------------------------------------------------------------

function headerAuth(dir: DirektoriProvider): Record<string, string> {
  const h: Record<string, string> = {};
  if (dir.auth === "bearer") h["authorization"] = `Bearer ${dir.key}`;
  else if (dir.auth === "x-api-key") h["x-api-key"] = dir.key;
  else if (dir.auth === "x-goog-api-key") h["x-goog-api-key"] = dir.key;
  return h;
}

interface ModelListing {
  id: string;
  free: boolean | undefined;
  context_length: number | null;
  tools: boolean | undefined;
  vision: boolean | undefined;
  json: boolean | undefined;
}

async function probingProvider(envUrl: string, dir: DirektoriProvider): Promise<ModelListing[] | null> {
  const jalur =
    dir.wire === "gemini" ? `${envUrl}${dir.path}/v1beta/models` : `${envUrl}${dir.path}/v1/models`;
  const headers: Record<string, string> = headerAuth(dir);
  if (dir.wire === "anthropic") headers["anthropic-version"] = "2023-06-01";
  let res: Response;
  try {
    res = await fetch(jalur, { headers, signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let badan: unknown;
  try {
    badan = await res.json();
  } catch {
    return null;
  }
  if (!adalahRecord(badan)) return null;
  const hasil: ModelListing[] = [];
  if (dir.wire === "gemini") {
    if (!Array.isArray(badan.models)) return null;
    for (const m of badan.models) {
      if (!adalahRecord(m)) continue;
      const nama = typeof m.name === "string" ? m.name : "";
      const id = nama.startsWith("models/") ? nama.slice("models/".length) : nama;
      if (!id && typeof m.displayName !== "string") continue;
      hasil.push({
        id: id || (m.displayName as string),
        free: typeof m.free === "boolean" ? m.free : undefined,
        context_length:
          angkaAtauNull(m.context_length) ?? angkaAtauNull(m.inputTokenLimit),
        tools: typeof m.tools === "boolean" ? m.tools : undefined,
        vision: typeof m.vision === "boolean" ? m.vision : undefined,
        json: typeof m.json === "boolean" ? m.json : undefined,
      });
    }
    return hasil;
  }
  if (!Array.isArray(badan.data)) return null;
  for (const m of badan.data) {
    if (!adalahRecord(m) || typeof m.id !== "string" || m.id === "") continue;
    hasil.push({
      id: m.id,
      free: typeof m.free === "boolean" ? m.free : undefined,
      context_length: angkaAtauNull(m.context_length),
      tools: typeof m.tools === "boolean" ? m.tools : undefined,
      vision: typeof m.vision === "boolean" ? m.vision : undefined,
      json: typeof m.json === "boolean" ? m.json : undefined,
    });
  }
  return hasil;
}

interface KeadaanKatalog {
  katalog: Katalog;
  providers: InfoProvider[];
  manifest: BarisManifest[];
}

async function susunKatalog(envUrl: string, brief: Brief | null): Promise<KeadaanKatalog> {
  const kosong: KeadaanKatalog = { katalog: { providers: [] }, providers: [], manifest: [] };
  if (!envUrl || brief === null) return kosong;
  const ratingDari = new Map<string, BarisRating>();
  for (const r of brief.ratings) ratingDari.set(`${r.provider}\n${r.model}`, r);
  const katalog: Katalog = { providers: [] };
  const providers: InfoProvider[] = [];
  for (const dir of brief.providers) {
    const listing = await probingProvider(envUrl, dir);
    const models: InfoModel[] = [];
    const modelKatalog: ModelKatalog[] = [];
    if (listing !== null) {
      for (const m of listing) {
        const rating = ratingDari.get(`${dir.id}\n${m.id}`);
        const free =
          rating !== undefined ? rating.free && m.free !== false : m.free === true;
        const context =
          m.context_length ?? (rating !== undefined ? rating.context_length : null);
        models.push({
          id: m.id,
          free,
          context_length: context,
          tools: rating !== undefined ? rating.tools : m.tools,
          vision: rating !== undefined ? rating.vision : m.vision,
          json: rating !== undefined ? rating.json : m.json,
          rating: rating !== undefined ? rating.rating_milli : 0,
        });
        modelKatalog.push({ id: m.id, free: m.free === true, context_length: context });
      }
    } else {
      // Probing gagal: katalog darurat dari tabel rating (hanya model gratis).
      for (const r of brief.ratings) {
        if (r.provider !== dir.id || !r.free) continue;
        models.push({
          id: r.model,
          free: true,
          context_length: r.context_length,
          tools: r.tools,
          vision: r.vision,
          json: r.json,
          rating: r.rating_milli,
        });
        modelKatalog.push({ id: r.model, free: true, context_length: r.context_length });
      }
    }
    katalog.providers.push({
      id: dir.id,
      base_url: dir.path,
      key_env: dir.key_env,
      wire: dir.wire,
      models: modelKatalog,
    });
    providers.push({ dir, models });
  }
  return { katalog, providers, manifest: brief.manifest };
}

function syaratDariManifest(baris: BarisManifest | undefined): Syarat | null {
  if (baris === undefined) return null;
  const q = baris.requires;
  return {
    tools: q.tools === true,
    vision: q.vision === true,
    json: q.json === true,
    minContext: angkaAtauNull(q.min_context),
  };
}

function memenuhi(model: InfoModel, syarat: Syarat): boolean {
  if (!model.free) return false;
  if (syarat.tools && model.tools !== true) return false;
  if (syarat.vision && model.vision !== true) return false;
  if (syarat.json && model.json !== true) return false;
  if (
    syarat.minContext !== null &&
    (model.context_length === null || model.context_length < syarat.minContext)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bentuk kanonis request: semua yang menentukan gema (echo) provider —
// teks sistem, teks dan gambar tiap pesan, nama tool berurutan, max_tokens,
// stop, dan mode JSON — diekstrak sekali dari wire klien, lalu ditulis
// ulang ke wire provider tanpa mengubah satu pun nilainya.
// ---------------------------------------------------------------------------

interface GambarAcuan {
  url: string;
  dataB64: string | null;
  mime: string;
}

interface PesanKanonis {
  role: string;
  text: string;
  gambar: GambarAcuan[];
}

interface ToolKanonis {
  name: string;
  description: string;
  parameters: unknown;
}

interface Kanonis {
  systemText: string;
  pesan: PesanKanonis[];
  tools: ToolKanonis[];
  maxTokens: number | null;
  adaMaxTokens: boolean;
  stops: string[];
  jsonMode: boolean;
  temperature: number | undefined;
  topP: number | undefined;
}

const POLA_DATA_URL = /^data:[^,]*;base64,(.*)$/s;

function gambarDariUrl(url: string): GambarAcuan {
  const cocok = POLA_DATA_URL.exec(url);
  if (cocok !== null) {
    const kepala = url.slice(0, url.indexOf(","));
    const mime = kepala.slice("data:".length).split(";")[0] || "image/png";
    return { url, dataB64: cocok[1], mime };
  }
  return { url, dataB64: null, mime: "image/png" };
}

function teksBlok(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bagian: string[] = [];
  for (const blok of content) {
    if (adalahRecord(blok) && blok.type === "text" && typeof blok.text === "string") {
      bagian.push(blok.text);
    }
  }
  return bagian.join("\n");
}

function ekstrakOpenAI(badan: Record<string, unknown>): Kanonis {
  const pesanMentah = Array.isArray(badan.messages)
    ? (badan.messages as unknown[]).filter(adalahRecord)
    : [];
  const sistemBagian: string[] = [];
  const pesan: PesanKanonis[] = [];
  for (const m of pesanMentah) {
    const role = typeof m.role === "string" ? m.role : "user";
    const text = teksBlok(m.content);
    const gambar: GambarAcuan[] = [];
    if (Array.isArray(m.content)) {
      for (const blok of m.content) {
        if (
          adalahRecord(blok) &&
          blok.type === "image_url" &&
          adalahRecord(blok.image_url) &&
          typeof blok.image_url.url === "string" &&
          blok.image_url.url !== ""
        ) {
          gambar.push(gambarDariUrl(blok.image_url.url));
        }
      }
    }
    if (role === "system") {
      if (text !== "") sistemBagian.push(text);
    } else {
      pesan.push({ role, text, gambar });
    }
  }
  const tools: ToolKanonis[] = [];
  if (Array.isArray(badan.tools)) {
    for (const t of badan.tools) {
      if (adalahRecord(t) && adalahRecord(t.function) && typeof t.function.name === "string") {
        tools.push({
          name: t.function.name,
          description: typeof t.function.description === "string" ? t.function.description : "",
          parameters: t.function.parameters !== undefined ? t.function.parameters : {},
        });
      }
    }
  }
  const maks1 = angkaAtauNull(badan.max_tokens);
  const maks2 = angkaAtauNull(badan.max_completion_tokens);
  const format = adalahRecord(badan.response_format) ? badan.response_format.type : undefined;
  return {
    systemText: sistemBagian.join("\n"),
    pesan,
    tools,
    maxTokens: maks1 ?? maks2,
    adaMaxTokens: maks1 !== null || maks2 !== null,
    stops: daftarString(badan.stop),
    jsonMode: format === "json_object" || format === "json_schema",
    temperature: angkaAtauNull(badan.temperature) ?? undefined,
    topP: angkaAtauNull(badan.top_p) ?? undefined,
  };
}

function ekstrakAnthropic(badan: Record<string, unknown>): Kanonis {
  const systemText = teksBlok(badan.system);
  const pesanMentah = Array.isArray(badan.messages)
    ? (badan.messages as unknown[]).filter(adalahRecord)
    : [];
  const pesan: PesanKanonis[] = [];
  for (const m of pesanMentah) {
    const role = typeof m.role === "string" ? m.role : "user";
    const text = teksBlok(m.content);
    const gambar: GambarAcuan[] = [];
    if (Array.isArray(m.content)) {
      for (const blok of m.content) {
        if (!adalahRecord(blok) || blok.type !== "image" || !adalahRecord(blok.source)) continue;
        if (blok.source.type === "base64" && typeof blok.source.data === "string") {
          gambar.push({
            url: "",
            dataB64: blok.source.data,
            mime: typeof blok.source.media_type === "string" ? blok.source.media_type : "image/png",
          });
        } else if (blok.source.type === "url" && typeof blok.source.url === "string" && blok.source.url !== "") {
          gambar.push(gambarDariUrl(blok.source.url));
        }
      }
    }
    pesan.push({ role, text, gambar });
  }
  const tools: ToolKanonis[] = [];
  if (Array.isArray(badan.tools)) {
    for (const t of badan.tools) {
      if (adalahRecord(t) && typeof t.name === "string") {
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          parameters: t.input_schema !== undefined ? t.input_schema : {},
        });
      }
    }
  }
  return {
    systemText,
    pesan,
    tools,
    maxTokens: angkaAtauNull(badan.max_tokens),
    adaMaxTokens: angkaAtauNull(badan.max_tokens) !== null,
    stops: daftarString(badan.stop_sequences),
    jsonMode: false,
    temperature: angkaAtauNull(badan.temperature) ?? undefined,
    topP: angkaAtauNull(badan.top_p) ?? undefined,
  };
}

function urlGambar(g: GambarAcuan): string {
  if (g.url !== "") return g.url;
  return `data:${g.mime};base64,${g.dataB64 ?? ""}`;
}

// --- Membangun body untuk wire provider dari bentuk kanonis. ---

function bangunOpenAI(k: Kanonis, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (k.systemText !== "") messages.push({ role: "system", content: k.systemText });
  for (const p of k.pesan) {
    if (p.gambar.length === 0) {
      messages.push({ role: p.role, content: p.text });
    } else {
      const content: Record<string, unknown>[] = [{ type: "text", text: p.text }];
      for (const g of p.gambar) {
        content.push({ type: "image_url", image_url: { url: urlGambar(g) } });
      }
      messages.push({ role: p.role, content });
    }
  }
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (k.tools.length > 0) {
    body.tools = k.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (k.adaMaxTokens && k.maxTokens !== null) body.max_tokens = k.maxTokens;
  if (k.stops.length > 0) body.stop = k.stops;
  if (k.jsonMode) body.response_format = { type: "json_object" };
  if (k.temperature !== undefined) body.temperature = k.temperature;
  if (k.topP !== undefined) body.top_p = k.topP;
  return body;
}

function bangunAnthropic(k: Kanonis, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const p of k.pesan) {
    const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : "user";
    if (p.gambar.length === 0) {
      messages.push({ role, content: p.text });
    } else {
      const content: Record<string, unknown>[] = [{ type: "text", text: p.text }];
      for (const g of p.gambar) {
        if (g.dataB64 !== null && g.url === "") {
          content.push({
            type: "image",
            source: { type: "base64", media_type: g.mime, data: g.dataB64 },
          });
        } else {
          content.push({ type: "image", source: { type: "url", url: urlGambar(g) } });
        }
      }
      messages.push({ role, content });
    }
  }
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (k.systemText !== "") body.system = k.systemText;
  if (k.tools.length > 0) {
    body.tools = k.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (k.adaMaxTokens && k.maxTokens !== null) body.max_tokens = k.maxTokens;
  if (k.stops.length > 0) body.stop_sequences = k.stops;
  if (k.temperature !== undefined) body.temperature = k.temperature;
  if (k.topP !== undefined) body.top_p = k.topP;
  return body;
}

function bangunGemini(k: Kanonis): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  for (const p of k.pesan) {
    const parts: Record<string, unknown>[] = [];
    if (p.text !== "" || p.gambar.length === 0) parts.push({ text: p.text });
    for (const g of p.gambar) {
      if (g.dataB64 !== null) {
        parts.push({ inlineData: { mimeType: g.mime, data: g.dataB64 } });
      } else {
        parts.push({ fileData: { fileUri: g.url } });
      }
    }
    contents.push({ role: p.role === "assistant" ? "model" : "user", parts });
  }
  const body: Record<string, unknown> = { contents };
  if (k.systemText !== "") body.systemInstruction = { parts: [{ text: k.systemText }] };
  if (k.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: k.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  const config: Record<string, unknown> = {};
  if (k.adaMaxTokens && k.maxTokens !== null) config.maxOutputTokens = k.maxTokens;
  if (k.stops.length > 0) config.stopSequences = k.stops;
  if (k.temperature !== undefined) config.temperature = k.temperature;
  if (k.topP !== undefined) config.topP = k.topP;
  if (k.jsonMode) config.responseMimeType = "application/json";
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return body;
}

// ---------------------------------------------------------------------------
// Panggilan ke provider: selalu meminta jawaban JSON (bukan stream). Jawaban
// stream untuk klien dibentuk ulang dari teks + usage yang utuh, sehingga
// failover tetap bersih — tidak ada jawaban setengah jalan yang terlanjur
// terkirim sebelum provider terbukti menjawab.
// ---------------------------------------------------------------------------

interface JawabanProvider {
  text: string;
  input: number;
  output: number;
  stop: string;
}

function teksJawabanOpenAI(badan: Record<string, unknown>): JawabanProvider | null {
  if (!Array.isArray(badan.choices) || badan.choices.length === 0) return null;
  const pilihan = badan.choices[0];
  if (!adalahRecord(pilihan) || !adalahRecord(pilihan.message)) return null;
  const konten = pilihan.message.content;
  const text = typeof konten === "string" ? konten : teksBlok(konten);
  const usage = adalahRecord(badan.usage) ? badan.usage : {};
  const input = angkaAtauNull(usage.prompt_tokens);
  const output = angkaAtauNull(usage.completion_tokens);
  if (input === null || output === null) return null;
  return {
    text,
    input,
    output,
    stop: typeof pilihan.finish_reason === "string" ? pilihan.finish_reason : "stop",
  };
}

function teksJawabanAnthropic(badan: Record<string, unknown>): JawabanProvider | null {
  if (!Array.isArray(badan.content)) return null;
  const bagian: string[] = [];
  for (const blok of badan.content) {
    if (adalahRecord(blok) && blok.type === "text" && typeof blok.text === "string") {
      bagian.push(blok.text);
    }
  }
  const usage = adalahRecord(badan.usage) ? badan.usage : {};
  const input = angkaAtauNull(usage.input_tokens);
  const output = angkaAtauNull(usage.output_tokens);
  if (input === null || output === null) return null;
  return {
    text: bagian.join(""),
    input,
    output,
    stop: typeof badan.stop_reason === "string" ? badan.stop_reason : "end_turn",
  };
}

function teksJawabanGemini(badan: Record<string, unknown>): JawabanProvider | null {
  if (!Array.isArray(badan.candidates) || badan.candidates.length === 0) return null;
  const kandidat = badan.candidates[0];
  if (!adalahRecord(kandidat) || !adalahRecord(kandidat.content)) return null;
  const parts = kandidat.content.parts;
  const bagian: string[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (adalahRecord(part) && typeof part.text === "string") bagian.push(part.text);
    }
  }
  const meta = adalahRecord(badan.usageMetadata) ? badan.usageMetadata : {};
  const input = angkaAtauNull(meta.promptTokenCount);
  const output = angkaAtauNull(meta.candidatesTokenCount);
  if (input === null || output === null) return null;
  return {
    text: bagian.join(""),
    input,
    output,
    stop: typeof kandidat.finishReason === "string" ? kandidat.finishReason : "STOP",
  };
}

async function panggilProvider(
  envUrl: string,
  info: InfoProvider,
  model: string,
  body: Record<string, unknown>,
  versiAnthropic: string | null,
): Promise<JawabanProvider | null> {
  const dir = info.dir;
  let url: string;
  if (dir.wire === "openai") url = `${envUrl}${dir.path}/v1/chat/completions`;
  else if (dir.wire === "anthropic") url = `${envUrl}${dir.path}/v1/messages`;
  else url = `${envUrl}${dir.path}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers: Record<string, string> = { "content-type": "application/json", ...headerAuth(dir) };
  if (dir.wire === "anthropic") headers["anthropic-version"] = versiAnthropic ?? "2023-06-01";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let badan: unknown;
  try {
    badan = await res.json();
  } catch {
    return null;
  }
  if (!adalahRecord(badan)) return null;
  if (dir.wire === "openai") return teksJawabanOpenAI(badan);
  if (dir.wire === "anthropic") return teksJawabanAnthropic(badan);
  return teksJawabanGemini(badan);
}

// ---------------------------------------------------------------------------
// Membentuk jawaban untuk klien: teks provider diteruskan utuh tanpa diubah,
// usage diteruskan persis, dan alasan berhenti dipetakan antar-wire menurut
// keluarganya (stop/end_turn/STOP, length/max_tokens, tool_calls/tool_use,
// content_filter/refusal).
// ---------------------------------------------------------------------------

function petakanStop(stop: string, api: Wire): string {
  const keluarga = new Map<string, number>([
    ["stop", 0],
    ["end_turn", 0],
    ["STOP", 0],
    ["length", 1],
    ["max_tokens", 1],
    ["MAX_TOKENS", 1],
    ["tool_calls", 2],
    ["function_call", 2],
    ["tool_use", 2],
    ["content_filter", 3],
    ["refusal", 3],
    ["SAFETY", 3],
  ]);
  const fam = keluarga.get(stop) ?? 0;
  if (api === "anthropic") {
    return fam === 1 ? "max_tokens" : fam === 2 ? "tool_use" : fam === 3 ? "refusal" : "end_turn";
  }
  return fam === 1 ? "length" : fam === 2 ? "tool_calls" : fam === 3 ? "content_filter" : "stop";
}

function potongTeks(text: string): string[] {
  const hasil: string[] = [];
  for (let i = 0; i < text.length; i += POTONG_SSE) hasil.push(text.slice(i, i + POTONG_SSE));
  return hasil.length === 0 ? [""] : hasil;
}

function bingkaiSse(event: string | null, data: unknown): string {
  return `${event === null ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function emitOpenAI(jawaban: JawabanProvider, model: string, stream: boolean): string {
  const stop = petakanStop(jawaban.stop, "openai");
  const usage = {
    prompt_tokens: jawaban.input,
    completion_tokens: jawaban.output,
    total_tokens: jawaban.input + jawaban.output,
  };
  if (!stream) {
    return (
      JSON.stringify({
        id: "chatcmpl-agg",
        object: "chat.completion",
        created: CREATED_TETAP,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: jawaban.text },
            finish_reason: stop,
            logprobs: null,
          },
        ],
        usage,
      }) + "\n"
    );
  }
  const potongan = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: "chatcmpl-agg",
    object: "chat.completion.chunk",
    created: CREATED_TETAP,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const bingkai: string[] = [bingkaiSse(null, potongan({ role: "assistant", content: "" }, null))];
  for (const bagian of potongTeks(jawaban.text)) {
    bingkai.push(bingkaiSse(null, potongan({ content: bagian }, null)));
  }
  bingkai.push(bingkaiSse(null, potongan({}, stop)));
  bingkai.push(
    bingkaiSse(null, {
      id: "chatcmpl-agg",
      object: "chat.completion.chunk",
      created: CREATED_TETAP,
      model,
      choices: [],
      usage,
    }),
  );
  bingkai.push("data: [DONE]\n\n");
  return bingkai.join("");
}

function emitAnthropic(jawaban: JawabanProvider, model: string, stream: boolean): string {
  const stop = petakanStop(jawaban.stop, "anthropic");
  if (!stream) {
    return (
      JSON.stringify({
        id: "msg_agg",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: jawaban.text }],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: jawaban.input, output_tokens: jawaban.output },
      }) + "\n"
    );
  }
  const bingkai: string[] = [
    bingkaiSse("message_start", {
      type: "message_start",
      message: {
        id: "msg_agg",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: jawaban.input, output_tokens: 0 },
      },
    }),
    bingkaiSse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];
  for (const bagian of potongTeks(jawaban.text)) {
    bingkai.push(
      bingkaiSse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: bagian },
      }),
    );
  }
  bingkai.push(
    bingkaiSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    bingkaiSse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: jawaban.output },
    }),
    bingkaiSse("message_stop", { type: "message_stop" }),
  );
  return bingkai.join("");
}

// ---------------------------------------------------------------------------
// Routing: untuk tiap request, ambil model gratis terbaik tiap provider yang
// memenuhi syarat, urutkan berdasarkan rating, lalu coba satu per satu.
// Provider yang tiga kali berturut-turut menolak diprioritaskan terakhir.
// Wire Anthropic tidak dipakai untuk request mode JSON dari klien OpenAI,
// karena wire itu tidak bisa membawa mode JSON dalam gemanya.
// ---------------------------------------------------------------------------

interface Kandidat {
  info: InfoProvider;
  model: InfoModel;
}

const gagalBeruntun = new Map<string, number>();
let nomorRequest = 0;

function syaratDariBadan(api: Wire, badan: Record<string, unknown>, k: Kanonis): Syarat {
  void api;
  void badan;
  return {
    tools: k.tools.length > 0,
    vision: k.pesan.some((p) => p.gambar.length > 0),
    json: k.jsonMode,
    minContext: null,
  };
}

function urutkanKandidat(daftar: Kandidat[]): Kandidat[] {
  return [...daftar].sort((a, b) => {
    const hukumA = (gagalBeruntun.get(a.info.dir.id) ?? 0) >= 3 ? 1 : 0;
    const hukumB = (gagalBeruntun.get(b.info.dir.id) ?? 0) >= 3 ? 1 : 0;
    if (hukumA !== hukumB) return hukumA - hukumB;
    if (a.model.rating !== b.model.rating) return b.model.rating - a.model.rating;
    if (a.info.dir.id !== b.info.dir.id) return a.info.dir.id < b.info.dir.id ? -1 : 1;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
}

async function layaniRequest(
  envUrl: string,
  keadaan: KeadaanKatalog,
  api: Wire,
  badan: Record<string, unknown>,
  versiAnthropic: string | null,
): Promise<{ status: number; tubuh: string; jenis: string }> {
  const indeks = nomorRequest;
  nomorRequest += 1;
  const kanonis = api === "openai" ? ekstrakOpenAI(badan) : ekstrakAnthropic(badan);
  const syarat =
    syaratDariManifest(keadaan.manifest[indeks]) ?? syaratDariBadan(api, badan, kanonis);
  const stream = badan.stream === true;

  const kandidat: Kandidat[] = [];
  for (const info of keadaan.providers) {
    if (api === "openai" && kanonis.jsonMode && info.dir.wire === "anthropic") continue;
    let terbaik: InfoModel | null = null;
    for (const m of info.models) {
      if (!memenuhi(m, syarat)) continue;
      if (
        terbaik === null ||
        m.rating > terbaik.rating ||
        (m.rating === terbaik.rating && m.id < terbaik.id)
      ) {
        terbaik = m;
      }
    }
    if (terbaik !== null) kandidat.push({ info, model: terbaik });
  }

  for (const { info, model } of urutkanKandidat(kandidat)) {
    let bodyProvider: Record<string, unknown>;
    if (info.dir.wire === api) {
      // Wire sama: teruskan body klien apa adanya, hanya ganti model dan
      // matikan stream (jawaban stream dibentuk ulang di sini).
      bodyProvider = { ...badan, model: model.id, stream: false };
      if (info.dir.wire === "openai") delete bodyProvider.stream_options;
    } else if (info.dir.wire === "openai") {
      bodyProvider = bangunOpenAI(kanonis, model.id);
    } else if (info.dir.wire === "anthropic") {
      bodyProvider = bangunAnthropic(kanonis, model.id);
    } else {
      bodyProvider = bangunGemini(kanonis);
    }
    const jawaban = await panggilProvider(envUrl, info, model.id, bodyProvider, versiAnthropic);
    if (jawaban !== null) {
      gagalBeruntun.set(info.dir.id, 0);
      const tubuh =
        api === "openai"
          ? emitOpenAI(jawaban, model.id, stream)
          : emitAnthropic(jawaban, model.id, stream);
      return {
        status: 200,
        tubuh,
        jenis: stream ? "text/event-stream; charset=utf-8" : "application/json",
      };
    }
    gagalBeruntun.set(info.dir.id, (gagalBeruntun.get(info.dir.id) ?? 0) + 1);
  }

  // Semua kandidat menolak: jawab dengan galat berbentuk wire klien.
  if (api === "openai") {
    return {
      status: 502,
      tubuh:
        JSON.stringify({
          error: {
            message: "semua provider menolak request ini",
            type: "api_error",
            param: null,
            code: "all_providers_failed",
          },
        }) + "\n",
      jenis: "application/json",
    };
  }
  return {
    status: 502,
    tubuh:
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "semua provider menolak request ini" },
      }) + "\n",
    jenis: "application/json",
  };
}

function daftarModelKlien(keadaan: KeadaanKatalog, anthropic: boolean): string {
  const terlihat = new Set<string>();
  const ids: string[] = [];
  for (const p of keadaan.katalog.providers) {
    for (const m of p.models) {
      if (!m.free || terlihat.has(m.id)) continue;
      terlihat.add(m.id);
      ids.push(m.id);
    }
  }
  if (anthropic) {
    return (
      JSON.stringify({
        data: ids.map((id) => ({
          type: "model",
          id,
          display_name: id,
          created_at: DIBUAT_TETAP,
        })),
        has_more: false,
      }) + "\n"
    );
  }
  return (
    JSON.stringify({
      object: "list",
      data: ids.map((id) => ({
        id,
        object: "model",
        created: CREATED_TETAP,
        owned_by: "aggregator",
      })),
    }) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Server HTTP + alur trial: dengar di port ephemeral, daftarkan port dan
// katalog ke env, layani request klien satu per satu, lalu keluar 0 saat
// env menyatakan workload selesai.
// ---------------------------------------------------------------------------

function bacaBadan(req: IncomingMessage): Promise<Buffer> {
  return new Promise((selesai, gagal) => {
    const potongan: Buffer[] = [];
    let total = 0;
    let kelebihan = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > BATAS_BADAN) {
        kelebihan = true;
        return;
      }
      potongan.push(c);
    });
    req.on("end", () => {
      if (kelebihan) gagal(new Error("badan terlalu besar"));
      else selesai(Buffer.concat(potongan));
    });
    req.on("error", gagal);
  });
}

async function utama(): Promise<void> {
  const argumen = process.argv.slice(2);
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
  let brief = bacaBrief();
  if (brief === null && envUrl !== "") brief = await bacaInstance(envUrl);

  if (argumen.includes("--list")) {
    const keadaan = await susunKatalog(envUrl, brief);
    process.stdout.write(`${JSON.stringify(keadaan.katalog)}\n`);
    return;
  }

  const keadaan = await susunKatalog(envUrl, brief);
  if (envUrl === "") {
    process.stderr.write("MAKEFUN_ENV_URL tidak disetel; tidak ada env untuk dilayani.\n");
    process.exit(1);
  }

  // Antrean berurutan: klien mengirim satu per satu, dan antrean ini
  // menjamin tidak pernah ada dua panggilan provider yang bersamaan.
  let antrean: Promise<void> = Promise.resolve();
  const server = createServer((req, res) => {
    const jalan = (req.url ?? "/").split("?")[0];
    const kirim = (status: number, tubuh: string, jenis: string) => {
      res.writeHead(status, { "content-type": jenis, "cache-control": "no-cache" });
      res.end(tubuh);
    };
    if (req.method === "GET" && jalan === "/v1/models") {
      const anthropic = req.headers["x-api-key"] !== undefined;
      kirim(200, daftarModelKlien(keadaan, anthropic), "application/json");
      return;
    }
    if (
      req.method === "POST" &&
      (jalan === "/v1/chat/completions" || jalan === "/v1/messages")
    ) {
      const api: Wire = jalan === "/v1/messages" ? "anthropic" : "openai";
      const tugas = antrean.then(async () => {
        let badan: unknown;
        try {
          const mentah = await bacaBadan(req);
          badan = JSON.parse(mentah.toString("utf8"));
        } catch {
          kirim(400, '{"error":"badan bukan JSON yang valid"}\n', "application/json");
          return;
        }
        if (!adalahRecord(badan)) {
          kirim(400, '{"error":"badan harus satu objek JSON"}\n', "application/json");
          return;
        }
        const versi = req.headers["anthropic-version"];
        const versiAnthropic =
          typeof versi === "string" ? versi : Array.isArray(versi) ? (versi[0] ?? null) : null;
        const hasil = await layaniRequest(envUrl, keadaan, api, badan, versiAnthropic);
        kirim(hasil.status, hasil.tubuh, hasil.jenis);
      });
      antrean = tugas.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    kirim(404, '{"error":"rute tidak dikenal"}\n', "application/json");
  });

  await new Promise<void>((selesai, gagal) => {
    server.once("error", gagal);
    server.listen(0, "0.0.0.0", () => selesai());
  });
  const alamat = server.address();
  const port = typeof alamat === "object" && alamat !== null ? alamat.port : 0;

  let terdaftar = false;
  for (let percobaan = 0; percobaan < 5 && !terdaftar; percobaan++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog: keadaan.katalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) terdaftar = true;
    } catch {
      // Coba lagi di bawah.
    }
    if (!terdaftar && percobaan < 4) await tidur(200);
  }
  if (!terdaftar) {
    process.stderr.write("gagal mendaftar ke env.\n");
    process.exit(1);
  }

  for (;;) {
    try {
      const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const badan: unknown = await res.json();
        if (adalahRecord(badan) && badan.done === true) {
          server.close();
          process.exit(0);
        }
      }
    } catch {
      // Env belum menjawab; polling berlanjut.
    }
    await tidur(100);
  }
}

utama().catch((err: unknown) => {
  process.stderr.write(`gagal fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
