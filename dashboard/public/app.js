const seedBtn = document.getElementById("seedBtn");
const compareBtn = document.getElementById("compareBtn");
const compareAseBtn = document.getElementById("compareAseBtn");
const queryInput = document.getElementById("queryInput");
const statusLine = document.getElementById("statusLine");

const BLOCKS = {
  "classic-keyword": { title: "Keyword (BM25) Results", el: document.getElementById("classic-keyword") },
  "classic-vector": { title: "Vector (k-NN, Bedrock/Titan) Results", el: document.getElementById("classic-vector") },
  "classic-hybrid": { title: "Hybrid Results (semantic-primary + keyword-supplement)", el: document.getElementById("classic-hybrid") },
  "classic-ase": { title: "ASE (sparse, AOSS-managed) Results", el: document.getElementById("classic-ase") },
  "nextgen-keyword": { title: "Keyword (BM25) Results", el: document.getElementById("nextgen-keyword") },
  "nextgen-vector": { title: "Vector (k-NN, Bedrock/Titan) Results", el: document.getElementById("nextgen-vector") },
  "nextgen-hybrid": { title: "Hybrid Results (semantic-primary + keyword-supplement)", el: document.getElementById("nextgen-hybrid") },
  "nextgen-ase": { title: "ASE (sparse, AOSS-managed) Results", el: document.getElementById("nextgen-ase") }
};

const SOURCE_BADGE = {
  keyword: '<span class="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-900/40 text-amber-300 border border-amber-800">via keyword</span>',
  vector: '<span class="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-800">via semantic</span>'
};

function setStatus(text, isError) {
  statusLine.textContent = text;
  statusLine.className = "mt-2 text-xs h-4 " + (isError ? "text-red-400" : "text-slate-500");
}

function renderBlock(blockId, outcome) {
  const template = document.getElementById("resultBlockTemplate");
  const node = template.content.cloneNode(true);
  const { title, el } = BLOCKS[blockId];

  node.querySelector(".block-title").textContent = title;
  node.querySelector(".block-hitcount").textContent = `${outcome.hitCount} hit${outcome.hitCount === 1 ? "" : "s"}`;

  const card = node.querySelector(".response-card");
  if (outcome.error) {
    const notice = document.createElement("div");
    notice.className = "p-3 text-xs text-amber-400";
    notice.textContent = `Not available on this collection: ${outcome.error}`;
    card.appendChild(notice);
  } else if (outcome.results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "p-3 text-xs text-slate-500";
    empty.textContent = "No results — try seeding sample data first.";
    card.appendChild(empty);
  } else {
    for (const r of outcome.results) {
      const row = document.createElement("div");
      row.className = "p-3 text-sm";
      const badge = r.source ? SOURCE_BADGE[r.source] || "" : "";
      row.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="font-medium text-slate-200">${escapeHtml(r.title)}${badge}</span>
          <span class="text-xs font-mono text-slate-500">${r.score.toFixed(4)}</span>
        </div>
        <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(r.severity)} · ${escapeHtml(r.assetName)} · ${escapeHtml(r.findingId)}</div>
      `;
      card.appendChild(row);
    }
  }

  const metaBody = node.querySelector(".metadata-body");
  const meta = [
    ["OpenSearch Query Latency", `${outcome.latencyMs} ms`],
    ["Total Generation Time", "N/A (no generation step)"],
    ["Retrieve Hit Count", String(outcome.hitCount)],
    ["Model String", outcome.modelId]
  ];
  for (const [k, v] of meta) {
    const dt = document.createElement("dt");
    dt.className = "text-slate-500";
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.className = "text-slate-300 font-mono text-[11px]";
    dd.textContent = v;
    metaBody.appendChild(dt);
    metaBody.appendChild(dd);
  }

  el.innerHTML = "";
  el.appendChild(node);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let pollHandle = null;

function pollSeedStatus() {
  pollHandle = setInterval(async () => {
    try {
      const res = await fetch("/api/seed/status");
      const p = await res.json();

      if (p.status === "running") {
        setStatus(`${p.phase} — ${p.indexed}/${p.total} indexed...`);
      } else if (p.status === "complete") {
        setStatus(`Seed complete — ${p.indexed} findings indexed into both Classic and NextGen.`);
        clearInterval(pollHandle);
        seedBtn.disabled = false;
      } else if (p.status === "error") {
        setStatus(`Seed failed: ${p.error}`, true);
        clearInterval(pollHandle);
        seedBtn.disabled = false;
      }
    } catch (err) {
      setStatus(`Lost connection while polling seed status: ${err.message}`, true);
      clearInterval(pollHandle);
      seedBtn.disabled = false;
    }
  }, 3000);
}

seedBtn.addEventListener("click", async () => {
  seedBtn.disabled = true;
  setStatus("Starting seed job — this runs in the background and can take a while for large counts...");
  try {
    const res = await fetch("/api/seed", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "could not start seed job");
    setStatus(`Seed job started — generating ${data.total} findings, split between S3 and DynamoDB...`);
    if (pollHandle) clearInterval(pollHandle);
    pollSeedStatus();
  } catch (err) {
    setStatus(`Seed failed to start: ${err.message}`, true);
    seedBtn.disabled = false;
  }
});

compareBtn.addEventListener("click", async () => {
  const query = queryInput.value.trim();
  if (!query) {
    setStatus("Enter a query first.", true);
    return;
  }
  compareBtn.disabled = true;
  compareAseBtn.disabled = true;
  setStatus("Running comparison...");
  try {
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "compare failed");

    renderBlock("classic-keyword", data.classic.keyword);
    renderBlock("classic-vector", data.classic.vector);
    renderBlock("classic-hybrid", data.classic.hybrid);
    renderBlock("classic-ase", data.classic.ase);
    renderBlock("nextgen-keyword", data.nextGen.keyword);
    renderBlock("nextgen-vector", data.nextGen.vector);
    renderBlock("nextgen-hybrid", data.nextGen.hybrid);
    renderBlock("nextgen-ase", data.nextGen.ase);
    setStatus("Comparison complete.");
  } catch (err) {
    setStatus(`Compare failed: ${err.message}`, true);
  } finally {
    compareBtn.disabled = false;
    compareAseBtn.disabled = false;
  }
});

/** Isolated ASE-only test — only touches the two ASE panels, no Bedrock
 *  embedding call on the backend at all (see /api/compare-ase). */
compareAseBtn.addEventListener("click", async () => {
  const query = queryInput.value.trim();
  if (!query) {
    setStatus("Enter a query first.", true);
    return;
  }
  compareBtn.disabled = true;
  compareAseBtn.disabled = true;
  setStatus("Running ASE-only comparison...");
  try {
    const res = await fetch("/api/compare-ase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "compare-ase failed");

    renderBlock("classic-ase", data.classic);
    renderBlock("nextgen-ase", data.nextGen);
    setStatus("ASE-only comparison complete.");
  } catch (err) {
    setStatus(`ASE compare failed: ${err.message}`, true);
  } finally {
    compareBtn.disabled = false;
    compareAseBtn.disabled = false;
  }
});

queryInput.addEventListener("keydown", e => {
  if (e.key === "Enter") compareBtn.click();
});
