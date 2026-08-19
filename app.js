/* Closet Walkaround - the on-site phone app.
 *
 * Everything is kept on the device: answers and notes in localStorage, photos
 * as blobs in IndexedDB. Nothing is sent anywhere. The one network moment is
 * install, and refreshing the question set from the PC when it happens to be
 * serving on the same wifi.
 */
"use strict";

/* ------------------------------------------------------------------ state */
var LS = "walkaround.v2";
var S = {
  // `hospitals` is what the dropdown shows. `mine` is only the sites added on
  // this phone - they are kept apart so the published list can be authoritative:
  // a site removed or renamed in the tool has to actually disappear here, which
  // it cannot do if everything the phone has ever seen is merged back in.
  hospitals: [], mine: [],
  gate: {hospital: "", year: String(new Date().getFullYear())},
  // `exported` remembers what a walkaround looked like when it was last sent
  // out, keyed the same way the closets are. Comparing that against how it
  // looks now is what tells the gate whether there is still work to do.
  closetsByKey: {}, exported: {},
  folder: "", screen: "gate", closet: -1, questions: []
};
var Q = [];                       // the question set in play
// the list always reaches the year we are actually in, however far off that
// turns out to be, and still reaches back over the years already on file
function thisYear() { return new Date().getFullYear(); }
var YEAR_MIN = Math.min(2026, thisYear()), YEAR_MAX = Math.max(2046, thisYear() + 5);

function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      hospitals: S.hospitals, mine: S.mine, gate: S.gate,
      closetsByKey: S.closetsByKey, exported: S.exported,
      folder: S.folder
    }));
  } catch (e) { /* full or private mode - the screen still works */ }
}
function load() {
  try {
    var raw = localStorage.getItem(LS);
    if (!raw) return;
    var d = JSON.parse(raw);
    S.hospitals = d.hospitals || [];
    S.mine = d.mine || [];
    S.closetsByKey = d.closetsByKey || {};
    S.exported = d.exported || {};
    S.folder = d.folder || "";
    // The gate deliberately does NOT come back. Every launch opens with no
    // hospital picked and the year taken off the calendar, so nobody walks a
    // closet into last year's file, or into the hospital they were at
    // yesterday. Nothing is lost: closets are filed under hospital|year, so
    // choosing the same pair again brings the same list straight back.
    S.gate = {hospital: "", year: String(thisYear())};
  } catch (e) {}
}
function key() { return S.gate.hospital + "|" + S.gate.year; }

/* What the current walkaround looks like: how many closets, how many answers,
   how many photos. Stored when it is exported and compared on the gate, so
   the button can tell "finished and sent" from "sent, then carried on". */
function walkSignature(k) {
  var cs = S.closetsByKey[k || key()] || [];
  var answers = 0, shots = 0;
  cs.forEach(function (c) {
    answers += Object.keys(c.answers || {}).length;
    Object.keys(c.photos || {}).forEach(function (q) {
      shots += (c.photos[q] || []).length;
    });
  });
  return cs.length + ":" + answers + ":" + shots;
}
function markExported() {
  S.exported[key()] = walkSignature();
  save();
  if (S.screen === "gate") drawGate();
}
function closets() {
  if (!S.closetsByKey[key()]) S.closetsByKey[key()] = [];
  return S.closetsByKey[key()];
}

/* --------------------------------------------------------------- photos */
var DB = null;
function db() {
  return new Promise(function (res, rej) {
    if (DB) return res(DB);
    var r = indexedDB.open("walkaround-photos", 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("p"); };
    r.onsuccess = function () { DB = r.result; res(DB); };
    r.onerror = function () { rej(r.error); };
  });
}
function putPhoto(id, blob) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var t = d.transaction("p", "readwrite");
      t.objectStore("p").put(blob, id);
      t.oncomplete = function () { res(id); };
      t.onerror = function () { rej(t.error); };
    });
  });
}
function getPhoto(id) {
  return db().then(function (d) {
    return new Promise(function (res) {
      var t = d.transaction("p", "readonly").objectStore("p").get(id);
      t.onsuccess = function () { res(t.result || null); };
      t.onerror = function () { res(null); };
    });
  });
}
function delPhoto(id) {
  return db().then(function (d) {
    var t = d.transaction("p", "readwrite");
    t.objectStore("p").delete(id);
  }).catch(function () {});
}

/* A walkaround can run to fifty photos, so each one is scaled down on the way
   in rather than stored at whatever the camera produced. */
function shrink(file) {
  return new Promise(function (res) {
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var long = Math.max(img.width, img.height), scale = long > 1600 ? 1600 / long : 1;
      var c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function (b) { res(b || file); }, "image/jpeg", 0.7);
    };
    img.onerror = function () { URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}
function blobToDataURL(b) {
  return new Promise(function (res) {
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { res(null); };
    fr.readAsDataURL(b);
  });
}

/* -------------------------------------------------------------- helpers */
function $(id) { return document.getElementById(id); }
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function resultOf(q, label) {
  for (var i = 0; i < (q.options || []).length; i++) {
    if (String(q.options[i].label).toLowerCase() === String(label).toLowerCase())
      return q.options[i].result || "Skip";
  }
  return "";
}
function counts(c) {
  var done = 0, fail = 0, shots = 0;
  Q.forEach(function (q) {
    var a = (c.answers || {})[q.id];
    if (a) { done++; if (resultOf(q, a) === "Fail") fail++; }
    shots += ((c.photos || {})[q.id] || []).length;
  });
  return {done: done, fail: fail, shots: shots, total: Q.length};
}
function statusOf(c) {
  var n = counts(c).done;
  return n === 0 ? "Not started" : (n >= Q.length ? "Complete" : "In progress");
}

/* ---------------------------------------------------------- question set */
function normalise(data) {
  var list = Array.isArray(data) ? data : (data && data.questions) || [];
  return list.filter(function (q) {
    return q && q.id && (q.options || []).length;
  }).map(function (q) {
    return {
      id: q.id, question: q.question || q.name || q.id,
      alert: q.alert || "", severity: q.severity || "",
      options: (q.options || []).map(function (o) {
        return {label: o.label, result: o.result};
      })
    };
  });
}
function loadQuestions() {
  // freshest first: what the tool last published, then what was cached from a
  // previous fetch, then the copy baked into data.js - which is all there is
  // when the app is opened straight off the disk, since fetch() cannot read
  // file:// URLs
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(LS + ".questions") || "null"); } catch (e) {}
  return fetch("questions.json", {cache: "no-store"})
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (fresh) {
      var got = normalise(fresh);
      if (got.length) {
        try { localStorage.setItem(LS + ".questions", JSON.stringify(got)); } catch (e) {}
        return got;
      }
      return normalise(cached).length ? normalise(cached)
                                      : normalise(window.__QUESTIONS);
    });
}
function loadHospitals() {
  return fetch("hospitals.json", {cache: "no-store"})
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (list) {
      var offline = !list;                     // no signal - keep what we have
      if (offline) list = window.__HOSPITALS || null;
      var names = [];
      (list || []).forEach(function (h) {
        var n = typeof h === "string" ? h : (h && h.name);
        if (n && names.indexOf(n) < 0) names.push(n);
      });
      // The tool's list wins outright, so removing or renaming a site there
      // actually takes effect here. Only the sites added on this phone are
      // carried over - and only if the tool has not since published them.
      if (!names.length && offline) return;    // nothing fetched, nothing baked
      S.mine.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
      S.hospitals = names.sort(function (a, b) { return a.localeCompare(b); });
      // a hospital no longer on file cannot stay selected
      if (S.gate.hospital && S.hospitals.indexOf(S.gate.hospital) < 0) {
        S.gate.hospital = "";
      }
      save();
    });
}

/* ------------------------------------------------------------ the screens */
function show(name) {
  S.screen = name;
  ["gate", "list", "qs", "exp"].forEach(function (n) {
    $(n).classList.toggle("hide", n !== name);
  });
  window.scrollTo(0, 0);
  if (name === "gate") drawGate();
  if (name === "list") drawList();
  if (name === "qs") drawQuestions();
  if (name === "exp") drawExport();
}

/* ---- launch gate ---- */
function drawGate() {
  var sel = $("hosp");
  sel.innerHTML = "";
  var first = el("option", null, "Select hospital…"); first.value = "";
  sel.appendChild(first);
  S.hospitals.forEach(function (n) {
    var o = el("option", null, n); o.value = n;
    if (n === S.gate.hospital) o.selected = true;
    sel.appendChild(o);
  });
  $("yearlab").textContent = S.gate.year;
  var h = S.gate.hospital;
  if (h) {
    var n = (S.closetsByKey[h + "|" + S.gate.year] || []).length;
    $("hospmeta").textContent = S.gate.year + " · " + n + " closet" +
      (n === 1 ? "" : "s") + " saved";
  } else {
    $("hospmeta").textContent = S.hospitals.length + " hospital" +
      (S.hospitals.length === 1 ? "" : "s") + " saved on this phone";
  }
  $("start").disabled = !h;

  // The button says what pressing it will actually do. "Completed" means the
  // walkaround was exported and has not been touched since - export, then add
  // a closet, and it goes back to saying Continue, because it has.
  var cs = h ? (S.closetsByKey[key()] || []) : [];
  var sent = h && cs.length > 0 && S.exported[key()] === walkSignature();
  $("start").textContent = !cs.length ? "Start walkaround"
                         : sent       ? "View completed walkaround"
                                      : "Continue walkaround";

  var many = cs.length === 1 ? " closet" : " closets";
  $("resume").textContent =
      !h          ? "Pick a hospital to continue"
    : !cs.length  ? ("Nothing recorded yet for " + S.gate.year)
    : sent        ? (cs.length + many + " · exported")
                  : (cs.length + many + " · not exported yet");
}
function openYears() {
  var dd = $("yeardd");
  if (dd.classList.contains("open")) return closeYears();
  dd.classList.add("open");
  var scrim = el("div", "scrim-tap");
  scrim.onclick = closeYears;
  document.body.appendChild(scrim);
  var menu = el("div", "dd-menu");
  for (var y = YEAR_MIN; y <= YEAR_MAX; y++) {
    (function (y) {
      var b = el("button", String(y) === S.gate.year ? "on" : null, String(y));
      b.onclick = function () { S.gate.year = String(y); save(); closeYears(); drawGate(); };
      menu.appendChild(b);
    })(y);
  }
  dd.appendChild(menu);
  var on = menu.querySelector(".on");
  if (on) menu.scrollTop = Math.max(0, on.offsetTop - 90);
}
function closeYears() {
  var dd = $("yeardd");
  dd.classList.remove("open");
  var m = dd.querySelector(".dd-menu"); if (m) m.remove();
  var s = document.querySelector(".scrim-tap"); if (s) s.remove();
}

/* ---- closet list ---- */
function drawList() {
  $("lhosp").textContent = S.gate.hospital;
  $("ybadge").textContent = S.gate.year;
  var host = $("closets"); host.innerHTML = "";
  var cs = closets();

  cs.forEach(function (c, i) {
    var n = counts(c), card = el("div", "card closet");
    card.onclick = function () { S.closet = i; show("qs"); };

    var r1 = el("div", "r1");
    r1.appendChild(el("div", "cname", c.name));
    var st = statusOf(c);
    r1.appendChild(el("div", "pill " + (st === "Complete" ? "done" : "other"), st));
    var del = el("button", "sq", "");
    del.style.width = "34px"; del.style.height = "34px";
    del.innerHTML = trashIcon();
    del.onclick = function (e) { e.stopPropagation(); confirmDelete(i); };
    r1.appendChild(del);
    card.appendChild(r1);

    var r2 = el("div", "r2"), segs = el("div", "segs");
    Q.forEach(function (q) {
      var a = (c.answers || {})[q.id], r = a ? resultOf(q, a) : "";
      segs.appendChild(el("div", "seg" + (r === "Pass" ? " p" : r === "Fail" ? " f"
                                        : r === "Skip" ? " s" : "")));
    });
    r2.appendChild(segs);
    r2.appendChild(el("div", "n", n.done + "/" + n.total));
    card.appendChild(r2);

    var bits = n.shots + " photo" + (n.shots === 1 ? "" : "s");
    if (n.fail) bits += " · " + n.fail + " fail" + (n.fail === 1 ? "" : "s");
    card.appendChild(el("div", "r3", bits));
    host.appendChild(card);
  });

  var add = el("button", "btn primary", "+ Add closet");
  add.style.minHeight = "54px";
  add.onclick = function () { nameSheet(); };
  host.appendChild(add);

  // nothing this year but something last year - offer the names across
  var prev = String(Number(S.gate.year) - 1);
  var prevList = S.closetsByKey[S.gate.hospital + "|" + prev] || [];
  if (!cs.length && prevList.length) {
    var c2 = el("div", "card"); c2.style.padding = "16px";
    c2.appendChild(el("div", null, "No closets for " + S.gate.year +
      " yet — start fresh or copy last year's list."));
    var cp = el("button", "btn secondary", "Copy " + prevList.length +
      " closets from " + prev);
    cp.style.marginTop = "12px";
    cp.onclick = function () {
      prevList.forEach(function (p) {
        closets().push({name: p.name, answers: {}, photos: {}, notes: ""});
      });
      save(); drawList();
    };
    c2.appendChild(cp);
    var note = el("div", "r3", "Names only — no answers or photos carry over.");
    note.style.marginTop = "8px";
    c2.appendChild(note);
    host.appendChild(c2);
  }

  var ex = el("button", "btn secondary", "Export for report builder");
  ex.onclick = function () { show("exp"); };
  host.appendChild(ex);
}

/* ---- questions ---- */
function drawQuestions() {
  var c = closets()[S.closet];
  if (!c) return show("list");
  $("qname").textContent = c.name;
  var host = $("qlist"); host.innerHTML = "";
  c.answers = c.answers || {}; c.photos = c.photos || {};

  Q.forEach(function (q) {
    var card = el("div", "card q");
    card.appendChild(el("div", "qt", q.question));

    var row = el("div", "opts");
    q.options.forEach(function (o) {
      var on = String(c.answers[q.id] || "").toLowerCase() === String(o.label).toLowerCase();
      var cls = "opt" + (q.options.length > 3 ? " four" : "");
      if (on) cls += o.result === "Pass" ? " on-pass" : o.result === "Fail" ? " on-fail" : " on-skip";
      var b = el("button", cls, o.label);
      b.onclick = function () {
        if (on) delete c.answers[q.id];      // tapping the chosen one clears it
        else c.answers[q.id] = o.label;
        save(); drawQuestions();
      };
      row.appendChild(b);
    });
    card.appendChild(row);

    var strip = el("div", "shots");
    (c.photos[q.id] || []).forEach(function (pid) {
      var t = el("div", "thumb");
      getPhoto(pid).then(function (b) {
        if (b) t.style.backgroundImage = "url(" + URL.createObjectURL(b) + ")";
      });
      t.onclick = function () { openViewer(pid); };
      var x = el("div", "x", "×");
      x.onclick = function (e) {
        e.stopPropagation();
        c.photos[q.id] = (c.photos[q.id] || []).filter(function (p) { return p !== pid; });
        delPhoto(pid); save(); drawQuestions();
      };
      t.appendChild(x);
      strip.appendChild(t);
    });
    var capw = el("label", "cap" + ((c.photos[q.id] || []).length ? " has" : ""));
    capw.innerHTML = cameraIcon();
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.capture = "environment";
    inp.multiple = true; inp.className = "hide";
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      Promise.all(files.map(function (f) {
        var id = q.id + "|" + Date.now() + "|" + Math.random().toString(36).slice(2, 7);
        return shrink(f).then(function (b) { return putPhoto(id, b); });
      })).then(function (ids) {
        c.photos[q.id] = (c.photos[q.id] || []).concat(ids);
        save(); drawQuestions();
      });
    };
    capw.appendChild(inp);
    strip.appendChild(capw);
    card.appendChild(strip);
    host.appendChild(card);
  });

  var nk = el("div", "kicker", "Closet notes");
  nk.style.marginTop = "4px";
  host.appendChild(nk);
  var ta = document.createElement("textarea");
  ta.className = "inp"; ta.placeholder = "anything worth recording";
  ta.value = c.notes || "";
  ta.oninput = function () { c.notes = ta.value; save(); };
  host.appendChild(ta);

  var done = el("button", "btn primary", "Done — back to closets");
  done.style.minHeight = "52px";
  done.onclick = function () { show("list"); };
  host.appendChild(done);

  var n = counts(c);
  $("qcount").textContent = n.done + "/" + n.total + " answered";
}

/* ---- sheets ---- */
function sheet(build) {
  var host = $("modal");
  host.innerHTML = "";
  var scrim = el("div", "scrim");
  var box = el("div", "sheet");
  scrim.appendChild(box);
  scrim.onclick = function (e) { if (e.target === scrim) host.innerHTML = ""; };
  build(box, function () { host.innerHTML = ""; });
  host.appendChild(scrim);
  liftForKeyboard(scrim);
  return scrim;
}
/* The sheet has to sit on the keyboard rather than behind it, and its buttons
   have to work on the first tap while the keyboard is up - hence commit on
   pointerdown rather than click. */
function liftForKeyboard(scrim) {
  var vv = window.visualViewport;
  if (!vv) return;
  function fit() {
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (kb > 80) { scrim.style.setProperty("--kb", kb + "px"); scrim.classList.add("lifted"); }
    else scrim.classList.remove("lifted");
  }
  vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit);
  scrim._unfit = function () {
    vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit);
  };
  fit();
}
function firstTap(btn, fn) {
  btn.addEventListener("pointerdown", function (e) { e.preventDefault(); fn(); });
}
function nameSheet() {
  sheet(function (box, close) {
    box.appendChild(el("div", "kicker", "New closet"));
    box.appendChild(el("h2", null, "Name this closet"));
    var inp = document.createElement("input");
    inp.className = "inp txt"; inp.placeholder = "e.g. IDF-3 · L3 North";
    box.appendChild(inp);
    var row = el("div"); row.style.display = "flex"; row.style.gap = "10px";
    var cancel = el("button", "btn secondary", "Cancel"); cancel.style.flex = "1";
    var go = el("button", "btn primary", "Start questions"); go.style.flex = "2";
    firstTap(cancel, close);
    firstTap(go, function () {
      var n = (inp.value || "").trim() || ("Closet " + (closets().length + 1));
      closets().push({name: n, answers: {}, photos: {}, notes: ""});
      S.closet = closets().length - 1;
      save(); close(); show("qs");
    });
    row.appendChild(cancel); row.appendChild(go);
    box.appendChild(row);
    setTimeout(function () { inp.focus(); }, 60);
  });
}
function confirmDelete(i) {
  var c = closets()[i];
  sheet(function (box, close) {
    var k = el("div", "kicker", "Delete closet"); k.style.color = "var(--fail-t)";
    box.appendChild(k);
    box.appendChild(el("h2", null, c.name));
    box.appendChild(el("div", "note",
      "Its answers, notes and photos go with it. This can't be undone."));
    var row = el("div"); row.style.display = "flex"; row.style.gap = "10px";
    var keep = el("button", "btn secondary", "Keep"); keep.style.flex = "1";
    var del = el("button", "btn danger", "Delete"); del.style.flex = "2";
    firstTap(keep, close);
    firstTap(del, function () {
      Object.keys(c.photos || {}).forEach(function (qid) {
        (c.photos[qid] || []).forEach(delPhoto);
      });
      closets().splice(i, 1); save(); close(); drawList();
    });
    row.appendChild(keep); row.appendChild(del);
    box.appendChild(row);
  });
}
function openViewer(pid) {
  getPhoto(pid).then(function (b) {
    if (!b) return;
    var host = $("viewer");
    host.innerHTML = "";
    var v = el("div", "viewer");
    var img = document.createElement("img");
    img.src = URL.createObjectURL(b);
    v.appendChild(img);
    v.appendChild(el("div", "cap2", "Tap anywhere to close"));
    v.onclick = function () { host.innerHTML = ""; };
    host.appendChild(v);
  });
}

/* ---- export ---- */
function exportName() {
  var h = (S.gate.hospital || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return S.gate.year + "-" + h + "-MobileData.json";
}
function rollup() {
  var worst = {}, RANK = {Fail: 0, Pass: 1, Skip: 2};
  closets().forEach(function (c) {
    Q.forEach(function (q) {
      var a = (c.answers || {})[q.id];
      if (!a) return;
      var r = resultOf(q, a);
      if (!r) return;
      if (!worst[q.id] || RANK[r] < RANK[worst[q.id].result])
        worst[q.id] = {result: r, closets: []};
      if (r === "Fail") worst[q.id].closets.push(c.name);
    });
  });
  return worst;
}
function drawExport() {
  var cs = closets(), shots = 0, answers = 0;
  cs.forEach(function (c) {
    var n = counts(c); shots += n.shots; answers += n.done;
  });
  var t = $("tally"); t.innerHTML = "";
  [cs.length + " closets", answers + " answers", shots + " photos"].forEach(function (s) {
    t.appendChild(el("div", null, s));
  });

  var host = $("alerts"); host.innerHTML = "";
  var w = rollup(), any = false;
  Q.forEach(function (q) {
    var r = w[q.id];
    if (!r || r.result !== "Fail") return;
    any = true;
    var row = el("div", "alert");
    row.appendChild(el("div", "bar"));
    var b = el("div");
    b.appendChild(el("div", "an", q.alert || q.question));
    var names = r.closets.filter(function (v, i, a) { return a.indexOf(v) === i; });
    b.appendChild(el("div", "ac", names.join(", ")));
    row.appendChild(b);
    host.appendChild(row);
  });
  if (!any) host.appendChild(el("div", "note", "Nothing is failing yet."));

  $("fname").textContent = exportName();
  $("savehint").textContent = "Save it wherever suits you, then open it with "
    + "Import walkaround in the tool.";
}
function buildPayload() {
  var cs = closets();
  return Promise.all(cs.map(function (c) {
    var byQ = {};
    var jobs = [];
    Object.keys(c.photos || {}).forEach(function (qid) {
      (c.photos[qid] || []).forEach(function (pid) {
        jobs.push(getPhoto(pid).then(blobToDataURL).then(function (d) {
          if (!d) return;
          (byQ[qid] = byQ[qid] || []).push(d);
        }));
      });
    });
    return Promise.all(jobs).then(function () {
      return {
        name: c.name, answers: c.answers || {}, notes: c.notes || "",
        // Each photo appears once, under the question it was taken for. There
        // used to be a second flat copy of every one of them alongside this,
        // which doubled the size of the file for nothing - base64 is already
        // a third bigger than the image. The importer reads this, and only
        // falls back to a flat list for exports made before it existed.
        photosByQuestion: byQ
      };
    });
  })).then(function (closetsOut) {
    return {
      kind: "healthcheck-walkaround", version: 1, section: "4.1",
      hospital: S.gate.hospital, year: String(S.gate.year),
      exported: new Date().toISOString(),
      questions: Q.map(function (q) {
        return {id: q.id, question: q.question, alert: q.alert, severity: q.severity};
      }),
      closets: closetsOut
    };
  });
}
function doSave() {
  var hint = $("savehint");
  buildPayload().then(function (payload) {
    var blob = new Blob([JSON.stringify(payload)], {type: "application/json"});
    var name = exportName();
    // on the phone the share sheet is what lets you choose where it goes
    var file = null;
    try { file = new File([blob], name, {type: "application/json"}); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({files: [file]})) {
      // marked only when the share actually completes - cancelling the
      // sheet must not leave a walkaround looking like it was sent
      navigator.share({files: [file], title: name})
        .then(markExported)
        .catch(function () {});
      return;
    }
    // on a PC it is a download. Run it from the outermost page: a browser
    // ignores a download started inside a frame, which is exactly what the
    // simulator is, and the file silently never arrives.
    var url = URL.createObjectURL(blob);
    var doc = document;
    try { if (window.top && window.top !== window && window.top.document) doc = window.top.document; }
    catch (e) { doc = document; }
    try {
      var a = doc.createElement("a");
      a.href = url; a.download = name;
      (doc.body || doc.documentElement).appendChild(a);
      a.click(); a.remove();
      if (hint) hint.textContent = "Saved " + name + " — look in your downloads.";
      markExported();
    } catch (e) {
      try { window.open(url, "_blank"); }
      catch (e2) {
        if (hint) hint.textContent = "Could not save the file here: " + e.message;
      }
    }
  }).catch(function (e) {
    if (hint) hint.textContent = "Could not build the export: " + e.message;
  });
}

/* ------------------------------------------------------------------ icons */
function trashIcon() {
  return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9da0a3"' +
    ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
}
function cameraIcon() {
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7fb6f2"' +
    ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0' +
    ' 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
}

/* ------------------------------------------------------------------- wire */
function stepYear(d) {
  var y = Math.min(YEAR_MAX, Math.max(YEAR_MIN, Number(S.gate.year) + d));
  S.gate.year = String(y); save(); drawList();
}
function init() {
  load();
  $("hosp").onchange = function () {
    S.gate.hospital = $("hosp").value; save(); drawGate();
  };
  $("addhosp").onclick = function () { $("addrow").classList.toggle("hide"); };
  $("addgo").onclick = function () {
    var n = ($("newhosp").value || "").trim();
    if (!n) return;
    // remembered as this phone's own, so a later publish cannot wipe it
    if (S.mine.indexOf(n) < 0) S.mine.push(n);
    if (S.hospitals.indexOf(n) < 0) S.hospitals.push(n);
    S.hospitals.sort(function (a, b) { return a.localeCompare(b); });
    S.gate.hospital = n; $("newhosp").value = "";
    $("addrow").classList.add("hide"); save(); drawGate();
  };
  $("yeartrig").onclick = openYears;
  $("start").onclick = function () { if (S.gate.hospital) show("list"); };
  $("tolaunch").onclick = function () { show("gate"); };
  $("ydown").onclick = function () { stepYear(-1); };
  $("yup").onclick = function () { stepYear(1); };
  $("toclosets").onclick = function () { show("list"); };
  $("toclosets2").onclick = function () { show("list"); };
  $("save").onclick = doSave;

  loadHospitals().then(loadQuestions).then(function (qs) {
    Q = qs;
    if (!Q.length) {
      $("resume").textContent = "No questions found - connect to the PC once to fetch them.";
    }
    show("gate");
  });

  // Coming back to the app is the moment to look for new questions and sites.
  // iOS resumes a backgrounded app without reloading the page, so without this
  // the set it opened with is the set it keeps - which is why a change
  // published on the PC looked like it had not arrived until the app was force
  // closed and reopened.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshFromServer();
  });
  window.addEventListener("focus", refreshFromServer);

  armOffline();
}

var refreshing = false;
function refreshFromServer() {
  // Only on the gate. Swapping the question set out from under someone
  // halfway through a closet would be worse than showing them a stale list,
  // and there is nothing on the later screens a refresh would improve.
  if (refreshing || S.screen !== "gate") return;
  refreshing = true;
  loadHospitals()
    .then(loadQuestions)
    .then(function (qs) {
      if (qs && qs.length) Q = qs;
      drawGate();
    })
    .catch(function () { /* no signal - keep what we have */ })
    .then(function () { refreshing = false; });
}

/* Caches the app so it opens with no signal. Silent on purpose - a phone
   served over plain http has no service worker at all, and there is nothing
   the user can do about it from here. The closets are saved on the phone
   either way. */
function armOffline() {
  if (!("serviceWorker" in navigator)) return;
  // .catch, not try/catch - a rejected register() would surface as an
  // uncaught promise error in the console otherwise
  navigator.serviceWorker.register("sw.js").catch(function () {});
}
document.addEventListener("DOMContentLoaded", init);
