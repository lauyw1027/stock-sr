import YahooFinance from "yahoo-finance2"; // 注意：大寫開頭
const yahooFinance = new YahooFinance();

async function test() {
  try {
    const result = await yahooFinance.options("AAPL");
    console.log("完整原始回應:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("完整錯誤物件:", e);
  }
}

test();