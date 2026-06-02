import * as e from 'echarts';
const c = e.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
c.setOption({ series: [{ type: 'pie', data: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] }] });
console.log('svg length:', c.renderToSVGString().length);
