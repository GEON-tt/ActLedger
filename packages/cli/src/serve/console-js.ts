import { LEVEL_TONE, STATUS_TONE } from "./html.js";

export const CONSOLE_JS = `(function () {
  var body = document.body;
  if (!body) return;
  document.documentElement.classList.add("js");
  var dict = document.getElementById("i18n");
  function s(name) {
    return dict ? dict.getAttribute("data-" + name) || "" : "";
  }
  var skew = 0;
  var serverNow = Date.parse(body.getAttribute("data-now") || "");
  if (!isNaN(serverNow)) skew = serverNow - Date.now();
  function nowMs() { return Date.now() + skew; }
  var rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat(body.getAttribute("data-locale") || "en", { numeric: "auto" })
    : null;
  var TONE = ${JSON.stringify(STATUS_TONE)};
  var LEVEL = ${JSON.stringify(LEVEL_TONE)};

  function rel(delta) {
    if (!rtf || isNaN(delta)) return null;
    var abs = Math.abs(delta);
    if (abs < 60000) return rtf.format(Math.round(delta / 1000), "second");
    if (abs < 3600000) return rtf.format(Math.round(delta / 60000), "minute");
    if (abs < 86400000) return rtf.format(Math.round(delta / 3600000), "hour");
    return rtf.format(Math.round(delta / 86400000), "day");
  }

  function absoluteLabel(iso) {
    var parsed = Date.parse(iso);
    if (isNaN(parsed)) return iso;
    try {
      return new Intl.DateTimeFormat(body.getAttribute("data-locale") || "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
    } catch (error) {
      return iso;
    }
  }

  function paintTimes() {
    var now = nowMs();
    var rels = document.querySelectorAll("time.rel");
    for (var i = 0; i < rels.length; i++) {
      var node = rels[i];
      var spoken = rel(Date.parse(node.getAttribute("datetime") || "") - now);
      if (spoken != null) node.textContent = spoken;
    }
    var clocks = document.querySelectorAll("time.countdown");
    for (var j = 0; j < clocks.length; j++) {
      var clock = clocks[j];
      var remaining = Date.parse(clock.getAttribute("datetime") || "") - now;
      if (isNaN(remaining)) continue;
      if (remaining <= 0) {
        clock.classList.add("is-expired");
        clock.classList.remove("is-soon");
        clock.textContent = s("expired");
        continue;
      }
      clock.classList.remove("is-expired");
      if (remaining < 600000) clock.classList.add("is-soon");
      else clock.classList.remove("is-soon");
      var left = rel(remaining);
      var template = s("expires");
      clock.textContent = left == null ? (clock.getAttribute("datetime") || "") : template.split("{rel}").join(left);
    }
    var absolutes = document.querySelectorAll("time.abs");
    for (var k = 0; k < absolutes.length; k++) {
      var stamp = absolutes[k].getAttribute("datetime") || "";
      absolutes[k].textContent = absoluteLabel(stamp);
    }
  }
  function paintTimesSoon() {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paintTimes);
    else paintTimes();
  }
  paintTimesSoon();
  setInterval(function () {
    if (document.hidden) return;
    paintTimes();
  }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) paintTimes();
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    var btn = target && target.closest ? target.closest("button.copy") : null;
    if (!btn) return;
    var value = btn.getAttribute("data-copy") || "";
    var original = btn.getAttribute("aria-label");
    function done() {
      btn.classList.add("is-copied");
      var copied = s("copied");
      btn.setAttribute("aria-label", copied);
      btn.setAttribute("title", copied);
      setTimeout(function () {
        btn.classList.remove("is-copied");
        if (original != null) {
          btn.setAttribute("aria-label", original);
          btn.setAttribute("title", original);
        }
      }, 1500);
    }
    function selectText() {
      var selection = window.getSelection && window.getSelection();
      var prev = btn.previousElementSibling;
      if (selection && prev) selection.selectAllChildren(prev);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, selectText);
    } else {
      selectText();
    }
  });

  var pageName = body.getAttribute("data-page") || "";
  var tab = body.getAttribute("data-tab") || "";
  if (pageName !== "list") return;
  if (tab !== "pending" && tab !== "recent" && tab !== "all") return;
  var timer = setInterval(tick, 3000);

  function labels() {
    var heads = document.querySelectorAll("#task-table thead th");
    var out = [];
    for (var i = 0; i < heads.length; i++) out.push(heads[i].textContent || "");
    return out;
  }

  function cell(className, label) {
    var td = document.createElement("td");
    td.className = className;
    td.setAttribute("data-label", label || "");
    return td;
  }

  function text(value) {
    return document.createTextNode(value == null ? "" : String(value));
  }

  function failUpdate() {
    var updated = document.getElementById("updated-at");
    if (updated) updated.classList.add("is-error");
    var slot = document.getElementById("updated-text");
    if (slot) slot.textContent = s("update-failed");
  }

  function tick() {
    if (document.hidden) return;
    fetch("/api/tasks?state=" + tab, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    }).then(function (response) {
      if (response.status === 401) {
        clearInterval(timer);
        var banner = document.getElementById("session-banner");
        if (banner) banner.hidden = false;
        var updated = document.getElementById("updated-at");
        if (updated) updated.classList.add("is-off");
        var slot = document.getElementById("updated-text");
        if (slot) slot.textContent = s("session-ended");
        return null;
      }
      if (!response.ok) {
        failUpdate();
        return null;
      }
      return response.json();
    }).then(function (data) {
      if (!data) return;
      var parsedNow = Date.parse(data.now || "");
      if (!isNaN(parsedNow)) skew = parsedNow - Date.now();
      var updated = document.getElementById("updated-at");
      if (updated) updated.classList.remove("is-error");
      var tbody = document.getElementById("task-rows");
      if (!tbody) return;
      var tasks = Array.isArray(data.tasks) ? data.tasks : [];
      var names = labels();
      var classes = ["col-task", "col-action", "col-level", "col-state", "col-principal", "col-created", "col-expires", "col-args", "col-intent"];
      var rows = [];
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i] || {};
        var action = task.action || {};
        var state = task.state == null ? "" : String(task.state);
        var tr = document.createElement("tr");
        tr.className = "task-row";
        tr.setAttribute("data-state", state);
        var idCell = cell(classes[0], names[0]);
        var link = document.createElement("a");
        link.className = "task-link mono";
        var id = task.id == null ? "" : String(task.id);
        link.setAttribute("href", "/tasks/" + encodeURIComponent(id));
        link.setAttribute("title", id);
        link.textContent = id;
        idCell.appendChild(link);
        tr.appendChild(idCell);
        var actionCell = cell(classes[1], names[1]);
        var code = document.createElement("code");
        code.textContent = action.type == null ? "" : String(action.type);
        actionCell.appendChild(code);
        tr.appendChild(actionCell);
        var levelCell = cell(classes[2], names[2]);
        var level = action.level == null ? "" : String(action.level);
        if (!level) {
          levelCell.appendChild(text(s("none")));
        } else {
          var levelEl = document.createElement("span");
          levelEl.className = "level level-" + (LEVEL[level] || "low");
          levelEl.textContent = level;
          levelCell.appendChild(levelEl);
        }
        tr.appendChild(levelCell);
        var stateCell = cell(classes[3], names[3]);
        var badge = document.createElement("span");
        badge.className = "status status-" + (TONE[state] || "muted");
        badge.setAttribute("title", state);
        var dot = document.createElement("span");
        dot.className = "status-dot";
        dot.setAttribute("aria-hidden", "true");
        badge.appendChild(dot);
        badge.appendChild(text(s("state-" + state.replace(/_/g, "-")) || state));
        stateCell.appendChild(badge);
        tr.appendChild(stateCell);
        var principalCell = cell(classes[4], names[4]);
        principalCell.appendChild(text(task.principalId));
        tr.appendChild(principalCell);
        var createdCell = cell(classes[5], names[5]);
        var created = document.createElement("time");
        created.className = "rel";
        var createdAt = task.createdAt == null ? "" : String(task.createdAt);
        created.setAttribute("datetime", createdAt);
        created.setAttribute("title", createdAt);
        created.textContent = createdAt;
        createdCell.appendChild(created);
        tr.appendChild(createdCell);
        var expiresCell = cell(classes[6], names[6]);
        var expiresAt = task.expiresAt ? String(task.expiresAt) : "";
        if (!expiresAt) {
          expiresCell.appendChild(text(s("none")));
        } else if (state === "pending_approval") {
          var expires = document.createElement("time");
          expires.setAttribute("datetime", expiresAt);
          expires.setAttribute("title", expiresAt);
          if (task.expired) {
            expires.className = "countdown is-expired";
            expires.textContent = s("expired");
          } else {
            expires.className = "countdown";
            expires.textContent = expiresAt;
          }
          expiresCell.appendChild(expires);
        } else {
          var absolute = document.createElement("time");
          absolute.className = "abs";
          absolute.setAttribute("datetime", expiresAt);
          absolute.setAttribute("title", expiresAt);
          absolute.textContent = expiresAt;
          expiresCell.appendChild(absolute);
        }
        tr.appendChild(expiresCell);
        var argsCell = cell(classes[7], names[7]);
        var args = document.createElement("span");
        var argsText = task.args == null ? "" : String(task.args);
        args.className = "clip mono";
        args.setAttribute("title", argsText);
        args.textContent = argsText;
        argsCell.appendChild(args);
        tr.appendChild(argsCell);
        var intentCell = cell(classes[8], names[8]);
        var intent = document.createElement("span");
        var intentText = task.intent == null ? "" : String(task.intent);
        intent.className = "clip";
        intent.setAttribute("title", intentText);
        intent.textContent = intentText;
        intentCell.appendChild(intent);
        tr.appendChild(intentCell);
        rows.push(tr);
      }
      tbody.replaceChildren.apply(tbody, rows);
      var table = document.getElementById("task-table");
      var empty = document.getElementById("empty-state");
      if (table) table.hidden = tasks.length === 0;
      if (empty) empty.hidden = tasks.length !== 0;
      var count = document.querySelector('[data-count-for="' + tab + '"]');
      if (count) count.textContent = String(tasks.length);
      var slot = document.getElementById("updated-text");
      if (slot) {
        var parts = s("updated").split("{time}");
        var stamp = data.now == null ? "" : String(data.now);
        var time = document.createElement("time");
        time.className = "rel";
        time.setAttribute("datetime", stamp);
        time.setAttribute("title", stamp);
        time.textContent = stamp;
        slot.replaceChildren(document.createTextNode(parts[0] || ""), time, document.createTextNode(parts.length > 1 ? parts.slice(1).join("{time}") : ""));
      }
      paintTimes();
    }).catch(function () {
      failUpdate();
    });
  }
})();
`;
