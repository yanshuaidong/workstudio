chrome.runtime.onInstalled.addListener((detail) => {
  console.log("[quant-pilot] installed:", detail.reason)
})

const COLLECTOR_TAB_PATH = "tabs/collector.html"

function openCollectorTab() {
  const url = chrome.runtime.getURL(COLLECTOR_TAB_PATH)
  chrome.tabs.create({ url })
}

chrome.action.onClicked.addListener(() => {
  openCollectorTab()
})
