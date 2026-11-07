/*
 * PDF Privado — ferramentas de PDF que correm 100% no browser.
 * Os ficheiros são lidos com a File API e processados em memória:
 * nada é enviado para servidores.
 *
 * Bibliotecas: pdf-lib (criar/editar PDFs), PDF.js (desenhar páginas), JSZip (ficheiros ZIP).
 * Autor: Guilherme Martins (github.com/gui198gui)
 */
import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const { PDFDocument, degrees } = window.PDFLib;
const JSZip = window.JSZip;

/* =========================================================================
 * Utilitários
 * ========================================================================= */
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "documento";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** Abre um PDF com o pdf-lib, com mensagens de erro compreensíveis. */
async function openPdf(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(String(err))) {
      throw new Error("Este PDF está protegido com palavra-passe e não pode ser editado.");
    }
    throw new Error("Não foi possível ler este ficheiro. Confirma que é um PDF válido.");
  }
}

/** Abre um PDF com o PDF.js (para desenhar as páginas). */
function openPdfJs(bytes) {
  // O PDF.js transfere o buffer para o worker, por isso passamos uma cópia.
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

/** Desenha uma página do PDF.js num canvas com fundo branco. */
async function renderPage(pdfDoc, pageNum, scale) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const size = page.getViewport({ scale: 1 });
  page.cleanup();
  return { canvas, widthPt: size.width, heightPt: size.height };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao gerar imagem."))), type, quality)
  );
}

function toGrayscale(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Converte "1-3, 5, 8-10" em grupos de páginas: [[1,2,3],[5],[8,9,10]].
 * Lança um erro com uma mensagem clara se o texto for inválido.
 */
export function parseRanges(text, maxPage) {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Indica as páginas (ex: 1-3, 5).");
  return parts.map((part) => {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`"${part}" não é um intervalo válido.`);
    let a = parseInt(m[1], 10);
    let b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > maxPage) throw new Error(`O documento só tem páginas de 1 a ${maxPage}.`);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

/* ---------- Interface: progresso, resultado, avisos ---------- */
function progress(text, fraction) {
  $("progress").hidden = false;
  $("progress-text").textContent = text;
  $("progress-bar").style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
const hideProgress = () => ($("progress").hidden = true);

let lastUrl = null;
function showResult(blob, filename, text) {
  hideProgress();
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const link = $("result-download");
  link.href = lastUrl;
  link.download = filename;
  link.textContent = `Descarregar (${fmtSize(blob.size)})`;
  $("result-text").textContent = text;
  $("result").hidden = false;
}
$("result-close").addEventListener("click", () => ($("result").hidden = true));

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

/** Corre uma operação com tratamento de erros e progresso. */
async function run(task) {
  try {
    await task();
  } catch (err) {
    console.error(err);
    hideProgress();
    toast(err.message || "Ocorreu um erro inesperado.");
  }
}

const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/* ---------- Zonas de largar ficheiros ---------- */
function setupDrop(viewId, onFiles) {
  const label = document.querySelector(`#${viewId} .drop`);
  const input = label.querySelector("input");
  const kind = label.dataset.accept;
  const multiple = label.hasAttribute("data-multiple");

  const accept = (files) => {
    let list = [...files].filter((f) =>
      kind === "pdf"
        ? f.type === "application/pdf" || /\.pdf$/i.test(f.name)
        : /^image\/(jpeg|png|webp)$/.test(f.type)
    );
    if (list.length < files.length) {
      toast(kind === "pdf" ? "Alguns ficheiros foram ignorados (só PDF)." : "Alguns ficheiros foram ignorados (só JPG, PNG ou WebP).");
    }
    if (!multiple) list = list.slice(0, 1);
    if (list.length) run(() => onFiles(list));
  };

  input.addEventListener("change", () => {
    accept(input.files);
    input.value = "";
  });
  label.addEventListener("dragover", (e) => {
    e.preventDefault();
    label.classList.add("over");
  });
  label.addEventListener("dragleave", () => label.classList.remove("over"));
  label.addEventListener("drop", (e) => {
    e.preventDefault();
    label.classList.remove("over");
    accept(e.dataTransfer.files);
  });
}

// Evita que o browser abra o ficheiro se for largado fora de uma zona válida.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

/* ---------- Reordenar com arrastar e largar ---------- */
function makeSortable(container, getArray, rerender) {
  let fromIndex = null;
  container.addEventListener("dragstart", (e) => {
    const item = e.target.closest("[data-index]");
    if (!item) return;
    fromIndex = Number(item.dataset.index);
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(fromIndex));
  });
  container.addEventListener("dragend", (e) => {
    e.target.closest("[data-index]")?.classList.remove("dragging");
    container.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  });
  container.addEventListener("dragover", (e) => {
    if (fromIndex === null) return;
    e.preventDefault();
    container.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
    e.target.closest("[data-index]")?.classList.add("drop-target");
  });
  container.addEventListener("drop", (e) => {
    const target = e.target.closest("[data-index]");
    if (fromIndex === null || !target) return;
    e.preventDefault();
    e.stopPropagation();
    const to = Number(target.dataset.index);
    const arr = getArray();
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(to, 0, moved);
    fromIndex = null;
    rerender();
  });
}

function move(arr, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

/* =========================================================================
 * Navegação entre ferramentas (#juntar, #organizar, ...)
 * ========================================================================= */
const ROUTES = ["juntar", "organizar", "separar", "imagens", "exportar", "comprimir"];
function route() {
  const name = location.hash.slice(1);
  const current = ROUTES.includes(name) ? name : "home";
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${current}`));
  document.getElementById("result").hidden = true;
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
route();

/* =========================================================================
 * 1. Juntar PDFs
 * ========================================================================= */
const merge = { files: [] };

setupDrop("view-juntar", async (files) => {
  for (const [i, file] of files.entries()) {
    progress(`A ler ${file.name}…`, i / files.length);
    const bytes = await readBytes(file);
    try {
      const doc = await openPdf(bytes);
      merge.files.push({ id: uid(), file, bytes, pages: doc.getPageCount() });
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
  }
  hideProgress();
  renderMerge();
});

function renderMerge() {
  const list = $("merge-list");
  list.innerHTML = "";
  merge.files.forEach((f, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="grip">⋮⋮</span>
      <span class="name"></span>
      <span class="meta">${plural(f.pages, "página", "páginas")} · ${fmtSize(f.file.size)}</span>
      <button class="icon-btn" data-act="up" title="Subir" aria-label="Subir">↑</button>
      <button class="icon-btn" data-act="down" title="Descer" aria-label="Descer">↓</button>
      <button class="icon-btn" data-act="del" title="Remover" aria-label="Remover">✕</button>`;
    li.querySelector(".name").textContent = f.file.name;
    list.appendChild(li);
  });
  $("merge-run").disabled = merge.files.length < 2;
  $("merge-clear").hidden = merge.files.length === 0;
}

$("merge-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = Number(btn.closest("li").dataset.index);
  if (btn.dataset.act === "up") move(merge.files, i, -1);
  if (btn.dataset.act === "down") move(merge.files, i, 1);
  if (btn.dataset.act === "del") merge.files.splice(i, 1);
  renderMerge();
});
makeSortable($("merge-list"), () => merge.files, renderMerge);

$("merge-clear").addEventListener("click", () => {
  merge.files = [];
  renderMerge();
});

$("merge-run").addEventListener("click", () =>
  run(async () => {
    const out = await PDFDocument.create();
    for (const [i, f] of merge.files.entries()) {
      progress(`A juntar ${f.file.name}…`, i / merge.files.length);
      const src = await openPdf(f.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      await yieldUI();
    }
    progress("A guardar…", 1);
    const bytes = await out.save();
    showResult(pdfBlob(bytes), "pdfs-juntos.pdf",
      `${plural(merge.files.length, "ficheiro junto", "ficheiros juntos")} num PDF com ${plural(out.getPageCount(), "página", "páginas")}.`);
  })
);

/* =========================================================================
 * 2. Organizar páginas
 * ========================================================================= */
const org = { file: null, bytes: null, jsDoc: null, pages: [], thumbs: new Map(), token: 0 };

setupDrop("view-organizar", async ([file]) => {
  progress("A abrir o PDF…", 0);
  const bytes = await readBytes(file);
  const doc = await openPdf(bytes);
  if (org.jsDoc) org.jsDoc.destroy();
  org.file = file;
  org.bytes = bytes;
  org.jsDoc = await openPdfJs(bytes);
  org.thumbs = new Map();
  org.baseRot = doc.getPages().map((p) => p.getRotation().angle);
  resetOrg();
  hideProgress();
  loadThumbs(++org.token);
});

function resetOrg() {
  org.pages = org.baseRot.map((_, i) => ({ src: i, rot: 0 }));
  renderOrg();
}

async function loadThumbs(token) {
  for (let i = 0; i < org.baseRot.length; i++) {
    if (token !== org.token) return; // foi aberto outro ficheiro
    const { canvas } = await renderPage(org.jsDoc, i + 1, 0.35);
    org.thumbs.set(i, canvas);
    const slot = document.querySelector(`#org-pages [data-src="${i}"] .thumb`);
    if (slot) placeThumb(slot, i);
  }
}

function placeThumb(slot, src) {
  const canvas = org.thumbs.get(src);
  if (!canvas) return;
  slot.innerHTML = "";
  slot.appendChild(canvas);
  const p = org.pages.find((x) => x.src === src);
  canvas.style.transform = `rotate(${p ? p.rot : 0}deg)`;
}

function renderOrg() {
  const grid = $("org-pages");
  grid.innerHTML = "";
  org.pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.draggable = true;
    el.dataset.index = i;
    el.dataset.src = p.src;
    el.innerHTML = `
      <div class="ctrls">
        <button class="icon-btn" data-act="left" title="Mover para trás" aria-label="Mover para trás">←</button>
        <button class="icon-btn" data-act="right" title="Mover para a frente" aria-label="Mover para a frente">→</button>
        <button class="icon-btn" data-act="rot" title="Rodar" aria-label="Rodar">↻</button>
        <button class="icon-btn" data-act="del" title="Apagar página" aria-label="Apagar página">🗑</button>
      </div>
      <div class="thumb"><span class="note">…</span></div>
      <span class="num">Página ${p.src + 1}</span>`;
    grid.appendChild(el);
    placeThumb(el.querySelector(".thumb"), p.src);
  });
  const total = org.baseRot?.length ?? 0;
  const removed = total - org.pages.length;
  $("org-toolbar").hidden = !org.file;
  $("org-info").textContent = org.file
    ? `${org.file.name} · ${plural(org.pages.length, "página", "páginas")}${removed ? ` (${removed} apagada${removed > 1 ? "s" : ""})` : ""}`
    : "";
  $("org-run").disabled = org.pages.length === 0;
}

$("org-pages").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = Number(btn.closest(".page").dataset.index);
  const act = btn.dataset.act;
  if (act === "left") move(org.pages, i, -1);
  if (act === "right") move(org.pages, i, 1);
  if (act === "del") org.pages.splice(i, 1);
  if (act === "rot") org.pages[i].rot = (org.pages[i].rot + 90) % 360;
  renderOrg();
});
makeSortable($("org-pages"), () => org.pages, renderOrg);

$("org-rotate-all").addEventListener("click", () => {
  org.pages.forEach((p) => (p.rot = (p.rot + 90) % 360));
  renderOrg();
});
$("org-reset").addEventListener("click", resetOrg);

$("org-run").addEventListener("click", () =>
  run(async () => {
    progress("A criar o PDF…", 0.3);
    const src = await openPdf(org.bytes);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, org.pages.map((p) => p.src));
    copied.forEach((page, i) => {
      const p = org.pages[i];
      page.setRotation(degrees((org.baseRot[p.src] + p.rot) % 360));
      out.addPage(page);
    });
    progress("A guardar…", 0.9);
    const bytes = await out.save();
    showResult(pdfBlob(bytes), `${baseName(org.file.name)}-organizado.pdf`,
      `PDF guardado com ${plural(out.getPageCount(), "página", "páginas")}.`);
  })
);

/* =========================================================================
 * 3. Separar PDF
 * ========================================================================= */
const split = { file: null, bytes: null, pages: 0 };

setupDrop("view-separar", async ([file]) => {
  progress("A abrir o PDF…", 0);
  const bytes = await readBytes(file);
  const doc = await openPdf(bytes);
  Object.assign(split, { file, bytes, pages: doc.getPageCount() });
  $("split-info").textContent = `${file.name} · ${plural(split.pages, "página", "páginas")}`;
  $("split-range").placeholder = split.pages > 1 ? `ex: 1-${Math.min(3, split.pages)}, ${split.pages}` : "1";
  $("split-panel").hidden = false;
  $("split-run").disabled = false;
  hideProgress();
});

document.querySelectorAll('input[name="split-mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    $("split-range").disabled = r.value === "each" && r.checked;
  })
);

async function extract(src, pageNumbers) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

const label = (group) => (group.length === 1 ? `p${group[0]}` : `p${group[0]}-${group[group.length - 1]}`);

$("split-run").addEventListener("click", () =>
  run(async () => {
    const mode = document.querySelector('input[name="split-mode"]:checked').value;
    const name = baseName(split.file.name);
    const groups =
      mode === "each"
        ? Array.from({ length: split.pages }, (_, i) => [i + 1])
        : parseRanges($("split-range").value, split.pages);

    progress("A separar…", 0);
    const src = await openPdf(split.bytes);

    if (mode === "range") {
      const pages = [...new Set(groups.flat())];
      const bytes = await extract(src, pages);
      return showResult(pdfBlob(bytes), `${name}-paginas.pdf`, `${plural(pages.length, "página extraída", "páginas extraídas")}.`);
    }

    if (groups.length === 1) {
      const bytes = await extract(src, groups[0]);
      return showResult(pdfBlob(bytes), `${name}-${label(groups[0])}.pdf`, "1 ficheiro criado.");
    }

    const zip = new JSZip();
    for (const [i, g] of groups.entries()) {
      progress(`A criar ficheiro ${i + 1} de ${groups.length}…`, i / groups.length);
      zip.file(`${name}-${label(g)}.pdf`, await extract(src, g));
      await yieldUI();
    }
    progress("A criar o ZIP…", 1);
    const blob = await zip.generateAsync({ type: "blob" });
    showResult(blob, `${name}-separado.zip`, `${groups.length} ficheiros PDF dentro de um ZIP.`);
  })
);

/* =========================================================================
 * 4. Imagens para PDF
 * ========================================================================= */
const imgs = { list: [] };
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

setupDrop("view-imagens", async (files) => {
  for (const file of files) imgs.list.push({ id: uid(), file, url: URL.createObjectURL(file) });
  renderImgs();
});

function renderImgs() {
  const grid = $("img-list");
  grid.innerHTML = "";
  imgs.list.forEach((im, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.draggable = true;
    el.dataset.index = i;
    el.innerHTML = `
      <div class="ctrls">
        <button class="icon-btn" data-act="left" title="Mover para trás" aria-label="Mover para trás">←</button>
        <button class="icon-btn" data-act="right" title="Mover para a frente" aria-label="Mover para a frente">→</button>
        <button class="icon-btn" data-act="del" title="Remover" aria-label="Remover">✕</button>
      </div>
      <div class="thumb"><img alt="" draggable="false"></div>
      <span class="num"></span>`;
    el.querySelector("img").src = im.url;
    el.querySelector(".num").textContent = `${i + 1}. ${im.file.name}`;
    grid.appendChild(el);
  });
  const has = imgs.list.length > 0;
  $("img-options").hidden = !has;
  $("img-run").disabled = !has;
  $("img-clear").hidden = !has;
}

$("img-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = Number(btn.closest(".page").dataset.index);
  if (btn.dataset.act === "left") move(imgs.list, i, -1);
  if (btn.dataset.act === "right") move(imgs.list, i, 1);
  if (btn.dataset.act === "del") URL.revokeObjectURL(imgs.list.splice(i, 1)[0].url);
  renderImgs();
});
makeSortable($("img-list"), () => imgs.list, renderImgs);

$("img-clear").addEventListener("click", () => {
  imgs.list.forEach((im) => URL.revokeObjectURL(im.url));
  imgs.list = [];
  renderImgs();
});

/** Lê uma imagem respeitando a orientação EXIF (fotos de telemóvel). */
async function embedImage(out, file) {
  if (file.type === "image/png") {
    const img = await out.embedPng(await readBytes(file));
    return { img, w: img.width, h: img.height };
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  return { img, w: canvas.width, h: canvas.height };
}

$("img-run").addEventListener("click", () =>
  run(async () => {
    const size = $("img-size").value;
    const orient = $("img-orient").value;
    const margin = Number($("img-margin").value);
    const out = await PDFDocument.create();

    for (const [i, im] of imgs.list.entries()) {
      progress(`A adicionar imagem ${i + 1} de ${imgs.list.length}…`, i / imgs.list.length);
      const { img, w, h } = await embedImage(out, im.file);

      let pw, ph;
      if (size === "fit") {
        // 96 px = 1 polegada = 72 pt
        pw = w * 0.75 + margin * 2;
        ph = h * 0.75 + margin * 2;
      } else {
        [pw, ph] = PAGE_SIZES[size];
        const landscape = orient === "landscape" || (orient === "auto" && w > h);
        if (landscape) [pw, ph] = [ph, pw];
      }
      const page = out.addPage([pw, ph]);
      const scale = Math.min((pw - margin * 2) / w, (ph - margin * 2) / h);
      const dw = w * scale;
      const dh = h * scale;
      page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      await yieldUI();
    }
    progress("A guardar…", 1);
    const bytes = await out.save();
    showResult(pdfBlob(bytes), "imagens.pdf", `PDF criado com ${plural(out.getPageCount(), "página", "páginas")}.`);
  })
);

/* =========================================================================
 * 5. PDF para imagens
 * ========================================================================= */
const exp = { file: null, bytes: null, pages: 0 };

setupDrop("view-exportar", async ([file]) => {
  progress("A abrir o PDF…", 0);
  const bytes = await readBytes(file);
  const doc = await openPdf(bytes);
  Object.assign(exp, { file, bytes, pages: doc.getPageCount() });
  $("exp-info").textContent = `${file.name} · ${plural(exp.pages, "página", "páginas")}`;
  $("exp-options").hidden = false;
  $("exp-run").disabled = false;
  hideProgress();
});

$("exp-run").addEventListener("click", () =>
  run(async () => {
    const fmt = $("exp-format").value;
    const ext = fmt === "png" ? "png" : "jpg";
    const scale = Number($("exp-dpi").value) / 72;
    const rangeText = $("exp-range").value.trim();
    const pages = rangeText ? [...new Set(parseRanges(rangeText, exp.pages).flat())] : Array.from({ length: exp.pages }, (_, i) => i + 1);
    const name = baseName(exp.file.name);
    const pad = String(exp.pages).length;

    const jsDoc = await openPdfJs(exp.bytes);
    const results = [];
    try {
      for (const [i, n] of pages.entries()) {
        progress(`A converter página ${n} (${i + 1} de ${pages.length})…`, i / pages.length);
        const { canvas } = await renderPage(jsDoc, n, scale);
        results.push({ n, blob: await canvasToBlob(canvas, `image/${fmt}`, 0.9) });
        canvas.width = canvas.height = 0; // liberta memória
      }
    } finally {
      jsDoc.destroy();
    }

    if (results.length === 1) {
      return showResult(results[0].blob, `${name}-p${results[0].n}.${ext}`, "1 imagem criada.");
    }
    progress("A criar o ZIP…", 1);
    const zip = new JSZip();
    results.forEach((r) => zip.file(`${name}-p${String(r.n).padStart(pad, "0")}.${ext}`, r.blob));
    const blob = await zip.generateAsync({ type: "blob" });
    showResult(blob, `${name}-imagens.zip`, `${results.length} imagens dentro de um ZIP.`);
  })
);

/* =========================================================================
 * 6. Comprimir PDF
 * ========================================================================= */
const cmp = { file: null, bytes: null, pages: 0 };
const LEVELS = {
  high: { dpi: 96, quality: 0.5 },
  medium: { dpi: 130, quality: 0.65 },
  low: { dpi: 170, quality: 0.8 },
};

setupDrop("view-comprimir", async ([file]) => {
  progress("A abrir o PDF…", 0);
  const bytes = await readBytes(file);
  const doc = await openPdf(bytes);
  Object.assign(cmp, { file, bytes, pages: doc.getPageCount() });
  $("cmp-info").textContent = `${file.name} · ${plural(cmp.pages, "página", "páginas")} · ${fmtSize(file.size)}`;
  $("cmp-options").hidden = false;
  $("cmp-run").disabled = false;
  hideProgress();
});

$("cmp-run").addEventListener("click", () =>
  run(async () => {
    const { dpi, quality } = LEVELS[$("cmp-level").value];
    const gray = $("cmp-gray").checked;
    const out = await PDFDocument.create();
    const jsDoc = await openPdfJs(cmp.bytes);
    try {
      for (let n = 1; n <= cmp.pages; n++) {
        progress(`A comprimir página ${n} de ${cmp.pages}…`, (n - 1) / cmp.pages);
        const { canvas, widthPt, heightPt } = await renderPage(jsDoc, n, dpi / 72);
        if (gray) toGrayscale(canvas);
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        canvas.width = canvas.height = 0;
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const page = out.addPage([widthPt, heightPt]);
        page.drawImage(img, { x: 0, y: 0, width: widthPt, height: heightPt });
      }
    } finally {
      jsDoc.destroy();
    }
    progress("A guardar…", 1);
    const bytes = await out.save({ useObjectStreams: true });
    const before = cmp.file.size;
    const after = bytes.length;
    const pct = Math.round((1 - after / before) * 100);
    const text =
      after < before
        ? `De ${fmtSize(before)} para ${fmtSize(after)} (−${pct}%).`
        : `O resultado (${fmtSize(after)}) não ficou mais pequeno do que o original (${fmtSize(before)}). Este PDF já está otimizado: é melhor manter o original.`;
    showResult(pdfBlob(bytes), `${baseName(cmp.file.name)}-comprimido.pdf`, text);
  })
);

/* =========================================================================
 * App instalável (PWA) e funcionamento offline
 * ========================================================================= */
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("install-btn").hidden = false;
});
$("install-btn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("install-btn").hidden = true;
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker:", err));
}
