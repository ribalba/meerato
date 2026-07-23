/* API page: the external create-task endpoint. Shows the user's token, an endpoint
 * URL, a curl example and copy-paste shell/Alfred snippets that bake in the chosen
 * bucket + status. The generated snippets live on App so the shell's copy buttons
 * can read the current value. Rendered via enterMainPanel("api"). */
(function () {
  "use strict";

  const App = window.App;
  const { $, esc, state, toast, errText, STATUS, liveBuckets, labelOf } = App;

  App.apiCurl = "";   // current curl example, kept in sync with the bucket/status selects
  App.apiGet = "";    // curl example for the GET (buckets + statuses) on the same URL
  App.apiTasks = "";  // curl example for GET /api/tasks (read every task back)
  App.apiShell = "";  // shell alias snippet (How-you-can-use-this modal)
  App.apiAlfred = ""; // Alfred Run Script snippet

  // Rebuild the endpoint URL + curl example from the current token and selectors.
  function updateApiCurl() {
    const token = state.user.api_token || "YOUR_TOKEN";
    const endpoint = `${location.origin}/api/create?token=${token}`;
    $("#api-endpoint").val(endpoint);
    const bucket = $("#api-bucket").val() || "";
    const status = $("#api-status").val() || "open";
    const body = JSON.stringify({ title: "My new task", bucket_id: bucket, status });
    App.apiCurl =
      `curl -X POST "${endpoint}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${body}'`;
    $("#api-curl").text(App.apiCurl);

    App.apiGet = `curl "${endpoint}"`;
    $("#api-get").text(App.apiGet);

    App.apiTasks = `curl "${location.origin}/api/tasks?token=${token}"`;
    $("#api-tasks").text(App.apiTasks);

    // The bucket + status picked above are baked into the snippets (same as the
    // curl example). They sit inside a double-quoted shell string, so each JSON
    // quote is escaped as \".
    const bodyTail = `, \\"bucket_id\\": \\"${bucket}\\", \\"status\\": \\"${status}\\"`;

    // Shell alias: everything after `todo` becomes the title. `${t//\"/\\\"}`
    // escapes any double quotes in the title so the JSON body stays valid. curl only.
    App.apiShell =
      `todo() {\n` +
      `  local t="$*"\n` +
      `  curl -fsS -X POST "${endpoint}" \\\n` +
      `    -H "Content-Type: application/json" \\\n` +
      `    -d "{\\"title\\": \\"\${t//\\"/\\\\\\"}\\"${bodyTail}}" >/dev/null \\\n` +
      `    && echo "✓ Added: $t"\n` +
      `}`;
    $("#api-shell-block").text(App.apiShell);

    // Alfred Run Script (bash, input as argv): $1 is the typed text.
    App.apiAlfred =
      `query="$1"\n` +
      `curl -fsS -X POST "${endpoint}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d "{\\"title\\": \\"\${query//\\"/\\\\\\"}\\"${bodyTail}}"`;
    $("#api-alfred-block").text(App.apiAlfred);
  }

  async function showApiPage() {
    App.enterMainPanel("api");
    // Create the token on first visit (the server returns it on /me thereafter).
    if (!state.user.api_token && navigator.onLine) {
      try {
        const u = await API.post("/api/auth/api-token");
        state.user.api_token = u.api_token;
      } catch (e) { toast(errText(e), "error"); }
    }
    const buckets = (await liveBuckets()).filter((b) => !b.archived);
    $("#api-bucket").html(
      buckets.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("") ||
      `<option value="">(create a bucket first)</option>`
    );
    $("#api-status").html(STATUS.map((s) => `<option value="${s.value}">${labelOf(s.value)}</option>`).join(""));
    updateApiCurl();
  }

  async function rotateApiToken() {
    if (!navigator.onLine) return toast("Connect to regenerate the token", "warning");
    if (!confirm("Regenerate your API token? The current one stops working immediately.")) return;
    try {
      const u = await API.post("/api/auth/api-token/rotate");
      state.user.api_token = u.api_token;
      updateApiCurl();
      toast("New token generated");
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  Object.assign(App, { updateApiCurl, showApiPage, rotateApiToken });
})();
