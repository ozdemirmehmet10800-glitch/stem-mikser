// etiket sayfası
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { el, on } from "../dom.js";

let collection, collectionError, hideMessage, libraryFilter, pushLayer, renderLibrary, requestBack, selectedIds, showMessage, librarySongs;   // app.js'ten (bind)

//
// Seçili şarkılara etiket ekle/çıkar (çip: hepsinde = dolu, bazılarında = kesikli, hiçbirinde = boş) ve "Etiketleri yönet"
// (yeniden adlandır, sil). Veri js/collection.js'te; burası yalnız arayüz.

let tagMode = "assign";         // "assign" | "manage"
let tagRenaming = null;         // yeniden adlandırılan etiketin kimliği

function tagMessage(text, tone = "warn") {
  if (text) showMessage(el("tag-message"), text, tone);
  else hideMessage(el("tag-message"));
}

function renderTagSheet() {
  const ids = [...selectedIds];
  const manage = tagMode === "manage";
  el("tag-title").textContent = manage ? "Etiketleri yönet" : "Etiketler";
  el("tag-sub").textContent = manage ? "Adı değiştir ya da sil. Silinen etiket tüm şarkılardan kalkar."
    : ids.length ? `${ids.length} şarkı seçili: etikete dokun, hepsine ekler ya da çıkarır.`
    : "Şarkı seçmeden etiket oluşturup yönetebilirsin; etiketlemek için kitaplıkta önce şarkıya uzun bas.";
  el("tag-add").hidden = manage;
  el("tag-mode").textContent = manage ? "Geri" : "Etiketleri yönet";
  const box = el("tag-list");
  box.classList.toggle("manage", manage);
  const tags = collection.tagList();
  const nodes = [];
  if (!tags.length) {
    const none = document.createElement("div");
    none.className = "tag-list-empty";
    none.textContent = "Henüz etiket yok.";
    nodes.push(none);
  }
  for (const tag of tags) {
    if (!manage) {
      const state = collection.tagState(tag.id, ids);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip";
      chip.disabled = !ids.length;
      chip.setAttribute("aria-pressed", state === "all" ? "true" : state === "some" ? "mixed" : "false");
      chip.append(document.createTextNode(tag.name));
      const count = document.createElement("small");
      count.textContent = String(tag.count);
      chip.append(count);
      chip.addEventListener("click", () => {
        const result = collection.setTagOnSongs(ids, tag.id, state !== "all");
        tagMessage(result.ok ? "" : collectionError(result));
        renderTagSheet();
        renderLibrary(librarySongs());
      });
      nodes.push(chip);
      continue;
    }
    const row = document.createElement("div");
    row.className = "tag-row";
    if (tagRenaming === tag.id) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = tag.name;
      input.maxLength = 24;
      input.setAttribute("aria-label", "Etiket adı");
      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn btn-small btn-primary";
      save.textContent = "Kaydet";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-small";
      cancel.textContent = "İptal";
      const commit = () => {
        const result = collection.renameTag(tag.id, input.value);
        if (!result.ok) {
          tagMessage(result.error === "empty" ? "Etiket adı boş olamaz." : collectionError(result));
          return;
        }
        tagRenaming = null;
        tagMessage("");
        renderTagSheet();
        renderLibrary(librarySongs());
      };
      save.addEventListener("click", commit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
      });
      cancel.addEventListener("click", () => { tagRenaming = null; tagMessage(""); renderTagSheet(); });
      row.append(input, save, cancel);
      nodes.push(row);
      queueMicrotask(() => { input.focus(); input.select(); });
      continue;
    }
    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "tag-count";
    count.textContent = `${tag.count} şarkı`;
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "btn btn-small";
    rename.textContent = "Adı değiştir";
    rename.addEventListener("click", () => { tagRenaming = tag.id; tagMessage(""); renderTagSheet(); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-small btn-danger";
    del.textContent = "Sil";
    del.addEventListener("click", () => {
      const sure = window.confirm(`"${tag.name}" etiketi ${tag.count} şarkıdan kaldırılacak. Silinsin mi?`);
      if (!sure) return;
      const result = collection.deleteTag(tag.id);
      tagMessage(result.ok ? "" : collectionError(result));
      if (libraryFilter.tag === tag.id) libraryFilter.tag = null;
      renderTagSheet();
      renderLibrary(librarySongs());
    });
    row.append(name, count, rename, del);
    nodes.push(row);
  }
  box.replaceChildren(...nodes);
}

function openTagSheet() {
  tagMode = "assign";
  tagRenaming = null;
  tagMessage("");
  el("tag-new").value = "";
  renderTagSheet();
  el("tag-sheet").hidden = false;
  pushLayer("tags");
  el("tag-close").focus();
}

export function closeTagSheetDom() {
  el("tag-sheet").hidden = true;
  tagRenaming = null;
  renderLibrary(librarySongs());
}

function addTagFromInput() {
  const input = el("tag-new");
  const created = collection.createTag(input.value);
  if (!created.ok) {
    tagMessage(created.error === "empty" ? "Etiket adı boş olamaz." : collectionError(created));
    return;
  }
  const ids = [...selectedIds];
  if (ids.length) {
    const applied = collection.setTagOnSongs(ids, created.id, true);
    if (!applied.ok) {
      tagMessage(collectionError(applied));
      renderTagSheet();
      return;
    }
  }
  input.value = "";
  tagMessage(created.created ? "" : "Bu etiket zaten vardı.", "ok");
  renderTagSheet();
  renderLibrary(librarySongs());
}

export function bind(deps) {
  ({ collection, collectionError, hideMessage, libraryFilter, pushLayer, renderLibrary, requestBack, selectedIds, showMessage, librarySongs } = deps);

  on("select-tags", "click", openTagSheet);
  on("tag-close", "click", () => requestBack("tags"));
  on("tag-backdrop", "click", () => requestBack("tags"));
  on("tag-new-go", "click", addTagFromInput);
  on("tag-new", "keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); addTagFromInput(); }
  });
  on("tag-mode", "click", () => {
    tagMode = tagMode === "manage" ? "assign" : "manage";
    tagRenaming = null;
    tagMessage("");
    renderTagSheet();
  });
}
