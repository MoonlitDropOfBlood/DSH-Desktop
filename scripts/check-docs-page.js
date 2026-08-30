// Temp checker: parse-check inline <script> blocks (new Function = parse only, no exec)
// and scan docs/index.html for emoji codepoints (user requirement: NO emojis).
const fs = require("fs");
const html = fs.readFileSync("docs/index.html", "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) { console.error("NO SCRIPT FOUND"); process.exit(1); }
scripts.forEach((m, i) => {
  try { new Function(m[1]); }
  catch (e) { console.error(`SCRIPT ${i} PARSE ERROR: ${e.message}`); process.exit(1); }
});
console.log(`inline scripts OK (${scripts.length})`);

const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;
const found = html.match(emojiRe) || [];
if (found.length) { console.error("EMOJI FOUND:", [...new Set(found)].join(" ")); process.exit(1); }
console.log("emoji scan OK (none found)");
