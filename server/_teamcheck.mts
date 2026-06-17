import { dbGet } from './src/db.js';

const token = '0ebe7188c03e9b99';
const run = await dbGet<any>(
  `SELECT id, question, result, member_outputs, input_tokens, output_tokens, created_at
   FROM team_runs WHERE share_token = ?`, token);
if (!run) { console.log('找不到這個分享 run'); process.exit(0); }

console.log('議題:', run.question);
console.log('tokens:', run.input_tokens, '/', run.output_tokens, '| 時間:', run.created_at);

const all = (run.result || '') + '\n' + (run.member_outputs || '');

// 真實檔案的 30 個虛構客戶
const realCustomers = ['晶宏精密','華昇通訊','鼎崴動力','凱碩工控','宇泰電源','力揚光電','群曜半導','安捷感測','泰鼎能源','鴻劭網通',
'邁特材料','諾威系統','晟邦機電','凌豐自動','達豐封測','翔毅車電','銘碁儲能','富喬光學','元舜散熱','卓越雲服',
'聯崴連接','信冠電子','瑞磁影像','廣立工業','天樞顯示','嘉沛模組','沛健電機','至宸包材','全宥環控','世翊設計'];
const hit = realCustomers.filter(c => all.includes(c));
console.log(`\n=== 檔案真實客戶命中: ${hit.length}/30 ===`);
console.log(hit.join('、') || '(一個都沒有 → 可能沒讀檔)');

console.log('\n總額 2,552,703 有出現?', all.includes('2,552,703') || all.includes('2552703'));
console.log('警訊客戶「翔毅車電」有出現?', all.includes('翔毅車電'));

// 不該出現的:知名大廠(若出現=幻覺/上網混入)
const famous = ['台積電','鴻海','群創','友達','聯發科','Sony','台達','緯創','廣達','三星','Samsung','BOSCH','輝達','Nvidia','蘋果','Apple','特斯拉','Tesla'];
const bad = famous.filter(c => all.includes(c));
console.log('\n=== 不該出現的知名大廠 ===');
console.log(bad.length ? '⚠ 出現: ' + bad.join('、') : '✅ 無(沒有亂掺外部公司)');

// 是否有網路來源(file-only 模式應該沒有 http 來源)
const urls = (all.match(/https?:\/\/[^\s)\]>"']+/g) || []);
console.log('\n網址/來源數量:', urls.length, urls.length ? '(有上網? ' + urls.slice(0,3).join(' , ') + ')' : '(無 → 符合只看檔案)');

console.log('\n=== 最終結論(前 1200 字) ===');
console.log((run.result || '').slice(0, 1200));

process.exit(0);
