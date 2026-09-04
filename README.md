# us-gics-industries

美股 **GICS 行业级**隔夜行情数据，每天自动更新，供 [finbench](https://github.com/xuyang203/finbench) 工作台读取。

**在线数据：** `https://raw.githubusercontent.com/xuyang203/us-gics-industries/main/us-industries.json`
（带 `Access-Control-Allow-Origin: *`，浏览器可直接跨域读取）

## 为什么需要这个仓库

美股没有公开的"GICS 74 行业行情"接口——74 个行业是**分类标准**，不是可交易标的，
大量行业（化工、机械、陆运、食品、水务…）根本没有对应的 ETF，任何行情源都报不出价。
S&P Dow Jones 虽有对应的子行业指数，但属授权产品，无免费接口。

因此这里的做法是：**取标普500 全部成分股的行情，按 GICS 分类聚合到行业层级**。
在 GitHub Actions 里跑（服务端无 CORS 限制），结果写成本仓库的 JSON，前端直接读。

## 数据链路

```
标普500 成分股 + GICS 子行业          行情（涨跌幅）
  datasets/s-and-p-500-companies       腾讯 qt.gtimg.cn
  (raw.githubusercontent.com)          us<TICKER>，批量 50 只/次
            │                                 │
            └────────────┬────────────────────┘
                         ▼
              fetch_us_industries.js
              子行业 → 行业映射（GICS v12 2023）
              等权聚合 → 剔除薄样本(<3只)
                         ▼
                  us-industries.json
```

| 环节 | 来源 | 说明 |
|---|---|---|
| 成分股 + 分类 | `datasets/s-and-p-500-companies` | 503 只，含 `GICS Sector` + `GICS Sub-Industry`（第 4 层） |
| 子行业 → 行业 | 脚本内置 `SUB2IND` 表 | 按 GICS v12（2023-03-17 生效）映射到第 3 层「行业」 |
| 行情 | 腾讯 `qt.gtimg.cn` | `ACAO:*`，实测 501/503 有效；`[32]`=涨跌幅% |

## 口径

- **聚合方式：等权**（每只成分股 1 票）
  不用市值加权，是因为 69 个行业里 44 个存在"单只个股占比 > 40%"
  （如 AMZN 占综合零售 98%、TSLA 占汽车 92%），市值加权会退化成那一只个股的行情。
- **范围：标普500**（503 只），不是全美股。
- **薄样本剔除：成分股 < 3 只的行业不输出**——涨跌基本等于单只个股，噪声过大。
- **更新频率：每个美股交易日 1 次**（cron UTC 22:00 = 北京次日 06:00）。股价一天只变一次，更高频率无意义。

## 覆盖范围

**69 / 74 个 GICS 行业**（93%）。剔除薄样本后实际输出 **53 个**。

缺失的 5 个行业（标普500 中零成分股）：纸与林木产品、海运、运输基础设施、抵押型 REITs、多元化 REITs。

被薄样本规则剔除的 16 个：无线电信服务、综合零售、汽车零部件、多元化消费者服务、经销商、休闲用品、
烟草、医疗保健技术、贸易公司与经销商、办公 REITs、房地产管理与开发、酒店度假 REITs、
工业 REITs、独立电力与可再生能源发电、水务公用事业、燃气公用事业。

## 输出格式

```json
{
  "date": "2026-09-03",
  "updatedAt": "2026-09-04T06:00:12.345Z",
  "source": "S&P 500 constituents (GICS) + 腾讯行情",
  "method": "equal-weight",
  "universe": "S&P 500",
  "minConstituents": 3,
  "stats": { "stocks": 501, "industries": 53, "droppedThin": 16 },
  "sectors":    [{ "sec": "信息技术", "n": 6, "chg": 0.96 }],
  "industries": [{ "sec": "信息技术", "ind": "软件", "n": 20, "chg": 2.34 }]
}
```

## 手动运行

```bash
node fetch_us_industries.js          # 只依赖 Node 内置模块，无需 npm install
```

脚本在抓取异常时 **exit 1 且不覆盖已有 JSON**（Actions 会显示红色，不会假装成功）。

## 注意事项

- 仓库必须 **Public**——私有仓库的 `raw.githubusercontent.com` 不对外服务。
- `raw.githubusercontent.com` 有约 5 分钟 CDN 缓存，前端读取时请带时间戳参数破缓存（`?t=<ts>`）。
