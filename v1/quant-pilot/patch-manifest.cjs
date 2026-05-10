const fs = require("fs")
const path = require("path")

const buildDir = path.join(__dirname, "build", "chrome-mv3-prod")
const manifestPath = path.join(buildDir, "manifest.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const targetMatches = [
  "https://quote.eastmoney.com/center/gridlist.html*",
  "https://data.eastmoney.com/zjlx/detail.html*"
]

manifest.content_scripts = (manifest.content_scripts || []).map((script) => {
  const js = script.js || []
  if (js.some((item) => item.includes("eastmoney-inpage-hook"))) {
    return {
      ...script,
      matches: targetMatches,
      run_at: "document_start",
      world: "MAIN"
    }
  }
  return script
})

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
