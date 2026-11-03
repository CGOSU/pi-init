import assert from "node:assert/strict";
import test from "node:test";
import { createBillSvg, formatReport } from "../scripts/pi-usage.js";

test("pi-usage 统计页按模型和总量计算缓存命中率", () => {
  const report = formatReport({
    date: "2026-09-22",
    updatedAt: "2026-09-22T20:18:00.000Z",
    sessions: 1,
    rows: [
      { model: "provider/model-a", calls: 1, input: 50, output: 10, cacheRead: 30, cacheWrite: 10, tokens: 100, cost: 1, avgTps: null },
      { model: "provider/model-b", calls: 1, input: 5, output: 4, cacheRead: 0, cacheWrite: 1, tokens: 10, cost: 1, avgTps: null },
      { model: "provider/empty", calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, avgTps: null },
    ],
  });

  assert.match(report, /provider\/model-a.*40\.0%/);
  assert.match(report, /provider\/model-b.*10\.0%/);
  assert.match(report, /provider\/empty.*0\.0%/);
  assert.match(report, /Total.*37\.3%/);
});

test("pi-usage 对账单 SVG 汇总费用并转义动态文本", () => {
  const svg = createBillSvg(
    {
      date: "2026-09-22",
      sessions: 8,
      rows: [
        {
          model: 'provider/<model>&"',
          calls: 2,
          input: 2_549_990,
          output: 16_310,
          cacheRead: 2_490_000,
          cacheWrite: 0,
          tokens: 2_566_300,
          cost: 77.69,
        },
        {
          model: "provider/second",
          calls: 1,
          input: 50,
          output: 20,
          cacheRead: 10,
          cacheWrite: 20,
          tokens: 100,
          cost: 1.23,
        },
        {
          model: "provider/empty",
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokens: 0,
          cost: 0,
        },
      ],
    },
    { generatedAt: new Date(2026, 8, 22, 20, 18) },
  );

  assert.match(svg, /每日 AI 对账单/);
  assert.match(svg, /2026年9月22日/);
  assert.match(svg, /20:18/);
  assert.match(svg, /US\$79/);
  assert.match(svg, /US\$77\.69/);
  assert.match(svg, /&lt;model&gt;&amp;&quot;/);
  assert.match(svg, /总 Token 256\.63万/);
  assert.match(svg, /缓存命中率 97%/);
  assert.match(svg, /总 Token 100/);
  assert.match(svg, /缓存命中率 30%/);
  assert.match(svg, /总 Token 0/);
  assert.match(svg, /缓存命中率 0%/);
  assert.match(svg, /会话数/);
  assert.doesNotMatch(svg, /<model>/);
});

test("pi-usage 空数据对账单明确显示无记录", () => {
  const svg = createBillSvg({ date: "2026-09-22", sessions: 0, rows: [] });
  assert.match(svg, /暂无模型用量记录/);
  assert.match(svg, /US\$0/);
});
