// Syntax-checks PixInsight scripts with this V8: preprocessor lines (#include, #define,
// #feature-*, #engine) and their backslash continuations become blank lines, then the
// rest is compiled (not run). Usage: node tools/check_syntax.js <file>...
const fs = require("fs");
const vm = require("vm");
let bad = 0;
for (const f of process.argv.slice(2)) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  let cont = false;
  const out = lines.map((l) => {
    if (cont || /^\s*#/.test(l)) {
      cont = /\\\s*$/.test(l);
      return "";
    }
    return l;
  });
  try {
    new vm.Script(out.join("\n"), { filename: f });
    console.log(f + ": ok");
  } catch (e) {
    bad++;
    console.log(f + ": " + e.message + " " + (e.stack.split("\n")[0] || ""));
  }
}
process.exit(bad ? 1 : 0);
