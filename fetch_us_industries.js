#!/usr/bin/env node
/* 美股 GICS 行业隔夜行情聚合器（B 方案）
 *
 * 数据链路（全部为免费公开源，无需 API Key）：
 *   1) 成分股 + GICS 子行业
 *      https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv
 *      字段：Symbol, Security, GICS Sector, GICS Sub-Industry, ...
 *      （该数据集只给到 GICS 第 4 层「子行业」，故下面用 SUB2IND 表映射回第 3 层「行业」）
 *   2) 行情（涨跌幅 + 总市值）
 *      腾讯 https://qt.gtimg.cn/q=us<TICKER>[,us<TICKER>...]
 *      字段以 ~ 分隔：[3]=现价 [4]=昨收 [30]=时间 [32]=涨跌幅% [44]=流通市值(亿美元) [45]=总市值(亿美元)
 *      实测 ACAO:* ，一次可批量 50 只
 *
 * 聚合口径：等权平均（每只成分股 1 票）
 *   —— 不用市值加权的原因：69 个行业里 44 个存在「单只个股占比 > 40%」，
 *      市值加权会退化成那一只个股的行情，失去行业广度信息。
 * 薄样本剔除：成分股 < MIN_CONSTITUENTS(3) 的行业不输出（涨跌≈单只个股，噪声过大）
 *
 * 用法：node fetch_us_industries.js [输出路径]
 *   默认写到脚本同目录的 us-industries.json
 * 退出码：0=成功、1=失败（失败时不覆盖已有 JSON，避免 Actions 显示绿色却没更新）
 */

const fs = require('fs');
const path = require('path');

const CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const QQ_URL = 'https://qt.gtimg.cn/q=';
const MIN_CONSTITUENTS = 3;      // 薄样本阈值
const BATCH = 50;                // 腾讯单次批量上限（实测 ≥50 可用）
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

// 阈值校验：低于这些值视为抓取异常，不覆盖旧数据
const MIN_STOCKS = 450;          // 标普500 共 503 只
const MIN_INDUSTRIES = 45;       // 剔除薄样本后应有 ~53 个

/* GICS v12(2023) 子行业 -> 行业 映射
 * 仅收录标普500 实际出现的 127 个子行业，覆盖 69 / 74 个 GICS 行业 */
const SUB2IND = {
  // Energy（能源）— 2 行业
  'Oil & Gas Equipment & Services': ['能源设备与服务', '能源', 'Energy'],
  'Oil & Gas Exploration & Production': ['石油天然气与消费燃料', '能源', 'Energy'],
  'Oil & Gas Refining & Marketing': ['石油天然气与消费燃料', '能源', 'Energy'],
  'Oil & Gas Storage & Transportation': ['石油天然气与消费燃料', '能源', 'Energy'],
  'Integrated Oil & Gas': ['石油天然气与消费燃料', '能源', 'Energy'],
  // Materials（材料）— 4 行业（缺「纸与林木产品」）
  'Commodity Chemicals': ['化工', '材料', 'Materials'],
  'Specialty Chemicals': ['化工', '材料', 'Materials'],
  'Industrial Gases': ['化工', '材料', 'Materials'],
  'Fertilizers & Agricultural Chemicals': ['化工', '材料', 'Materials'],
  'Construction Materials': ['建筑材料', '材料', 'Materials'],
  'Metal, Glass & Plastic Containers': ['容器与包装', '材料', 'Materials'],
  'Paper & Plastic Packaging Products & Materials': ['容器与包装', '材料', 'Materials'],
  'Steel': ['金属与采矿', '材料', 'Materials'],
  'Copper': ['金属与采矿', '材料', 'Materials'],
  'Gold': ['金属与采矿', '材料', 'Materials'],
  // Industrials（工业）— 12 行业（缺「海运」「运输基础设施」）
  'Aerospace & Defense': ['航空航天与国防', '工业', 'Industrials'],
  'Building Products': ['建筑产品', '工业', 'Industrials'],
  'Construction & Engineering': ['建筑与工程', '工业', 'Industrials'],
  'Electrical Components & Equipment': ['电气设备', '工业', 'Industrials'],
  'Heavy Electrical Equipment': ['电气设备', '工业', 'Industrials'],
  'Industrial Conglomerates': ['工业集团', '工业', 'Industrials'],
  'Industrial Machinery & Supplies & Components': ['机械', '工业', 'Industrials'],
  'Construction Machinery & Heavy Transportation Equipment': ['机械', '工业', 'Industrials'],
  'Agricultural & Farm Machinery': ['机械', '工业', 'Industrials'],
  'Trading Companies & Distributors': ['贸易公司与经销商', '工业', 'Industrials'],
  'Environmental & Facilities Services': ['商业服务与用品', '工业', 'Industrials'],
  'Diversified Support Services': ['商业服务与用品', '工业', 'Industrials'],
  'Data Processing & Outsourced Services': ['商业服务与用品', '工业', 'Industrials'],
  'Human Resource & Employment Services': ['专业服务', '工业', 'Industrials'],
  'Research & Consulting Services': ['专业服务', '工业', 'Industrials'],
  'Air Freight & Logistics': ['航空货运与物流', '工业', 'Industrials'],
  'Passenger Airlines': ['客运航空', '工业', 'Industrials'],
  'Rail Transportation': ['陆运', '工业', 'Industrials'],
  'Cargo Ground Transportation': ['陆运', '工业', 'Industrials'],
  'Passenger Ground Transportation': ['陆运', '工业', 'Industrials'],
  // Consumer Discretionary（可选消费）— 10 行业（全覆盖）
  'Automotive Parts & Equipment': ['汽车零部件', '可选消费', 'Consumer Discretionary'],
  'Automobile Manufacturers': ['汽车', '可选消费', 'Consumer Discretionary'],
  'Homebuilding': ['家用耐用消费品', '可选消费', 'Consumer Discretionary'],
  'Consumer Electronics': ['家用耐用消费品', '可选消费', 'Consumer Discretionary'],
  'Leisure Products': ['休闲用品', '可选消费', 'Consumer Discretionary'],
  'Apparel, Accessories & Luxury Goods': ['纺织品服装与奢侈品', '可选消费', 'Consumer Discretionary'],
  'Footwear': ['纺织品服装与奢侈品', '可选消费', 'Consumer Discretionary'],
  'Hotels, Resorts & Cruise Lines': ['酒店餐饮与休闲', '可选消费', 'Consumer Discretionary'],
  'Restaurants': ['酒店餐饮与休闲', '可选消费', 'Consumer Discretionary'],
  'Casinos & Gaming': ['酒店餐饮与休闲', '可选消费', 'Consumer Discretionary'],
  'Specialized Consumer Services': ['多元化消费者服务', '可选消费', 'Consumer Discretionary'],
  'Distributors': ['经销商', '可选消费', 'Consumer Discretionary'],
  'Broadline Retail': ['综合零售', '可选消费', 'Consumer Discretionary'],
  'Automotive Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  'Home Improvement Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  'Apparel Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  'Other Specialty Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  'Computer & Electronics Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  'Homefurnishing Retail': ['专业零售', '可选消费', 'Consumer Discretionary'],
  // Consumer Staples（必需消费）— 6 行业（全覆盖）
  'Consumer Staples Merchandise Retail': ['必需消费分销与零售', '必需消费', 'Consumer Staples'],
  'Food Retail': ['必需消费分销与零售', '必需消费', 'Consumer Staples'],
  'Food Distributors': ['必需消费分销与零售', '必需消费', 'Consumer Staples'],
  'Soft Drinks & Non-alcoholic Beverages': ['饮料', '必需消费', 'Consumer Staples'],
  'Brewers': ['饮料', '必需消费', 'Consumer Staples'],
  'Distillers & Vintners': ['饮料', '必需消费', 'Consumer Staples'],
  'Packaged Foods & Meats': ['食品', '必需消费', 'Consumer Staples'],
  'Agricultural Products & Services': ['食品', '必需消费', 'Consumer Staples'],
  'Tobacco': ['烟草', '必需消费', 'Consumer Staples'],
  'Household Products': ['家庭用品', '必需消费', 'Consumer Staples'],
  'Personal Care Products': ['个人护理用品', '必需消费', 'Consumer Staples'],
  // Health Care（医疗保健）— 6 行业（全覆盖）
  'Health Care Equipment': ['医疗设备与用品', '医疗保健', 'Health Care'],
  'Health Care Supplies': ['医疗设备与用品', '医疗保健', 'Health Care'],
  'Health Care Services': ['医疗服务提供商', '医疗保健', 'Health Care'],
  'Health Care Distributors': ['医疗服务提供商', '医疗保健', 'Health Care'],
  'Managed Health Care': ['医疗服务提供商', '医疗保健', 'Health Care'],
  'Health Care Facilities': ['医疗服务提供商', '医疗保健', 'Health Care'],
  'Health Care Technology': ['医疗保健技术', '医疗保健', 'Health Care'],
  'Biotechnology': ['生物科技', '医疗保健', 'Health Care'],
  'Pharmaceuticals': ['制药', '医疗保健', 'Health Care'],
  'Life Sciences Tools & Services': ['生命科学工具与服务', '医疗保健', 'Health Care'],
  // Financials（金融）— 5 行业（缺「抵押型REITs」）
  'Diversified Banks': ['银行', '金融', 'Financials'],
  'Regional Banks': ['银行', '金融', 'Financials'],
  'Transaction & Payment Processing Services': ['金融服务', '金融', 'Financials'],
  'Financial Exchanges & Data': ['金融服务', '金融', 'Financials'],
  'Multi-Sector Holdings': ['金融服务', '金融', 'Financials'],
  'Consumer Finance': ['消费金融', '金融', 'Financials'],
  'Asset Management & Custody Banks': ['资本市场', '金融', 'Financials'],
  'Investment Banking & Brokerage': ['资本市场', '金融', 'Financials'],
  'Property & Casualty Insurance': ['保险', '金融', 'Financials'],
  'Life & Health Insurance': ['保险', '金融', 'Financials'],
  'Multi-line Insurance': ['保险', '金融', 'Financials'],
  'Insurance Brokers': ['保险', '金融', 'Financials'],
  'Reinsurance': ['保险', '金融', 'Financials'],
  // Information Technology（信息技术）— 6 行业（全覆盖）
  'IT Consulting & Other Services': ['IT服务', '信息技术', 'Information Technology'],
  'Internet Services & Infrastructure': ['IT服务', '信息技术', 'Information Technology'],
  'Application Software': ['软件', '信息技术', 'Information Technology'],
  'Systems Software': ['软件', '信息技术', 'Information Technology'],
  'Communications Equipment': ['通信设备', '信息技术', 'Information Technology'],
  'Technology Hardware, Storage & Peripherals': ['技术硬件存储与外围设备', '信息技术', 'Information Technology'],
  'Technology Distributors': ['技术硬件存储与外围设备', '信息技术', 'Information Technology'],
  'Electronic Equipment & Instruments': ['电子设备仪器与元件', '信息技术', 'Information Technology'],
  'Electronic Components': ['电子设备仪器与元件', '信息技术', 'Information Technology'],
  'Electronic Manufacturing Services': ['电子设备仪器与元件', '信息技术', 'Information Technology'],
  'Semiconductors': ['半导体及半导体设备', '信息技术', 'Information Technology'],
  'Semiconductor Materials & Equipment': ['半导体及半导体设备', '信息技术', 'Information Technology'],
  // Communication Services（通信服务）— 5 行业（全覆盖）
  'Integrated Telecommunication Services': ['多元化电信服务', '通信服务', 'Communication Services'],
  'Cable & Satellite': ['多元化电信服务', '通信服务', 'Communication Services'],
  'Wireless Telecommunication Services': ['无线电信服务', '通信服务', 'Communication Services'],
  'Advertising': ['媒体', '通信服务', 'Communication Services'],
  'Broadcasting': ['媒体', '通信服务', 'Communication Services'],
  'Publishing': ['媒体', '通信服务', 'Communication Services'],
  'Movies & Entertainment': ['娱乐', '通信服务', 'Communication Services'],
  'Interactive Home Entertainment': ['娱乐', '通信服务', 'Communication Services'],
  'Interactive Media & Services': ['互动媒体与服务', '通信服务', 'Communication Services'],
  // Utilities（公用事业）— 5 行业（全覆盖）
  'Electric Utilities': ['电力公用事业', '公用事业', 'Utilities'],
  'Multi-Utilities': ['综合公用事业', '公用事业', 'Utilities'],
  'Gas Utilities': ['燃气公用事业', '公用事业', 'Utilities'],
  'Water Utilities': ['水务公用事业', '公用事业', 'Utilities'],
  'Independent Power Producers & Energy Traders': ['独立电力与可再生能源发电', '公用事业', 'Utilities'],
  // Real Estate（房地产）— 8 行业（缺「多元化REITs」）
  'Industrial REITs': ['工业REITs', '房地产', 'Real Estate'],
  'Hotel & Resort REITs': ['酒店度假REITs', '房地产', 'Real Estate'],
  'Office REITs': ['办公REITs', '房地产', 'Real Estate'],
  'Health Care REITs': ['医疗REITs', '房地产', 'Real Estate'],
  'Multi-Family Residential REITs': ['住宅REITs', '房地产', 'Real Estate'],
  'Single-Family Residential REITs': ['住宅REITs', '房地产', 'Real Estate'],
  'Retail REITs': ['零售REITs', '房地产', 'Real Estate'],
  'Telecom Tower REITs': ['特种REITs', '房地产', 'Real Estate'],
  'Data Center REITs': ['特种REITs', '房地产', 'Real Estate'],
  'Self-Storage REITs': ['特种REITs', '房地产', 'Real Estate'],
  'Other Specialized REITs': ['特种REITs', '房地产', 'Real Estate'],
  'Timber REITs': ['特种REITs', '房地产', 'Real Estate'],
  'Real Estate Services': ['房地产管理与开发', '房地产', 'Real Estate'],
};

// 板块展示顺序（按成分股数由多到少，便于阅读）
const SEC_ORDER = ['信息技术', '工业', '金融', '医疗保健', '可选消费', '必需消费',
  '通信服务', '公用事业', '房地产', '能源', '材料'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, tries = 5, timeoutMs = 20000) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { headers: UA, signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) return await r.text();
      err = new Error('HTTP ' + r.status);
    } catch (e) { err = e; }
    await sleep(1500 * (i + 1));
  }
  throw err;
}

function parseCSVLine(l) {
  const f = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { f.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  f.push(cur.trim());
  return f;
}

(async () => {
  const outPath = process.argv[2] || path.join(__dirname, 'us-industries.json');

  console.log('[1/4] 拉取标普500 成分股 + GICS 子行业 ...');
  const csv = await getText(CSV_URL);
  const lines = csv.trim().split('\n');
  const stockInd = {};   // code -> [行业, 板块, 板块英文]
  const unmapped = new Set();
  lines.slice(1).forEach(l => {
    const f = parseCSVLine(l);
    if (f.length < 4) return;
    const sec = f[2], sub = f[3];
    const m = SUB2IND[sub];
    if (!m) { unmapped.add(sec + ' > ' + sub); return; }
    // 腾讯代码：点号用 - 代替（BRK.B -> BRK-B）
    stockInd[f[0].replace(/\./g, '-')] = m;
  });
  const codes = Object.keys(stockInd);
  console.log('      成分股 ' + codes.length + ' 只，未映射子行业 ' + unmapped.size + ' 个');
  if (unmapped.size) console.log('      ' + [...unmapped].join(' | '));

  console.log('[2/4] 腾讯批量取价（' + Math.ceil(codes.length / BATCH) + ' 批 x ' + BATCH + ' 只）...');
  const rows = [];
  const dates = {};
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    try {
      const txt = await getText(QQ_URL + batch.map(c => 'us' + c).join(','), 4);
      txt.split(';').filter(Boolean).forEach(p => {
        const m = p.match(/v_(\w+)="([^"]*)"/);
        if (!m) return;
        const f = m[2].split('~');
        const code = m[1].replace(/^us/, '').toUpperCase();
        const pct = parseFloat(f[32]);
        if (!isNaN(pct) && stockInd[code]) {
          rows.push({ code, pct });
          const d = (f[30] || '').slice(0, 10);
          if (d) dates[d] = (dates[d] || 0) + 1;
        }
      });
    } catch (e) {
      console.log('      批次 ' + (i / BATCH + 1) + ' 失败（跳过）: ' + e.message);
    }
    await sleep(300);
  }
  console.log('      有效报价 ' + rows.length + ' / ' + codes.length);
  if (rows.length < MIN_STOCKS) {
    console.error('报价数 ' + rows.length + ' < 阈值 ' + MIN_STOCKS + '，判定为抓取异常，不覆盖已有数据');
    process.exit(1);
  }

  // 取出现次数最多的日期作为"数据日期"（美股交易日）
  const date = Object.entries(dates).sort((a, b) => b[1] - a[1])[0][0];

  console.log('[3/4] 按 GICS 行业等权聚合 ...');
  const grp = {};
  rows.forEach(r => {
    const [ind, sec] = stockInd[r.code];
    const k = sec + '|' + ind;
    (grp[k] = grp[k] || { sec, ind, sum: 0, n: 0 }).sum += r.pct;
    grp[k].n++;
  });
  const all = Object.values(grp).map(g => ({ sec: g.sec, ind: g.ind, n: g.n, chg: +(g.sum / g.n).toFixed(2) }));
  const thin = all.filter(x => x.n < MIN_CONSTITUENTS);
  const kept = all
    .filter(x => x.n >= MIN_CONSTITUENTS)
    .sort((a, b) => SEC_ORDER.indexOf(a.sec) - SEC_ORDER.indexOf(b.sec) || b.chg - a.chg);
  console.log('      聚合出 ' + all.length + ' 个行业，剔除薄样本(<3只) ' + thin.length + ' 个，保留 ' + kept.length + ' 个');
  if (thin.length) console.log('      剔除: ' + thin.map(x => x.sec + '·' + x.ind + '(' + x.n + ')').join('、'));
  if (kept.length < MIN_INDUSTRIES) {
    console.error('行业数 ' + kept.length + ' < 阈值 ' + MIN_INDUSTRIES + '，判定为抓取异常，不覆盖已有数据');
    process.exit(1);
  }

  // 板块汇总（同样是等权：先算行业内等权，再算板块内行业等权，避免大行业主导）
  const secGrp = {};
  kept.forEach(x => { (secGrp[x.sec] = secGrp[x.sec] || []).push(x.chg); });
  const sectors = Object.entries(secGrp)
    .map(([sec, arr]) => ({ sec, n: arr.length, chg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) }))
    .sort((a, b) => SEC_ORDER.indexOf(a.sec) - SEC_ORDER.indexOf(b.sec));

  const out = {
    date,
    updatedAt: new Date().toISOString(),
    source: 'S&P 500 constituents (GICS) + 腾讯行情',
    method: 'equal-weight',
    universe: 'S&P 500',
    minConstituents: MIN_CONSTITUENTS,
    stats: { stocks: rows.length, industries: kept.length, droppedThin: thin.length },
    sectors,
    industries: kept
  };

  console.log('[4/4] 写入 ' + outPath);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  const up = kept.filter(x => x.chg > 0).length;
  console.log('      数据日期 ' + date + ' · ' + kept.length + ' 个行业 · 涨 ' + up + ' / 跌 ' + (kept.length - up));
  console.log('      领涨: ' + kept.slice().sort((a, b) => b.chg - a.chg).slice(0, 3).map(x => x.ind + ' ' + x.chg + '%').join('、'));
  console.log('      领跌: ' + kept.slice().sort((a, b) => a.chg - b.chg).slice(0, 3).map(x => x.ind + ' ' + x.chg + '%').join('、'));
  console.log('OK');
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
