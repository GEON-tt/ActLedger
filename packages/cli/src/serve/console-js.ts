export const CONSOLE_JS = `(function () {
  var tab = document.body && document.body.dataset ? document.body.dataset.tab : "";
  if (tab !== "pending" && tab !== "recent" && tab !== "all") return;
  var timer = setInterval(tick, 3000);

  function text(el, value) {
    if (el) el.textContent = value;
  }

  function cell(value) {
    var td = document.createElement("td");
    td.textContent = value == null ? "" : String(value);
    return td;
  }

  function tick() {
    if (document.hidden) return;
    var updated = document.getElementById("updated-at");
    fetch("/api/tasks?state=" + tab, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    }).then(function (response) {
      if (response.status === 401) {
        clearInterval(timer);
        text(updated, "Session ended. Run actledger serve --print-login and open the URL again.");
        return null;
      }
      if (!response.ok) {
        text(updated, "Update failed; retrying.");
        return null;
      }
      return response.json();
    }).then(function (data) {
      if (!data) return;
      var tbody = document.getElementById("task-rows");
      if (!tbody) return;
      var tasks = Array.isArray(data.tasks) ? data.tasks : [];
      var rows = [];
      if (tasks.length === 0) {
        var empty = document.createElement("tr");
        var emptyCell = document.createElement("td");
        emptyCell.colSpan = 9;
        emptyCell.textContent = "No tasks.";
        empty.appendChild(emptyCell);
        rows.push(empty);
      } else {
        for (var i = 0; i < tasks.length; i++) {
          var task = tasks[i];
          var tr = document.createElement("tr");
          var idCell = document.createElement("td");
          var link = document.createElement("a");
          link.href = "/tasks/" + encodeURIComponent(task.id);
          link.textContent = task.id == null ? "" : String(task.id);
          idCell.appendChild(link);
          tr.appendChild(idCell);
          var action = task.action || {};
          tr.appendChild(cell(action.type));
          tr.appendChild(cell(action.level));
          tr.appendChild(cell(task.state));
          tr.appendChild(cell(task.principalId));
          tr.appendChild(cell(task.createdAt));
          var expires = task.expiresAt ? String(task.expiresAt) : "";
          if (task.expired) expires = expires + " 已超时";
          tr.appendChild(cell(expires));
          tr.appendChild(cell(task.args));
          tr.appendChild(cell(task.intent));
          rows.push(tr);
        }
      }
      tbody.replaceChildren.apply(tbody, rows);
      text(updated, "Updated " + data.now);
    }).catch(function () {
      text(updated, "Update failed; retrying.");
    });
  }
})();
`;
