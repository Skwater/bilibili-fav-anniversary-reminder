'use strict';
/* 轻量自检：common.js 日期/工具函数（node tools/selftest.js 运行） */
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'common.js'), 'utf8');
const f = new Function(code + `
  return {
    pad2, dateKeyFromDate, keyToDate, isValidDateKey, mmddFromTs, yearFromTs,
    isLeapYear, feb29FallbackKey, effectiveDateFor, effectiveKeyFor, customSyncDaysFor, todayKey,
    fmtMmddCn, fmtDateCN, fmtDateTime, escapeHtml, CFG, MSG
  };
`)();

let failed = 0;
const eq = (a, b, m) => {
  if (String(a) !== String(b)) { console.log('FAIL', m, '=>', a, '!=', b); failed++; }
  else console.log('ok  ', m);
};

eq(f.dateKeyFromDate(new Date(2026, 1, 9)), '2026-02-09', 'dateKeyFromDate 本地月日');
eq(f.isValidDateKey('2026-02-09'), 'true', 'isValidDateKey 合法');
eq(f.isValidDateKey('2026-02-30'), 'false', 'isValidDateKey 非法日期');
eq(f.isValidDateKey('2026-13-01'), 'false', 'isValidDateKey 非法月份');
eq(f.isLeapYear(2024), 'true', '2024 闰年');
eq(f.isLeapYear(2023), 'false', '2023 平年');
eq(f.feb29FallbackKey({ feb29: '0228' }), '02-28', '2/29 默认并入 2/28');
eq(f.feb29FallbackKey({ feb29: '0301' }), '03-01', '2/29 备选并入 3/1');
eq(f.mmddFromTs(new Date(2023, 4, 1, 10, 0, 0).getTime() / 1000), '05-01', 'mmddFromTs');
eq(f.yearFromTs(new Date(2019, 11, 31).getTime() / 1000), '2019', 'yearFromTs');
eq(f.effectiveKeyFor({ debugDate: '2024-02-29' }), '2024-02-29', '模拟日期生效');
eq(f.effectiveKeyFor({ debugDate: '' }), f.todayKey(), '真实日期生效');
eq(f.fmtMmddCn('02-09'), '2 月 9 日', 'fmtMmddCn');
eq(f.fmtDateCN(new Date(2023, 1, 9)), '2023 年 2 月 9 日', 'fmtDateCN');
eq(f.escapeHtml('<a b="c">&\'x'), '&lt;a b=&quot;c&quot;&gt;&amp;&#39;x', 'escapeHtml');
eq(f.CFG.PAGE_SIZE, '20', 'CFG 常量存在');
eq(f.MSG.HOME_OPEN, 'HOME_OPEN', 'MSG 常量存在');
eq(f.MSG.GET_CALENDAR_YEAR, 'GET_CALENDAR_YEAR', '日历年度消息常量存在');
eq(f.MSG.GET_DATE_HITS, 'GET_DATE_HITS', '日历日期消息常量存在');
eq(f.MSG.EXPORT_DATA, 'EXPORT_DATA', '数据导出消息常量存在');
eq(f.MSG.IMPORT_DATA, 'IMPORT_DATA', '数据导入消息常量存在');
eq(f.MSG.ADD_WATCH_LATER, 'ADD_WATCH_LATER', '稍后再看消息常量存在');
eq(f.customSyncDaysFor({ customSyncDays: 7 }), '7', '自定义同步天数');
eq(f.customSyncDaysFor({ customSyncDays: 0 }), '1', '自定义同步天数下限');
eq(f.customSyncDaysFor({ customSyncDays: 999 }), '365', '自定义同步天数上限');

console.log(failed === 0 ? '\n全部通过 ✓' : ('\n失败 ' + failed + ' 项 ✗'));
process.exit(failed === 0 ? 0 : 1);
