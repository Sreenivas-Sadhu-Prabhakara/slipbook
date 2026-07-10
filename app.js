/* ============================================================
   slipbook — client-side invoice & receipt maker.
   No network. No dependencies. State in localStorage.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var PROFILE_KEY = "slipbook:profile";   // business block, persists
  var DRAFT_KEY   = "slipbook:draft";     // current invoice in progress
  var SEQ_KEY     = "slipbook:seq";       // next invoice sequence number

  var storageOk = true;

  /* ---------- currency ---------- */
  var CURRENCIES = {
    PHP: { symbol: "₱", code: "PHP" },
    USD: { symbol: "$",      code: "USD" },
    INR: { symbol: "₹", code: "INR" },
    GBP: { symbol: "£", code: "GBP" },
    EUR: { symbol: "€", code: "EUR" },
    AUD: { symbol: "$",      code: "AUD" },
    GEN: { symbol: "",       code: "" }
  };

  function currencyOf() {
    var v = $("#currency").value;
    return CURRENCIES[v] || CURRENCIES.GEN;
  }

  // Round half-up to 2 dp, robust against float noise.
  function round2(n) {
    if (!isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Format a number as a money string with grouping + 2 dp, prefixed by symbol.
  function money(n, cur) {
    cur = cur || currencyOf();
    var val = round2(n);
    var neg = val < 0;
    val = Math.abs(val);
    var parts = val.toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var num = parts.join(".");
    var out = cur.symbol ? cur.symbol + num : num;
    if (!cur.symbol && cur.code) out = num + " " + cur.code;
    return (neg ? "−" : "") + out;
  }

  function numVal(str) {
    var v = parseFloat(str);
    return isNaN(v) ? 0 : v;
  }

  /* ============================================================
     ITEM ROWS
     ============================================================ */
  var rowSeq = 0;

  function makeRow(data) {
    data = data || {};
    var row = el("div", "item-row");
    row.dataset.rid = "r" + (rowSeq++);

    var desc = el("input");
    desc.type = "text";
    desc.className = "r-desc";
    desc.placeholder = "e.g. Chicken adobo meal";
    desc.value = data.desc || "";
    desc.setAttribute("aria-label", "Item description");

    var qty = el("input");
    qty.type = "number";
    qty.className = "r-qty mono";
    qty.min = "0"; qty.step = "any";
    qty.inputMode = "decimal";
    qty.placeholder = "1";
    qty.value = (data.qty != null) ? data.qty : "";
    qty.setAttribute("aria-label", "Quantity");

    var price = el("input");
    price.type = "number";
    price.className = "r-price mono";
    price.min = "0"; price.step = "any";
    price.inputMode = "decimal";
    price.placeholder = "0.00";
    price.value = (data.price != null) ? data.price : "";
    price.setAttribute("aria-label", "Unit price");

    var total = el("span", "r-total");
    total.textContent = money(0);

    var rm = el("button", "item-row__x");
    rm.type = "button";
    rm.innerHTML = "&times;";
    rm.title = "Remove item";
    rm.setAttribute("aria-label", "Remove item");
    rm.addEventListener("click", function () {
      row.parentNode.removeChild(row);
      ensureOneRow();
      render();
      saveDraft();
    });

    [desc, qty, price].forEach(function (inp) {
      inp.addEventListener("input", function () { render(); saveDraft(); });
    });

    row.appendChild(desc);
    row.appendChild(qty);
    row.appendChild(price);
    row.appendChild(total);
    row.appendChild(rm);
    return row;
  }

  function addRow(data, silent) {
    var row = makeRow(data);
    $("#itemRows").appendChild(row);
    if (!silent) { render(); saveDraft(); }
    return row;
  }

  function ensureOneRow() {
    if ($$(".item-row").length === 0) addRow(null, true);
  }

  function readRows() {
    return $$(".item-row").map(function (row) {
      var desc = $(".r-desc", row).value.trim();
      var qty = numVal($(".r-qty", row).value);
      var price = numVal($(".r-price", row).value);
      return { desc: desc, qty: qty, price: price, node: row };
    });
  }

  /* ============================================================
     MONEY MATH
     ============================================================ */
  function compute(rows) {
    var subtotal = 0;
    rows.forEach(function (r) { subtotal += r.qty * r.price; });
    subtotal = round2(subtotal);

    // discount
    var dType = ($("input[name=discountType]:checked") || {}).value || "percent";
    var dVal = numVal($("#discountValue").value);
    var discount = 0;
    if (dVal > 0) {
      discount = (dType === "percent")
        ? subtotal * (Math.min(dVal, 100) / 100)
        : Math.min(dVal, subtotal);
    }
    discount = round2(discount);
    var afterDiscount = round2(subtotal - discount);

    // tax on the discounted amount
    var taxRate = numVal($("#taxRate").value);
    var tax = round2(afterDiscount * (taxRate / 100));

    var total = round2(afterDiscount + tax);
    return {
      subtotal: subtotal, discount: discount, dType: dType, dVal: dVal,
      taxRate: taxRate, tax: tax, total: total
    };
  }

  /* ============================================================
     RENDER LIVE PREVIEW
     ============================================================ */
  function fmtDate(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var m = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    if (!m || !d) return iso;
    return months[m - 1] + " " + d + ", " + parts[0];
  }

  function render() {
    var cur = currencyOf();
    var rows = readRows();

    // live per-row totals
    rows.forEach(function (r) {
      $(".r-total", r.node).textContent = money(r.qty * r.price, cur);
    });

    // discount symbol hint in the editor
    $("#discFixedSym").textContent = cur.symbol || "#";

    // ---- business block ----
    $("#docBizName").textContent = $("#bizName").value.trim() || "Your business name";
    var bmeta = [];
    if ($("#bizPhone").value.trim()) bmeta.push($("#bizPhone").value.trim());
    if ($("#bizEmail").value.trim()) bmeta.push($("#bizEmail").value.trim());
    if ($("#bizAddress").value.trim()) bmeta.push($("#bizAddress").value.trim());
    $("#docBizMeta").textContent = bmeta.join("\n");

    // ---- invoice meta ----
    $("#docType").textContent = $("#paidToggle").checked ? "RECEIPT" : "INVOICE";
    $("#docInvNo").textContent = $("#invNo").value.trim() || "—";
    $("#docDate").textContent = fmtDate($("#invDate").value) || "—";
    var due = fmtDate($("#dueDate").value);
    var dueRow = $("#docDueRow");
    if (due) { dueRow.hidden = false; $("#docDue").textContent = due; }
    else { dueRow.hidden = true; }

    // ---- bill to ----
    var custName = $("#custName").value.trim();
    var custContact = $("#custContact").value.trim();
    var billSection = $("#docBillToSection");
    if (custName || custContact) {
      billSection.hidden = false;
      $("#docCustName").textContent = custName;
      $("#docCustContact").textContent = custContact;
    } else {
      billSection.hidden = true;
    }

    // ---- items table ----
    var body = $("#docItems");
    body.innerHTML = "";
    var filled = rows.filter(function (r) { return r.desc || r.qty || r.price; });
    if (filled.length === 0) {
      var er = el("tr", "doc-table__empty");
      var td = el("td");
      td.colSpan = 4;
      td.textContent = "Add an item to see it here.";
      er.appendChild(td);
      body.appendChild(er);
    } else {
      filled.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(el("td", "doc-table__desc", r.desc || "—"));
        tr.appendChild(el("td", "dt-num", (r.qty % 1 === 0 ? String(r.qty) : String(round2(r.qty)))));
        tr.appendChild(el("td", "dt-num", money(r.price, cur)));
        tr.appendChild(el("td", "dt-num", money(r.qty * r.price, cur)));
        body.appendChild(tr);
      });
    }

    // ---- totals ----
    var c = compute(rows);
    $("#docSubtotal").textContent = money(c.subtotal, cur);

    var discRow = $("#docDiscRow");
    if (c.discount > 0) {
      discRow.hidden = false;
      var dlabel = (c.dType === "percent")
        ? "Discount (" + trimNum(Math.min(c.dVal, 100)) + "%)"
        : "Discount";
      $("#docDiscLabel").textContent = dlabel;
      $("#docDiscount").textContent = "−" + money(c.discount, cur);
    } else {
      discRow.hidden = true;
    }

    var taxRow = $("#docTaxRow");
    if (c.taxRate > 0) {
      taxRow.hidden = false;
      var tlabel = ($("#taxLabel").value.trim() || "Tax");
      $("#docTaxName").textContent = tlabel + " (" + trimNum(c.taxRate) + "%)";
      $("#docTax").textContent = money(c.tax, cur);
    } else {
      taxRow.hidden = true;
    }

    $("#docTotal").textContent = money(c.total, cur);

    // ---- notes ----
    var notes = $("#notes").value.trim();
    var notesWrap = $("#docNotesWrap");
    if (notes) { notesWrap.hidden = false; $("#docNotes").textContent = notes; }
    else { notesWrap.hidden = true; }

    // ---- paid stamp ----
    $("#paidStamp").hidden = !$("#paidToggle").checked;

    // ---- thanks line (only if no explicit notes, keep the doc warm) ----
    var thanks = $("#docThanks");
    thanks.hidden = true;
  }

  function trimNum(n) {
    // show 12 not 12.00, but keep 12.5
    return (Math.round(n * 100) / 100).toString();
  }

  /* ============================================================
     LOGO (local file -> data URL, never uploaded)
     ============================================================ */
  var logoDataUrl = "";

  function setLogo(dataUrl) {
    logoDataUrl = dataUrl || "";
    var prev = $("#logoPreview");
    var docLogo = $("#docLogo");
    var clearBtn = $("#logoClear");
    if (logoDataUrl) {
      prev.innerHTML = "";
      var img = el("img");
      img.src = logoDataUrl;
      img.alt = "";
      prev.appendChild(img);
      docLogo.src = logoDataUrl;
      docLogo.hidden = false;
      clearBtn.hidden = false;
    } else {
      prev.innerHTML = "";
      prev.appendChild(el("span", "logo-preview__hint", "No logo"));
      docLogo.removeAttribute("src");
      docLogo.hidden = true;
      clearBtn.hidden = true;
    }
  }

  function handleLogoFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      setLogo(e.target.result);
      saveProfile();
    };
    reader.readAsDataURL(file);
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function readProfile() {
    return {
      bizName: $("#bizName").value,
      bizPhone: $("#bizPhone").value,
      bizEmail: $("#bizEmail").value,
      bizAddress: $("#bizAddress").value,
      logo: logoDataUrl,
      currency: $("#currency").value,
      taxLabel: $("#taxLabel").value,
      taxRate: $("#taxRate").value
    };
  }

  function saveProfile() {
    if (!storageOk) return;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(readProfile())); }
    catch (e) { storageOk = false; }
  }

  function loadProfile() {
    if (!storageOk) return;
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return;
      var p = JSON.parse(raw) || {};
      if (p.bizName != null) $("#bizName").value = p.bizName;
      if (p.bizPhone != null) $("#bizPhone").value = p.bizPhone;
      if (p.bizEmail != null) $("#bizEmail").value = p.bizEmail;
      if (p.bizAddress != null) $("#bizAddress").value = p.bizAddress;
      if (p.currency && CURRENCIES[p.currency]) $("#currency").value = p.currency;
      if (p.taxLabel != null) $("#taxLabel").value = p.taxLabel;
      if (p.taxRate != null) $("#taxRate").value = p.taxRate;
      if (p.logo) setLogo(p.logo);
    } catch (e) { /* ignore corrupt profile */ }
  }

  function readDraft() {
    return {
      custName: $("#custName").value,
      custContact: $("#custContact").value,
      invNo: $("#invNo").value,
      invDate: $("#invDate").value,
      dueDate: $("#dueDate").value,
      currency: $("#currency").value,
      paid: $("#paidToggle").checked,
      taxLabel: $("#taxLabel").value,
      taxRate: $("#taxRate").value,
      discountValue: $("#discountValue").value,
      discountType: ($("input[name=discountType]:checked") || {}).value || "percent",
      notes: $("#notes").value,
      items: readRows().map(function (r) { return { desc: r.desc, qty: $(".r-qty", r.node).value, price: $(".r-price", r.node).value }; })
    };
  }

  function saveDraft() {
    if (!storageOk) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(readDraft())); }
    catch (e) { storageOk = false; }
  }

  function loadDraft() {
    if (!storageOk) return false;
    var raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      var d = JSON.parse(raw) || {};
      if (d.custName != null) $("#custName").value = d.custName;
      if (d.custContact != null) $("#custContact").value = d.custContact;
      if (d.invNo != null) $("#invNo").value = d.invNo;
      if (d.invDate != null) $("#invDate").value = d.invDate;
      if (d.dueDate != null) $("#dueDate").value = d.dueDate;
      if (d.currency && CURRENCIES[d.currency]) $("#currency").value = d.currency;
      if (d.paid) $("#paidToggle").checked = true;
      if (d.taxLabel != null) $("#taxLabel").value = d.taxLabel;
      if (d.taxRate != null) $("#taxRate").value = d.taxRate;
      if (d.discountValue != null) $("#discountValue").value = d.discountValue;
      if (d.discountType) {
        var dt = $("input[name=discountType][value=" + (d.discountType === "fixed" ? "fixed" : "percent") + "]");
        if (dt) dt.checked = true;
      }
      if (d.notes != null) $("#notes").value = d.notes;

      $("#itemRows").innerHTML = "";
      if (d.items && d.items.length) {
        d.items.forEach(function (it) { addRow(it, true); });
      }
      ensureOneRow();
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     INVOICE NUMBERING
     ============================================================ */
  function pad4(n) { var s = String(n); while (s.length < 4) s = "0" + s; return s; }

  function getSeq() {
    if (!storageOk) return 1;
    try {
      var v = parseInt(localStorage.getItem(SEQ_KEY), 10);
      return (isNaN(v) || v < 1) ? 1 : v;
    } catch (e) { return 1; }
  }
  function setSeq(n) {
    if (!storageOk) return;
    try { localStorage.setItem(SEQ_KEY, String(n)); } catch (e) { storageOk = false; }
  }
  function suggestInvNo() { return "INV-" + pad4(getSeq()); }

  // Pull the numeric tail out of an invoice number like "INV-0007" -> 7
  function seqFromInvNo(str) {
    var m = String(str || "").match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function todayISO() {
    var d = new Date();
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    if (mm.length < 2) mm = "0" + mm;
    if (dd.length < 2) dd = "0" + dd;
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  /* ============================================================
     NEW / RESET
     ============================================================ */
  function newInvoice() {
    // advance the sequence: if the current invoice number has a numeric tail,
    // next = that + 1; otherwise just bump the stored sequence.
    var cur = seqFromInvNo($("#invNo").value);
    var next = (cur != null) ? cur + 1 : getSeq() + 1;
    setSeq(next);

    // clear customer + items + per-invoice fields, keep business profile
    $("#custName").value = "";
    $("#custContact").value = "";
    $("#dueDate").value = "";
    $("#notes").value = "";
    $("#discountValue").value = "0";
    var pct = $("input[name=discountType][value=percent]");
    if (pct) pct.checked = true;
    $("#paidToggle").checked = false;

    $("#invNo").value = suggestInvNo();
    $("#invDate").value = todayISO();

    $("#itemRows").innerHTML = "";
    addRow(null, true);
    ensureOneRow();

    render();
    saveDraft();
    scrollToMake();
  }

  function resetAll() {
    if (!window.confirm("Reset everything, including your saved business details? This clears slipbook's data on this device.")) return;
    if (storageOk) {
      try {
        localStorage.removeItem(PROFILE_KEY);
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(SEQ_KEY);
      } catch (e) { /* ignore */ }
    }
    // hard clear the form
    ["bizName","bizPhone","bizEmail","bizAddress","custName","custContact","dueDate","notes"].forEach(function (id) { $("#" + id).value = ""; });
    $("#currency").value = "PHP";
    $("#taxLabel").value = "VAT";
    $("#taxRate").value = "0";
    $("#discountValue").value = "0";
    var pct = $("input[name=discountType][value=percent]");
    if (pct) pct.checked = true;
    $("#paidToggle").checked = false;
    setLogo("");
    setSeq(1);
    $("#invNo").value = suggestInvNo();
    $("#invDate").value = todayISO();
    $("#itemRows").innerHTML = "";
    addRow({ desc: "", qty: "1", price: "" }, true);
    render();
    saveDraft();
    scrollToMake();
  }

  function scrollToMake() {
    var t = $("#make");
    if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    // storage feature test
    try { localStorage.setItem("slipbook:test", "1"); localStorage.removeItem("slipbook:test"); }
    catch (e) { storageOk = false; }

    // load persisted business profile first (may set currency/tax/logo)
    loadProfile();

    // then restore the in-progress invoice if there is one
    var hadDraft = loadDraft();
    if (!hadDraft) {
      // fresh start: seed number, date, one row
      $("#invNo").value = suggestInvNo();
      $("#invDate").value = todayISO();
      addRow({ desc: "", qty: "1", price: "" }, true);
    } else {
      if (!$("#invNo").value.trim()) $("#invNo").value = suggestInvNo();
      if (!$("#invDate").value) $("#invDate").value = todayISO();
    }
    ensureOneRow();

    // ---- editor inputs: any change re-renders + persists ----
    // business/tax/currency fields -> profile; everything -> draft + render.
    var profileFields = ["bizName","bizPhone","bizEmail","bizAddress","currency","taxLabel","taxRate"];
    $$("#editor input, #editor select, #editor textarea").forEach(function (inp) {
      // per-row inputs and the file picker are wired elsewhere
      if (inp.classList.contains("r-desc") || inp.classList.contains("r-qty") || inp.classList.contains("r-price")) return;
      if (inp.id === "logoInput") return;
      // select / radio / checkbox report via change; text, number, date, textarea via input (fires live)
      var useChange = inp.tagName === "SELECT" || inp.type === "radio" || inp.type === "checkbox";
      inp.addEventListener(useChange ? "change" : "input", function () {
        render();
        saveDraft();
        if (profileFields.indexOf(inp.id) !== -1) saveProfile();
      });
    });

    // add item
    $("#addRow").addEventListener("click", function () {
      var row = addRow();
      var d = $(".r-desc", row);
      if (d) d.focus();
    });

    // logo
    $("#logoInput").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      handleLogoFile(f);
      e.target.value = ""; // allow re-picking same file
    });
    $("#logoClear").addEventListener("click", function () { setLogo(""); saveProfile(); render(); });

    // actions
    $("#printBtn").addEventListener("click", function () { window.print(); });
    $("#newBtn").addEventListener("click", newInvoice);
    $("#resetBtn").addEventListener("click", resetAll);

    // guard against form submit reload
    $("#editor").addEventListener("submit", function (e) { e.preventDefault(); });

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
