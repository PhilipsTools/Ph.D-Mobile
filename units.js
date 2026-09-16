/* Clinical units - the PIC iX tab on a standalone PIC iX site.
 *
 * A standalone hospital runs PIC iX per clinical unit rather than centrally,
 * so the healthcheck is done unit by unit. On such a site the closet list gets
 * a second tab: PIC iX. Each clinical unit added there carries the whole Ph.D
 * questionnaire (every section except the 4.1 closet questions, which stay on
 * the Network Closets tab) - Yes/No answers with photos, the detail blocks
 * (DNS, NTP, PIC iX interfaces, APC table...), notes and unit photos.
 *
 * Everything is stored like the closets: answers in localStorage under
 * hospital|year, photos as blobs in IndexedDB. The export carries every unit;
 * the desktop merges them into the one report.
 *
 * Detail-block values are keyed exactly as the desktop keys them - the field
 * label, or "label#n" for a numbered entry - so the importer can hand them to
 * the desktop form without translating anything.
 */
"use strict";

var U = {sections: {}, questions: []};     // the unit questionnaire in play

function isStandalone(h) {
  return ((S.types || {})[h || S.gate.hospital] || "") === "standalone";
}
function units() {
  if (!S.unitsByKey[key()]) S.unitsByKey[key()] = [];
  return S.unitsByKey[key()];
}
function newUnit(name) {
  return {name: name, answers: {}, photos: {}, products: {}, followups: {},
          data: {}, dataPhotos: {}, notes: "", notePhotos: []};
}
function unitAlerts() { return U.questions.filter(function (q) { return q.kind !== "data"; }); }
function unitBlocks() { return U.questions.filter(function (q) { return q.kind === "data"; }); }

/* --------------------------------------------------------- question set */
function normaliseUnits(d) {
  if (!d || !Array.isArray(d.questions)) return null;
  var qs = d.questions.filter(function (q) {
    return q && q.id && (q.kind === "data" ? (q.fields || []).length : (q.options || []).length);
  });
  return qs.length ? {sections: d.sections || {}, questions: qs} : null;
}
function loadUnits() {
  // same order of preference as the closet questions: fresh, cached, baked in
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(LS + ".units") || "null"); } catch (e) {}
  return fetch("unit_questions.json", {cache: "no-store"})
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (fresh) {
      var got = normaliseUnits(fresh);
      if (got) {
        try { localStorage.setItem(LS + ".units", JSON.stringify(got)); } catch (e) {}
        U = got;
      } else {
        U = normaliseUnits(cached) || normaliseUnits(window.__UNITS) || {sections: {}, questions: []};
      }
      return U;
    });
}

/* ------------------------------------------------------- detail blocks */
function blockData(u, q) {
  u.data = u.data || {};
  if (!u.data[q.id]) u.data[q.id] = {values: {}, extras: {}};
  var d = u.data[q.id];
  d.values = d.values || {}; d.extras = d.extras || {};
  return d;
}
function blockCount(q, d) {
  var c = q.counter;
  if (!c) return q.repeat > 1 ? q.repeat : 1;
  var lo = Number(c.min == null ? 0 : c.min), hi = Number(c.max || 1);
  var n = (d && d.count != null && d.count !== "") ? Number(d.count) : Number(c["default"] == null ? 1 : c["default"]);
  return Math.max(lo, Math.min(hi, isNaN(n) ? lo : n));
}
/* The entries a block shows and the key each field is filed under - the same
   rule the desktop form uses: a repeated or repeat-counted block numbers its
   keys "label#n"; a group-counted block shows the first N of the fields that
   share the counter's prefix, keyed by their plain label. */
function blockEntries(q, d) {
  var c = q.counter || null;
  var numbered = (q.repeat || 1) > 1 || (c && c.mode === "repeat");
  var fields = q.fields || [];
  if (numbered) {
    var n = blockCount(q, d), out = [];
    for (var i = 1; i <= n; i++) {
      var lab = q.repeat_label || "";
      out.push({title: lab.indexOf("%d") >= 0 ? lab.replace("%d", i) : ((lab || "Entry") + " " + i),
                fields: fields.map(function (f) { return {f: f, key: f.label + "#" + i}; })});
    }
    return out;
  }
  var shown = fields;
  if (c && c.prefix) {
    var limit = blockCount(q, d), seen = 0;
    shown = fields.filter(function (f) {
      if (String(f.label).indexOf(c.prefix) !== 0) return true;
      seen++;
      return seen <= limit;
    });
  }
  return [{title: "", fields: shown.map(function (f) { return {f: f, key: f.label}; })}];
}
function fieldFails(f, v) {
  var val = String(v || "").trim().toLowerCase();
  if (!val) return false;
  return (f.fail_when || []).some(function (x) { return String(x).trim().toLowerCase() === val; });
}
function blockTouched(u, q) {
  var d = (u.data || {})[q.id];
  if (!d) return false;
  return Object.keys(d.values || {}).some(function (k) { return String(d.values[k] || "").trim(); }) ||
         Object.keys(d.extras || {}).some(function (k) { return String(d.extras[k] || "").trim(); });
}

/* ------------------------------------------------------------ progress */
function unitCounts(u) {
  var done = 0, fail = 0, shots = 0, total = 0;
  unitAlerts().forEach(function (q) {
    total++;
    var a = (u.answers || {})[q.id];
    if (a) { done++; if (resultOf(q, a) === "Fail") fail++; }
    shots += ((u.photos || {})[q.id] || []).length;
  });
  unitBlocks().forEach(function (q) {
    total++;
    if (blockTouched(u, q)) done++;
    var d = (u.data || {})[q.id];
    if (d) blockEntries(q, d).forEach(function (e) {
      e.fields.forEach(function (x) { if (fieldFails(x.f, d.values[x.key])) fail++; });
    });
    shots += ((u.dataPhotos || {})[q.id] || []).length;
  });
  shots += (u.notePhotos || []).length;
  return {done: done, fail: fail, shots: shots, total: total};
}
function unitSignature(k) {
  var us = S.unitsByKey[k || key()] || [];
  var n = 0, shots = 0;
  us.forEach(function (u) {
    var c = unitCounts(u);
    n += c.done; shots += c.shots;
    Object.keys(u.data || {}).forEach(function (id) {
      var d = u.data[id];
      n += Object.keys(d.values || {}).length + Object.keys(d.extras || {}).length;
    });
  });
  return us.length + ":" + n + ":" + shots;
}

/* ------------------------------------------------------------- the tabs */
function tabBar() {
  var bar = el("div", "tabs");
  [["closets", "Network closets"], ["units", "PIC iX"]].forEach(function (t) {
    var b = el("button", "tab" + (S.tab === t[0] ? " on" : ""), t[1]);
    b.onclick = function () { S.tab = t[0]; save(); drawList(); };
    bar.appendChild(b);
  });
  return bar;
}

/* ---- the clinical unit list ---- */
function drawUnitList(host) {
  var us = units();
  if (!U.questions.length) {
    host.appendChild(el("div", "note",
      "No PIC iX questions on this phone yet - open the app once with signal to fetch them."));
  }
  us.forEach(function (u, i) {
    var n = unitCounts(u), card = el("div", "card closet unit");
    card.onclick = function () { S.unit = i; show("uq"); };
    var r1 = el("div", "r1");
    r1.appendChild(el("div", "cname", u.name));
    // no status pill here - a unit name is usually long ("4 North ICU") and
    // the bar underneath already says how far along it is
    if (n.done && n.done >= n.total) r1.appendChild(el("div", "pill done", "Complete"));
    var ren = el("button", "sq", "");
    ren.style.width = "34px"; ren.style.height = "34px";
    ren.innerHTML = pencilIcon();
    ren.onclick = function (e) { e.stopPropagation(); unitRenameSheet(i); };
    r1.appendChild(ren);
    var del = el("button", "sq", "");
    del.style.width = "34px"; del.style.height = "34px";
    del.innerHTML = trashIcon();
    del.onclick = function (e) { e.stopPropagation(); unitDeleteSheet(i); };
    r1.appendChild(del);
    card.appendChild(r1);

    var r2 = el("div", "r2"), bar = el("div", "segs");
    var fill = el("div", "seg p");
    fill.style.flex = String(Math.max(0.0001, n.done));
    var rest = el("div", "seg");
    rest.style.flex = String(Math.max(0.0001, n.total - n.done));
    bar.appendChild(fill); bar.appendChild(rest);
    r2.appendChild(bar);
    r2.appendChild(el("div", "n", n.done + "/" + n.total));
    card.appendChild(r2);
    var bits = n.shots + " photo" + (n.shots === 1 ? "" : "s");
    if (n.fail) bits += " · " + n.fail + " fail" + (n.fail === 1 ? "" : "s");
    card.appendChild(el("div", "r3", bits));
    host.appendChild(card);
  });

  var add = el("button", "btn primary", "+ Add clinical unit");
  add.style.minHeight = "54px";
  add.onclick = unitNameSheet;
  host.appendChild(add);

  var ex = el("button", "btn secondary", "Export for report builder");
  ex.onclick = function () { show("exp"); };
  host.appendChild(ex);
}

function unitNameSheet() {
  sheet(function (box, close) {
    box.appendChild(el("div", "kicker", "New clinical unit"));
    box.appendChild(el("h2", null, "Name this unit"));
    var inp = document.createElement("input");
    inp.className = "inp txt"; inp.placeholder = "e.g. 4 North · ICU";
    box.appendChild(inp);
    var row = el("div"); row.style.display = "flex"; row.style.gap = "10px";
    var cancel = el("button", "btn secondary", "Cancel"); cancel.style.flex = "1";
    var go = el("button", "btn primary", "Start questions"); go.style.flex = "2";
    firstTap(cancel, close);
    firstTap(go, function () {
      var n = (inp.value || "").trim() || ("Clinical unit " + (units().length + 1));
      units().push(newUnit(n));
      S.unit = units().length - 1;
      save(); close(); show("uq");
    });
    row.appendChild(cancel); row.appendChild(go);
    box.appendChild(row);
    setTimeout(function () { inp.focus(); }, 60);
  });
}
function unitRenameSheet(i) {
  var u = units()[i];
  if (!u) return;
  sheet(function (box, close) {
    box.appendChild(el("div", "kicker", "Rename clinical unit"));
    box.appendChild(el("h2", null, u.name));
    var inp = document.createElement("input");
    inp.className = "inp txt"; inp.value = u.name || "";
    box.appendChild(inp);
    var row = el("div"); row.style.display = "flex"; row.style.gap = "10px";
    var cancel = el("button", "btn secondary", "Cancel"); cancel.style.flex = "1";
    var go = el("button", "btn primary", "Save name"); go.style.flex = "2";
    firstTap(cancel, close);
    firstTap(go, function () {
      var n = (inp.value || "").trim();
      if (n) u.name = n;                   // blank means leave it alone
      save(); close();
      if (S.screen === "uq") drawUnitQuestions(); else drawList();
    });
    row.appendChild(cancel); row.appendChild(go);
    box.appendChild(row);
    setTimeout(function () { inp.focus(); inp.select(); }, 60);
  });
}
function unitDeleteSheet(i) {
  var u = units()[i];
  sheet(function (box, close) {
    var k = el("div", "kicker", "Delete clinical unit"); k.style.color = "var(--fail-t)";
    box.appendChild(k);
    box.appendChild(el("h2", null, u.name));
    box.appendChild(el("div", "note", "Its answers, details, notes and photos go with it. This can't be undone."));
    var row = el("div"); row.style.display = "flex"; row.style.gap = "10px";
    var keep = el("button", "btn secondary", "Keep"); keep.style.flex = "1";
    var del = el("button", "btn danger", "Delete"); del.style.flex = "2";
    firstTap(keep, close);
    firstTap(del, function () {
      [u.photos, u.dataPhotos].forEach(function (m) {
        Object.keys(m || {}).forEach(function (id) { (m[id] || []).forEach(delPhoto); });
      });
      (u.notePhotos || []).forEach(delPhoto);
      units().splice(i, 1); save(); close(); drawList();
    });
    row.appendChild(keep); row.appendChild(del);
    box.appendChild(row);
  });
}

/* ---- one clinical unit's questionnaire ---- */
var openSections = {};                   // which sections are expanded

function drawUnitQuestions() {
  var u = units()[S.unit];
  if (!u) return show("list");
  var y = window.scrollY;                // a tap redraws; do not jump the page
  var nameEl = $("uqname");
  nameEl.textContent = u.name;
  nameEl.onclick = function () { unitRenameSheet(S.unit); };
  var host = $("uqlist"); host.innerHTML = "";

  // report order, grouped by section
  var groups = [], bySec = {};
  U.questions.forEach(function (q) {
    var s = String(q.section || "");
    if (!bySec[s]) { bySec[s] = []; groups.push(s); }
    bySec[s].push(q);
  });
  if (!Object.keys(openSections).length && groups.length) openSections[groups[0]] = true;

  groups.forEach(function (sec) {
    var qs = bySec[sec];
    var done = qs.filter(function (q) {
      return q.kind === "data" ? blockTouched(u, q) : !!(u.answers || {})[q.id];
    }).length;
    var box = el("div", "sec" + (openSections[sec] ? " open" : ""));
    var head = el("button", "sech");
    head.appendChild(el("span", "secn", sec));
    head.appendChild(el("span", "sect", U.sections[sec] || ""));
    head.appendChild(el("span", "secc", done + "/" + qs.length));
    head.onclick = function () { openSections[sec] = !openSections[sec]; drawUnitQuestions(); };
    box.appendChild(head);
    if (openSections[sec]) {
      var body = el("div", "secb");
      qs.forEach(function (q) {
        body.appendChild(q.kind === "data" ? blockCard(u, q) : alertCard(u, q));
      });
      box.appendChild(body);
    }
    host.appendChild(box);
  });

  var nk = el("div", "kicker", "Unit notes"); nk.style.marginTop = "4px";
  host.appendChild(nk);
  var ta = document.createElement("textarea");
  ta.className = "inp"; ta.placeholder = "anything worth recording about this unit";
  ta.value = u.notes || "";
  ta.oninput = function () { u.notes = ta.value; save(); };
  host.appendChild(ta);
  host.appendChild(el("div", "r3", "Unit photos — for the record, not for an alert"));
  host.appendChild(photoStrip(
    function () { return u.notePhotos || []; },
    function (v) { u.notePhotos = v; }, "__unit"));

  var done = el("button", "btn primary", "Done — back to clinical units");
  done.style.minHeight = "52px";
  done.onclick = function () { show("list"); };
  host.appendChild(done);

  var n = unitCounts(u);
  $("uqcount").textContent = n.done + "/" + n.total + " answered";
  window.scrollTo(0, y);
}

function alertCard(u, q) {
  u.answers = u.answers || {}; u.photos = u.photos || {};
  var card = el("div", "card q");
  card.appendChild(el("div", "qt", q.question));
  var row = el("div", "opts");
  q.options.forEach(function (o) {
    var on = String(u.answers[q.id] || "").toLowerCase() === String(o.label).toLowerCase();
    var cls = "opt" + (q.options.length > 3 ? " four" : "");
    if (on) cls += o.result === "Pass" ? " on-pass" : o.result === "Fail" ? " on-fail" : " on-skip";
    var b = el("button", cls, o.label);
    b.onclick = function () {
      if (on) delete u.answers[q.id];      // tapping the chosen one clears it
      else u.answers[q.id] = o.label;
      save(); drawUnitQuestions();
    };
    row.appendChild(b);
  });
  card.appendChild(row);

  var res = u.answers[q.id] ? resultOf(q, u.answers[q.id]) : "";
  // the end-of-life product list, once there are some to name
  if ((q.products || []).length && res === "Fail") {
    u.products = u.products || {};
    var picked = u.products[q.id] || [];
    var list = el("div", "picks");
    q.products.forEach(function (name) {
      var lab = el("label", "pick");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = picked.indexOf(name) >= 0;
      cb.onchange = function () {
        var cur = (u.products[q.id] || []).filter(function (x) { return x !== name; });
        if (cb.checked) cur.push(name);
        u.products[q.id] = cur; save();
      };
      lab.appendChild(cb); lab.appendChild(el("span", null, name));
      list.appendChild(lab);
    });
    card.appendChild(list);
  }
  // the follow-up question (which anti-virus...), when it applies
  if (q.followup && res && res === q.followup.when) {
    u.followups = u.followups || {};
    var fl = el("div", "fld");
    fl.appendChild(el("div", "fl", q.followup.label));
    var sel = document.createElement("select");
    sel.className = "inp txt";
    [""].concat(q.followup.choices).forEach(function (c) {
      var o = el("option", null, c || "—"); o.value = c;
      if (c === (u.followups[q.id] || "")) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { u.followups[q.id] = sel.value; save(); };
    fl.appendChild(sel);
    card.appendChild(fl);
  }
  card.appendChild(photoStrip(
    function () { return u.photos[q.id] || []; },
    function (v) { u.photos[q.id] = v; }, "u|" + q.id));
  return card;
}

function blockCard(u, q) {
  var d = blockData(u, q);
  var card = el("div", "card q");
  card.appendChild(el("div", "qt", q.question));

  if (q.counter) {
    var c = q.counter, fl = el("div", "fld");
    fl.appendChild(el("div", "fl", c.label || "How many?"));
    var sel = document.createElement("select");
    sel.className = "inp txt";
    for (var i = Number(c.min || 0); i <= Number(c.max || 1); i++) {
      var o = el("option", null, String(i)); o.value = String(i);
      if (i === blockCount(q, d)) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = function () { d.count = Number(sel.value); save(); drawUnitQuestions(); };
    fl.appendChild(sel);
    card.appendChild(fl);
  }

  blockEntries(q, d).forEach(function (entry) {
    var holder = card;
    if (entry.title) {
      holder = el("div", "entry");
      holder.appendChild(el("div", "entt", entry.title));
      card.appendChild(holder);
    }
    entry.fields.forEach(function (x) {
      var f = x.f, k = x.key;
      var fl = el("div", "fld");
      fl.appendChild(el("div", "fl", f.label + (f.required ? " *" : "")));
      if (f.pre) {
        var pre = document.createElement("input");
        pre.className = "inp txt small"; pre.placeholder = f.pre;
        pre.value = d.extras[k] || "";
        pre.setAttribute("inputmode", "decimal");
        pre.oninput = function () { if (pre.value.trim()) d.extras[k] = pre.value; else delete d.extras[k]; save(); };
        fl.appendChild(pre);
      }
      var ctl;
      if (f.type === "choice") {
        ctl = document.createElement("select");
        ctl.className = "inp txt";
        [""].concat(f.choices || []).forEach(function (ch) {
          var o = el("option", null, ch || "—"); o.value = ch;
          if (ch === (d.values[k] || "")) o.selected = true;
          ctl.appendChild(o);
        });
        ctl.onchange = function () {
          if (ctl.value) d.values[k] = ctl.value; else delete d.values[k];
          ctl.classList.toggle("bad", fieldFails(f, ctl.value));
          save();
        };
      } else if (f.type === "notes") {
        ctl = document.createElement("textarea");
        ctl.className = "inp";
        ctl.value = d.values[k] || "";
        ctl.oninput = function () { if (ctl.value.trim()) d.values[k] = ctl.value; else delete d.values[k]; save(); };
      } else {
        ctl = document.createElement("input");
        ctl.className = "inp txt";
        ctl.value = d.values[k] || "";
        ctl.oninput = function () { if (ctl.value.trim()) d.values[k] = ctl.value; else delete d.values[k]; save(); };
      }
      if (fieldFails(f, d.values[k])) ctl.classList.add("bad");
      fl.appendChild(ctl);
      holder.appendChild(fl);
    });
  });

  u.dataPhotos = u.dataPhotos || {};
  card.appendChild(photoStrip(
    function () { return u.dataPhotos[q.id] || []; },
    function (v) { u.dataPhotos[q.id] = v; }, "ud|" + q.id));
  return card;
}

/* ------------------------------------------------------------- export */
function unitRollup() {
  // the same worst-wins the report will use, for the export screen's preview
  var worst = {}, RANK = {Fail: 0, Pass: 1, Skip: 2};
  units().forEach(function (u) {
    unitAlerts().forEach(function (q) {
      var a = (u.answers || {})[q.id];
      if (!a) return;
      var r = resultOf(q, a);
      if (!r) return;
      if (!worst[q.id] || RANK[r] < RANK[worst[q.id].result]) worst[q.id] = {result: r, units: []};
      if (r === "Fail") worst[q.id].units.push(u.name);
    });
  });
  return worst;
}
function unitsPayload() {
  function urls(ids) {
    return Promise.all((ids || []).map(function (pid) {
      return getPhoto(pid).then(blobToDataURL);
    })).then(function (xs) { return xs.filter(Boolean); });
  }
  function urlMap(m) {
    var out = {};
    return Promise.all(Object.keys(m || {}).map(function (id) {
      return urls(m[id]).then(function (xs) { if (xs.length) out[id] = xs; });
    })).then(function () { return out; });
  }
  return Promise.all(units().map(function (u) {
    return Promise.all([urlMap(u.photos), urlMap(u.dataPhotos), urls(u.notePhotos)])
      .then(function (r) {
        var data = {};
        unitBlocks().forEach(function (q) {
          var d = (u.data || {})[q.id];
          if (!d) return;
          var entry = {values: d.values || {}, extras: d.extras || {}};
          if (q.counter) entry.count = blockCount(q, d);
          data[q.id] = entry;
        });
        return {name: u.name, answers: u.answers || {}, photosByQuestion: r[0],
                products: u.products || {}, followups: u.followups || {},
                data: data, dataPhotos: r[1], notes: u.notes || "", notePhotos: r[2]};
      });
  }));
}
