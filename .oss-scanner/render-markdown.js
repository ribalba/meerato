// Render Markdown the way the frontend does (marked plus app/static/js/markdown.js)
// and print the sanitised HTML that would be inserted into the page. Runs offline in
// the OSS Scanner image, where the CDN copy of marked is unreachable.
//
//   node .oss-scanner/render-markdown.js < payload.md
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/opt/meerato-js/node_modules/jsdom");
const marked = require("/opt/meerato-js/node_modules/marked");

const dom = new JSDOM("<!DOCTYPE html><body></body>", { runScripts: "outside-only" });
dom.window.marked = marked;
dom.window.eval(
  fs.readFileSync(path.join(__dirname, "..", "app", "static", "js", "markdown.js"), "utf8")
);
process.stdout.write(dom.window.MD.render(fs.readFileSync(0, "utf8")) + "\n");
