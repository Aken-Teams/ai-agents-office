import fs from 'fs';
const f = 'excelContext.ts';
let s = fs.readFileSync(f, 'utf8'); const b = s;
s = s.replace('- 只有在計畫本身有真正的分歧（不同選擇會做出很不一樣的東西）時，才回頭問一句。',
`- 只有在計畫本身有真正的分歧（不同選擇會做出很不一樣的東西）時，才回頭問一句——
  而且要用 \\`excel_ask_user\\` 把選項給他點，**不要寫成「1. … 2. … 你要哪個？」的文字**。
  側邊欄會把選項變成按鈕，他點一下就好，不用打字描述他要哪個。`);
if (s === b) { console.error('NO EDIT'); process.exit(1); }
fs.writeFileSync(f, s); console.log('ok');
