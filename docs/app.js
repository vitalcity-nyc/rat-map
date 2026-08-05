/* Where the rats are — Vital City
   All numbers are produced by scripts/aggregate.py from NYC Open Data (see Methodology). */
'use strict';

const C = {
  black:'#050507', white:'#ffffff', cloud:'#dddddd', chartreuse:'#dde44c',
  orange:'#ff7c53', periwinkle:'#9b9fbc', rose:'#cea9be', magenta:'#e7466d',
  charcoal:'#707175', indigo:'#394882', cerulean:'#217ebe',
  bad1:'#fb693c', bad2:'#ed5236', bad3:'#e03a30', baddest:'#d2232a',
  ch20:'#f7f8dd', ch50:'#edefa8', or20:'#fde5dd', or50:'#fabcaa', cer50:'#90bfdf', cer20:'#d2e4f0'
};
const BOROS = ['MANHATTAN','BRONX','BROOKLYN','QUEENS','STATEN ISLAND'];
const BORO_LABEL = {MANHATTAN:'Manhattan', BRONX:'Bronx', BROOKLYN:'Brooklyn', QUEENS:'Queens', 'STATEN ISLAND':'Staten Island'};
const BORO_COLOR = {MANHATTAN:C.orange, BRONX:C.magenta, BROOKLYN:C.indigo, QUEENS:C.cerulean, 'STATEN ISLAND':C.periwinkle};
const fmt = n => n.toLocaleString('en-US');
const pct = (x, d=1) => (x>0?'+':'') + x.toFixed(d) + '%';

// verified policy timeline (see Methodology for sources)
const EVENTS = [
  {ym:'2020-03', label:'Pandemic begins'},
  {ym:'2023-04', label:'Rat czar named; 8 p.m. set-out'},
  {ym:'2023-09', label:'Food businesses containerize'},
  {ym:'2024-03', label:'All businesses containerize'},
  {ym:'2024-11', label:'Bins required, 1–9 unit homes'},
  {ym:'2025-06', label:'West Harlem fully containerized'}
];

if (new URLSearchParams(location.search).get('embed') === '1') {
  document.body.classList.add('embed');
  const post = () => parent.postMessage({type:'vc-embed-height', height: document.body.scrollHeight}, '*');
  window.addEventListener('load', post); new ResizeObserver(post).observe(document.body);
}

const load = f => fetch('data/' + f).then(r => { if(!r.ok) throw new Error(f+' '+r.status); return r.json(); });

Promise.all([
  load('summary.json'), load('geo_cd.json'), load('geo_nta.json'),
  load('hex.json'), load('points_recent.json'), load('cd.geojson'), load('nta.geojson')
]).then(main).catch(e => {
  document.getElementById('kpis').innerHTML = '<p style="color:#d2232a;font-weight:700">Data failed to load: ' + e.message + '</p>';
  throw e;
});

function main([S, CD, NTA, HEX, PTS, CDGJ, NTAGJ]) {

  // ---------- helpers over summary ----------
  const months = S.months, mc = S.monthly_city;
  const janjul = y => months.reduce((a,m,i) => a + (m.startsWith(String(y)) && +m.slice(5,7) <= 7 ? mc[i] : 0), 0);
  const jj26 = janjul(2026), jj25 = janjul(2025);
  const yoy26 = (jj26/jj25 - 1) * 100;
  const insp26 = S.insp_city_year['2026'];
  document.getElementById('data-through').textContent = new Date(S.last_data_date + 'T12:00:00')
    .toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});

  // ---------- KPIs ----------
  const chron1 = S.chronic[0];
  document.getElementById('kpis').innerHTML = [
    {n: fmt(jj26), l:'rat sightings reported, Jan.–Jul. 2026'},
    {n: pct(yoy26), l:'vs. Jan.–Jul. 2025 — the largest drop on record', cls:'down'},
    {n: (insp26[1]/insp26[0]*100).toFixed(1) + '%', l:'of 2026 initial inspections found rat signs (23% in 2022)'},
    {n: fmt(chron1.n), l:'reports in 3 years at ' + chron1.address + ', the Bronx'}
  ].map(k => `<div class="kpi"><div class="n ${k.cls||''}">${k.n}</div><div class="l">${k.l}</div></div>`).join('');

  // ---------- SVG chart helpers ----------
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (w,h) => { const s = document.createElementNS(NS,'svg'); s.setAttribute('viewBox',`0 0 ${w} ${h}`); return s; };
  const put = (parent, tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e); return e;
  };
  const T = {sz:13, fam:'halyard-text, Inter, Arial, sans-serif'};
  const txt = (p, x, y, str, o={}) => put(p, 'text', {x, y, fill:o.fill||C.charcoal, 'font-size':o.size||T.sz,
    'font-weight':o.weight||300, 'font-family':T.fam, 'text-anchor':o.anchor||'start', ...(o.attrs||{})}, str);
  const grid = (p, x0, x1, yScale, ticks, labfmt) => {
    ticks.forEach(v => {
      const y = yScale(v);
      put(p,'line',{x1:x0, x2:x1, y1:y, y2:y, stroke:C.cloud, 'stroke-width':1});
      txt(p, x0-8, y+4, labfmt ? labfmt(v) : fmt(v), {anchor:'end', size:12});
    });
  };

  // ---------- trend chart ----------
  const trendBox = document.getElementById('trend-chart');
  let trendView = 'city', perCap = false;
  const boroPop = S.boro_pop2020;
  const roll12 = arr => arr.map((_,i) => i < 11 ? null : arr.slice(i-11,i+1).reduce((a,b)=>a+b,0)/12);

  function renderTrend() {
    trendBox.innerHTML = '';
    const W=1000, H=440, L=64, R=20, TOP=24, B=46;
    const svg = svgEl(W,H); trendBox.appendChild(svg);
    const x = i => L + (W-L-R) * i / (months.length-1);
    let series, maxV;
    if (trendView === 'city') {
      series = [{vals: mc, color: C.orange, label: null}];
      maxV = Math.max(...mc);
    } else {
      series = BOROS.map(b => {
        let v = S.monthly_boro[b];
        if (perCap) v = v.map(n => n / boroPop[BORO_LABEL[b]] * 100000);
        return {vals: roll12(v), color: BORO_COLOR[b], label: BORO_LABEL[b]};
      });
      maxV = Math.max(...series.flatMap(s => s.vals.filter(v => v != null)));
    }
    const y = v => TOP + (H-TOP-B) * (1 - v / (maxV*1.06));
    const step = maxV > 2000 ? 500 : maxV > 800 ? 200 : maxV > 200 ? 50 : maxV > 40 ? 10 : 5;
    const ticks = []; for (let v=0; v<=maxV*1.02; v+=step) ticks.push(v);
    grid(svg, L, W-R, y, ticks, v => perCap && trendView==='boro' ? v : fmt(v));
    // x labels: every 2 years
    for (let yr=2010; yr<=2026; yr+=2) {
      const i = months.indexOf(yr+'-01'); if (i<0) continue;
      txt(svg, x(i), H-B+20, String(yr), {anchor:'middle', size:12});
      put(svg,'line',{x1:x(i),x2:x(i),y1:H-B,y2:H-B+5,stroke:C.charcoal,'stroke-width':1});
    }
    put(svg,'line',{x1:L,x2:W-R,y1:y(0),y2:y(0),stroke:C.black,'stroke-width':1.2});
    // event annotations
    EVENTS.forEach(ev => {
      const i = months.indexOf(ev.ym); if (i<0) return;
      const ex = x(i);
      put(svg,'line',{x1:ex,x2:ex,y1:TOP+6,y2:y(0),stroke:C.charcoal,'stroke-width':1,'stroke-dasharray':'2 3'});
      txt(svg, 0, 0, ev.label, {size:11, fill:C.charcoal,
        attrs:{transform:`translate(${ex-4},${TOP+10}) rotate(90)`}});
    });
    series.forEach(s => {
      let d = '';
      s.vals.forEach((v,i) => { if (v==null) return; d += (d?'L':'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
      put(svg,'path',{d, fill:'none', stroke:s.color, 'stroke-width': trendView==='city'?2:2.2, 'stroke-linejoin':'round'});
    });
    if (trendView === 'boro') {
      let lx = L+10;
      series.forEach(s => {
        put(svg,'rect',{x:lx, y:TOP-14, width:16, height:5, fill:s.color});
        const t = txt(svg, lx+21, TOP-8, s.label, {size:12.5, weight:700, fill:C.black});
        lx += 21 + s.label.length*7.2 + 24;
      });
    } else {
      // label the peak
      const mi = mc.indexOf(Math.max(...mc));
      txt(svg, x(mi), y(mc[mi])-8, months[mi].slice(0,4)+'-'+months[mi].slice(5)+': '+fmt(mc[mi]), {anchor:'middle', size:12, weight:700, fill:C.orange});
    }
    txt(svg, L, H-6, trendView==='boro' ? (perCap?'12-month rolling average per 100,000 residents':'12-month rolling average') : 'Sightings per month', {size:11.5});
  }
  renderTrend();
  document.getElementById('trend-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    trendView = b.dataset.view;
    document.querySelectorAll('#trend-seg button').forEach(x => x.classList.toggle('on', x===b));
    document.getElementById('rate-toggle-wrap').style.display = trendView==='boro' ? '' : 'none';
    renderTrend();
  });
  document.getElementById('rate-toggle').addEventListener('change', e => { perCap = e.target.checked; renderTrend(); });

  // ---------- inspections combo ----------
  (function() {
    const box = document.getElementById('insp-chart');
    const W=1000, H=420, L=64, R=64, TOP=30, B=60;
    const svg = svgEl(W,H); box.appendChild(svg);
    const years = S.years;
    const yearly = years.map(yr => months.reduce((a,m,i)=> a + (m.startsWith(String(yr)) ? mc[i] : 0), 0));
    const maxB = Math.max(...yearly);
    const yB = v => TOP + (H-TOP-B) * (1 - v/(maxB*1.1));
    const rates = years.map(yr => { const v = S.insp_city_year[String(yr)]; return v && v[0]>1000 ? v[1]/v[0]*100 : null; });
    const maxR = Math.max(...rates.filter(v=>v!=null));
    const yR = v => TOP + (H-TOP-B) * (1 - v/(maxR*1.25));
    const bw = (W-L-R)/years.length;
    grid(svg, L, W-R, yB, [0,10000,20000,30000,40000].filter(v=>v<=maxB*1.1));
    years.forEach((yr,i) => {
      const bx = L + i*bw + bw*0.12;
      put(svg,'rect',{x:bx, y:yB(yearly[i]), width:bw*0.76, height:yB(0)-yB(yearly[i]),
        fill: yr===2026 ? C.ch50 : C.chartreuse, stroke:'none'});
      txt(svg, L+i*bw+bw/2, H-B+20, String(yr).slice(2), {anchor:'middle', size:12});
    });
    txt(svg, L, H-B+38, 'Bars: 311 rat sightings per year (2026 through Aug. 4)', {size:12});
    put(svg,'rect',{x:L+330, y:H-B+30, width:14, height:10, fill:C.chartreuse});
    // rate line
    let d='';
    years.forEach((yr,i) => { if (rates[i]==null) return; const px = L+i*bw+bw/2;
      d += (d?'L':'M') + px.toFixed(1) + ' ' + yR(rates[i]).toFixed(1); });
    put(svg,'path',{d, fill:'none', stroke:C.orange, 'stroke-width':2.5, 'stroke-linejoin':'round'});
    years.forEach((yr,i) => {
      if (rates[i]==null) return;
      const px = L+i*bw+bw/2;
      put(svg,'circle',{cx:px, cy:yR(rates[i]), r:3.2, fill:C.orange});
      if (yr%2===0 || yr===2025)
        txt(svg, px, yR(rates[i])-10, rates[i].toFixed(1)+'%', {anchor:'middle', size:11.5, weight:700, fill:C.orange});
    });
    txt(svg, W-R, TOP-10, 'Line: share of initial inspections finding rat signs', {anchor:'end', size:12, weight:700, fill:C.orange});
    put(svg,'line',{x1:L,x2:W-R,y1:yB(0),y2:yB(0),stroke:C.black,'stroke-width':1.2});
  })();

  // ---------- seasonality + hour ----------
  (function() {
    const monthsN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const tot = Array(12).fill(0), cnt = Array(12).fill(0);
    months.forEach((m,i) => { const yr=+m.slice(0,4), mo=+m.slice(5,7)-1; if (yr<=2025){ tot[mo]+=mc[i]; cnt[mo]++; }});
    const avg = tot.map((t,i)=>t/cnt[i]);
    barChart('season-chart', monthsN, avg, {hl: avg.indexOf(Math.max(...avg)), fmtv: v=>Math.round(v).toLocaleString(), note:'Average sightings per month'});
    const hrs = S.hourly;
    barChart('hour-chart', hrs.map((_,h)=> h%3===0 ? (h===0?'12a':h<12?h+'a':h===12?'12p':(h-12)+'p') : ''), hrs,
      {hl: hrs.indexOf(Math.max(...hrs)), fmtv: v=>fmt(v), note:'Sightings by hour filed', sparseLabels:true, labelEvery:3});
  })();
  function barChart(id, labels, vals, opt) {
    const box = document.getElementById(id); box.innerHTML='';
    const W=560, H=330, L=52, R=8, TOP=18, B=40;
    const svg = svgEl(W,H); box.appendChild(svg);
    const maxV = Math.max(...vals);
    const y = v => TOP + (H-TOP-B)*(1-v/(maxV*1.12));
    const bw = (W-L-R)/vals.length;
    vals.forEach((v,i) => {
      put(svg,'rect',{x:L+i*bw+bw*0.1, y:y(v), width:bw*0.8, height:y(0)-y(v), fill: i===opt.hl ? C.orange : C.chartreuse});
      if (!opt.sparseLabels || i===opt.hl)
        txt(svg, L+i*bw+bw/2, y(v)-6, opt.fmtv(v), {anchor:'middle', size:10.5, weight: i===opt.hl?700:300, fill: i===opt.hl?C.orange:C.charcoal});
      if (labels[i]) txt(svg, L+i*bw+bw/2, H-B+18, labels[i], {anchor:'middle', size:11});
    });
    put(svg,'line',{x1:L,x2:W-R,y1:y(0),y2:y(0),stroke:C.black,'stroke-width':1.2});
    txt(svg, L, H-6, opt.note, {size:11});
  }

  // ---------- heat calendar ----------
  (function() {
    const box = document.getElementById('calendar-chart');
    const years = S.years;
    const W=1000, cell=Math.floor((W-140)/12), ch=26, H=years.length*ch+60;
    const svg = svgEl(W,H); box.appendChild(svg);
    const maxV = Math.max(...mc);
    const ramp = v => {
      if (v===0) return '#ffffff';
      const t = Math.pow(v/maxV, 0.7);
      return t<0.25 ? C.ch20 : t<0.45 ? C.chartreuse : t<0.62 ? C.orange : t<0.8 ? C.bad2 : C.baddest;
    };
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((m,i)=>
      txt(svg, 100+i*cell+cell/2, 16, m, {anchor:'middle', size:11.5, weight:700}));
    years.forEach((yr,r) => {
      txt(svg, 90, 26+r*ch+ch/2+4, String(yr), {anchor:'end', size:12.5, weight:700, fill:C.black});
      for (let mo=0; mo<12; mo++) {
        const key = yr + '-' + String(mo+1).padStart(2,'0');
        const i = months.indexOf(key);
        const v = i>=0 ? mc[i] : null;
        const g = put(svg,'rect',{x:100+mo*cell, y:26+r*ch, width:cell-2, height:ch-2,
          fill: v==null ? '#ffffff' : ramp(v), stroke: v==null ? C.cloud : 'none', 'stroke-dasharray': v==null?'2 2':'none'});
        if (v!=null) put(g,'title',{},''), g.appendChild(Object.assign(document.createElementNS(NS,'title'),{textContent:`${key}: ${fmt(v)} sightings`}));
      }
    });
    // legend
    const ly = H-22;
    txt(svg, 100, ly+9, 'Fewer', {size:11});
    [C.ch20, C.chartreuse, C.orange, C.bad2, C.baddest].forEach((c,i)=>
      put(svg,'rect',{x:145+i*30, y:ly, width:28, height:12, fill:c}));
    txt(svg, 145+5*30+6, ly+9, `More (peak month: ${fmt(maxV)})`, {size:11});
  })();

  // ---------- location types ----------
  (function() {
    const box = document.getElementById('loctype-chart');
    const groups = [
      {label:'Apartment buildings (3+ families)', keys:['3+ Family Apt. Building','3+ Family Mixed Use Building'], color:C.indigo},
      {label:'1–2 family homes', keys:['1-2 Family Dwelling','1-2 Family Mixed Use Building'], color:C.cerulean},
      {label:'Commercial buildings', keys:['Commercial Building'], color:C.periwinkle},
      {label:'Vacant lots & buildings', keys:['Vacant Lot','Vacant Building'], color:C.rose},
      {label:'Construction sites', keys:['Construction Site'], color:C.magenta},
      {label:'Other / unspecified', keys:['Other (Explain Below)','All other'], color:C.cloud}
    ];
    const years = S.years;
    const gv = groups.map(g => years.map((_,i) => g.keys.reduce((a,k)=> a + (S.loctype_year[k] ? S.loctype_year[k][i] : 0), 0)));
    const totals = years.map((_,i)=> gv.reduce((a,s)=>a+s[i],0));
    const W=1000, H=430, L=56, R=16, TOP=46, B=40;
    const svg = svgEl(W,H); box.appendChild(svg);
    const x = i => L + (W-L-R)*i/(years.length-1);
    const y = f => TOP + (H-TOP-B)*(1-f);
    [0,25,50,75,100].forEach(p => {
      put(svg,'line',{x1:L,x2:W-R,y1:y(p/100),y2:y(p/100),stroke:C.cloud});
      txt(svg, L-8, y(p/100)+4, p+'%', {anchor:'end', size:12});
    });
    let base = years.map(()=>0);
    groups.forEach((g,gi) => {
      let top = base.map((b,i)=> b + gv[gi][i]/totals[i]);
      let d = '';
      years.forEach((_,i)=> d += (i?'L':'M') + x(i).toFixed(1)+' '+y(top[i]).toFixed(1));
      for (let i=years.length-1;i>=0;i--) d += 'L'+x(i).toFixed(1)+' '+y(base[i]).toFixed(1);
      put(svg,'path',{d:d+'Z', fill:g.color, 'fill-opacity':0.92, stroke:C.white, 'stroke-width':0.6});
      base = top;
    });
    for (let yr=2010; yr<=2026; yr+=2) {
      const i = years.indexOf(yr);
      txt(svg, x(i), H-B+20, String(yr), {anchor:'middle', size:12});
    }
    let lx=L;
    groups.forEach(g => {
      put(svg,'rect',{x:lx, y:12, width:13, height:13, fill:g.color});
      txt(svg, lx+18, 23, g.label, {size:12, weight:700, fill:C.black});
      lx += 18 + g.label.length*6.6 + 22;
    });
  })();

  // ---------- chronic table ----------
  (function() {
    const rowsHtml = ['<tr><th></th><th>Address</th><th>Borough</th><th class="num">Reports</th></tr>'];
    const maxN = S.chronic[0].n;
    S.chronic.slice(0,12).forEach((c,i) => {
      rowsHtml.push(`<tr><td class="num" style="color:var(--vc-charcoal)">${i+1}</td>
        <td><b>${c.address}</b></td><td>${c.borough === 'Staten island' ? 'Staten Island' : c.borough}</td>
        <td class="num"><span class="bar" style="width:${Math.round(c.n/maxN*90)}px"></span><b>${fmt(c.n)}</b></td></tr>`);
    });
    document.getElementById('chronic-tbl').innerHTML = rowsHtml.join('');
  })();

  // ---------- NTA per-capita ranking ----------
  (function() {
    const rows = [];
    for (const [nid, d] of Object.entries(NTA)) {
      if (d.type !== '0' || !d.pop || d.pop < 5000) continue;
      const n = d.janjul['2026'] || 0;
      rows.push({name:d.name, borough:d.borough, n, rate: n/d.pop*10000});
    }
    rows.sort((a,b)=>b.rate-a.rate);
    const maxR = rows[0].rate;
    const html = ['<tr><th></th><th>Neighborhood</th><th>Borough</th><th class="num">Per 10k</th><th class="num">Sightings</th></tr>'];
    rows.slice(0,12).forEach((r,i) => html.push(
      `<tr><td class="num" style="color:var(--vc-charcoal)">${i+1}</td><td><b>${r.name}</b></td><td>${r.borough}</td>
       <td class="num"><span class="bar" style="width:${Math.round(r.rate/maxR*70)}px"></span><b>${r.rate.toFixed(1)}</b></td>
       <td class="num">${fmt(r.n)}</td></tr>`));
    document.getElementById('rank-tbl').innerHTML = html.join('');
  })();

  // ================= MAP =================
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { carto: { type:'raster',
        tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'],
        tileSize: 256, attribution:'© CARTO © OpenStreetMap contributors' } },
      layers: [{ id:'carto', type:'raster', source:'carto' }]
    },
    center: [-73.925, 40.7], zoom: 9.9, minZoom: 8.5, maxZoom: 16, attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl({showCompass:false}), 'top-left');
  window._map = map;

  let geo = 'hex', metric = 'count', year = 2026, playing = null;
  const yearSlider = document.getElementById('year-slider');
  const yearLabel = document.getElementById('year-label');

  // hex geojson with per-year props
  const hexFeatures = HEX.cells.map(c => {
    const [ilat, ilon] = c;
    const lat0 = ilat*HEX.lat_step, lon0 = ilon*HEX.lon_step;
    const props = {};
    let tot = 0;
    HEX.years.forEach((y,i) => { props['y'+y] = c[2+i]; tot += c[2+i]; });
    props.tot = tot;
    return { type:'Feature', properties: props, geometry: { type:'Polygon', coordinates: [[
      [lon0,lat0],[lon0+HEX.lon_step,lat0],[lon0+HEX.lon_step,lat0+HEX.lat_step],[lon0,lat0+HEX.lat_step],[lon0,lat0]
    ]]}};
  });

  // dots geojson
  const dotFeatures = PTS.map(p => ({type:'Feature', properties:{m:p[2]},
    geometry:{type:'Point', coordinates:[p[1], p[0]]}}));

  // enrich polygon geojson with lookup keys
  CDGJ.features.forEach(f => { f.properties.id = String(f.properties.boro_cd); });
  NTAGJ.features.forEach(f => { f.properties.id = f.properties.nta2020; });

  const JJ = (d, y) => d.janjul[String(y)] || 0;
  function polyValue(id, d, met, y) {
    if (met === 'count') return geo==='cd' ? yearCount(d) : (d.yearly[String(y)] || 0);
    if (met === 'rate') { const n = geo==='cd' ? yearCount(d) : (d.yearly[String(y)]||0); return d.pop ? n/d.pop*10000 : null; }
    if (met === 'yoy') { const a = JJ(d, year), b = JJ(d, year-1); return b >= 5 ? (a/b-1)*100 : null; }
    if (met === 'insp') { const v = d.insp[String(y)]; return v && v[0] >= 20 ? v[1]/v[0]*100 : null; }
    function yearCount(d) { // CD stores monthly
      return months.reduce((a,m,i)=> a + (m.startsWith(String(y)) ? d.monthly[i] : 0), 0);
    }
  }

  function quantBreaks(vals, n=5) {
    const v = vals.filter(x => x!=null && x>0).sort((a,b)=>a-b);
    if (!v.length) return [1,2,3,4];
    const q = p => v[Math.min(v.length-1, Math.floor(p*v.length))];
    let br = [q(0.35), q(0.6), q(0.8), q(0.93)];
    // dedupe ascending
    for (let i=1;i<br.length;i++) if (br[i]<=br[i-1]) br[i]=br[i-1]+ (Number.isInteger(br[0])?1:0.1);
    return br;
  }
  const SEQ = [C.ch20, C.chartreuse, C.orange, C.bad2, C.baddest];
  const YOY_BR = [-50,-25,0,25,100];
  const YOY_COL = [C.cerulean, C.cer50, C.cer20, C.or50, C.bad1, C.baddest];
  const INSP_BR = [5,10,15,20,30];
  const INSP_COL = ['#eef0f6','#c9cdde','#9b9fbc','#6a719f','#394882','#20294f'];

  function paintPolys(srcId, gjData, lookup) {
    const vals = [];
    gjData.features.forEach(f => {
      const d = lookup[f.properties.id];
      const v = d ? polyValue(f.properties.id, d, metric, year) : null;
      f.properties.val = v; vals.push(v);
    });
    let expr, legendRows;
    if (metric === 'yoy') {
      expr = stepExpr(YOY_BR, YOY_COL);
      legendRows = bandLabels(YOY_BR, YOY_COL, v => pct(v,0));
    } else if (metric === 'insp') {
      expr = stepExpr(INSP_BR, INSP_COL);
      legendRows = bandLabels(INSP_BR, INSP_COL, v => v+'%');
    } else {
      const br = quantBreaks(vals);
      expr = stepExpr(br, SEQ);
      legendRows = bandLabels(br, SEQ, v => metric==='rate' ? v.toFixed(1) : fmt(Math.round(v)));
    }
    map.getSource(srcId).setData(gjData);
    map.setPaintProperty(srcId+'-fill', 'fill-color',
      ['case', ['==', ['get','val'], null], 'rgba(200,200,200,0.35)', expr]);
    renderLegend(legendRows);
  }
  const stepExpr = (br, cols) => ['step', ['to-number',['get','val'], -9999], cols[0],
    ...br.flatMap((b,i)=>[b, cols[i+1]])];
  function bandLabels(br, cols, f) {
    const rows = [];
    rows.push({c: cols[0], t: '< ' + f(br[0])});
    for (let i=0;i<br.length-1;i++) rows.push({c: cols[i+1], t: f(br[i]) + ' – ' + f(br[i+1])});
    rows.push({c: cols[cols.length-1], t: '≥ ' + f(br[br.length-1])});
    rows.push({c:'rgba(200,200,200,0.35)', t: metric==='yoy' ? 'Too few sightings' : metric==='insp' ? 'Too few inspections' : 'No data'});
    return rows;
  }

  function renderLegend(rows) {
    const titles = {count: geo==='hex' ? `Sightings per block, ${yearText()}` : `Sightings, ${yearText()}`,
      rate:`Sightings per 10,000 residents, ${yearText()}`,
      yoy:`Change, Jan.–Jul. ${year} vs. ${year-1}`, insp:`Inspections finding rat signs, ${yearText()}`};
    document.getElementById('legend').innerHTML = '<div class="lt">' +
      (geo==='dots' ? 'Every sighting, Aug. 2025 – Jul. 2026' : titles[metric]) + '</div>' +
      (geo==='dots' ? '<div class="lrow"><span class="sw" style="background:#e7466d;border-radius:50%"></span> One reported rat sighting</div>'
        : rows.map(r=>`<div class="lrow"><span class="sw" style="background:${r.c}"></span> ${r.t}</div>`).join(''));
  }
  const yearText = () => year===2026 ? '2026 (through Aug. 4)' : String(year);

  function paintHex() {
    const p = 'y'+year;
    map.setFilter('hex-fill', ['>', ['get', p], 0]);
    const br = [2,4,8,15];
    map.setPaintProperty('hex-fill','fill-color', ['step', ['get', p], SEQ[0], 2, SEQ[1], 4, SEQ[2], 8, SEQ[3], 15, SEQ[4]]);
    renderLegend([{c:SEQ[0],t:'1'},{c:SEQ[1],t:'2 – 3'},{c:SEQ[2],t:'4 – 7'},{c:SEQ[3],t:'8 – 14'},{c:SEQ[4],t:'15+'}]);
  }

  map.on('load', () => {
    map.addSource('hex', {type:'geojson', data:{type:'FeatureCollection', features:hexFeatures}});
    map.addLayer({id:'hex-fill', type:'fill', source:'hex',
      paint:{'fill-color':C.chartreuse, 'fill-opacity':0.78, 'fill-outline-color':'rgba(0,0,0,0)'}});
    map.addSource('nta', {type:'geojson', data:NTAGJ});
    map.addLayer({id:'nta-fill', type:'fill', source:'nta', layout:{visibility:'none'},
      paint:{'fill-color':'#fff', 'fill-opacity':0.78}});
    map.addLayer({id:'nta-line', type:'line', source:'nta', layout:{visibility:'none'},
      paint:{'line-color':'#ffffff', 'line-width':0.8}});
    map.addSource('cd', {type:'geojson', data:CDGJ});
    map.addLayer({id:'cd-fill', type:'fill', source:'cd', layout:{visibility:'none'},
      paint:{'fill-color':'#fff', 'fill-opacity':0.78}});
    map.addLayer({id:'cd-line', type:'line', source:'cd', layout:{visibility:'none'},
      paint:{'line-color':'#ffffff', 'line-width':1}});
    map.addSource('dots', {type:'geojson', data:{type:'FeatureCollection', features:dotFeatures}});
    map.addLayer({id:'dots-pts', type:'circle', source:'dots', layout:{visibility:'none'},
      paint:{'circle-color':C.magenta, 'circle-opacity':0.5,
        'circle-radius':['interpolate',['linear'],['zoom'], 9, 1.6, 12, 3.4, 15, 7],
        'circle-stroke-width':0}});
    refresh();
  });

  function refresh() {
    if (!map.getSource('hex')) return;
    ['hex-fill'].forEach(l => map.setLayoutProperty(l,'visibility', geo==='hex'?'visible':'none'));
    ['nta-fill','nta-line'].forEach(l => map.setLayoutProperty(l,'visibility', geo==='nta'?'visible':'none'));
    ['cd-fill','cd-line'].forEach(l => map.setLayoutProperty(l,'visibility', geo==='cd'?'visible':'none'));
    ['dots-pts'].forEach(l => map.setLayoutProperty(l,'visibility', geo==='dots'?'visible':'none'));
    if (geo === 'hex') paintHex();
    else if (geo === 'nta') paintPolys('nta', NTAGJ, NTA);
    else if (geo === 'cd') paintPolys('cd', CDGJ, CD);
    else renderLegend([]);
    // controls state
    const metricButtons = document.querySelectorAll('#metric-seg button');
    metricButtons.forEach(b => {
      const m = b.dataset.metric;
      const ok = geo==='nta' || geo==='cd' || (geo==='hex' && m==='count');
      b.disabled = !ok || geo==='dots';
    });
    const yearDisabled = geo==='dots';
    yearSlider.disabled = yearDisabled;
    yearSlider.min = metric==='yoy' ? 2011 : 2010;
    yearLabel.textContent = yearDisabled ? '—' : (metric==='yoy' ? `’${String(year-1).slice(2)}→’${String(year).slice(2)}` : year);
    hideDetail();
  }

  document.getElementById('geo-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b) return;
    geo = b.dataset.geo;
    if (geo==='hex' || geo==='dots') { metric='count';
      document.querySelectorAll('#metric-seg button').forEach(x=>x.classList.toggle('on', x.dataset.metric==='count')); }
    document.querySelectorAll('#geo-seg button').forEach(x=>x.classList.toggle('on', x===b));
    refresh();
  });
  document.getElementById('metric-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b || b.disabled) return;
    metric = b.dataset.metric;
    if (metric==='yoy' && year<2011) year=2011, yearSlider.value=2011;
    document.querySelectorAll('#metric-seg button').forEach(x=>x.classList.toggle('on', x===b));
    refresh();
  });
  yearSlider.addEventListener('input', () => { year = +yearSlider.value; refresh(); });
  document.getElementById('play').addEventListener('click', function() {
    if (playing) { clearInterval(playing); playing=null; this.textContent='▶'; return; }
    this.textContent='⏸';
    let y = year >= 2026 ? (+yearSlider.min) : year;
    playing = setInterval(() => {
      yearSlider.value = y; year = y; refresh();
      if (y >= 2026) { clearInterval(playing); playing=null; document.getElementById('play').textContent='▶'; }
      y++;
    }, 900);
  });

  // tooltip
  const tip = document.getElementById('map-tip');
  const shell = document.querySelector('.map-shell');
  function showTip(e, html) {
    tip.innerHTML = html; tip.style.display='block';
    const r = shell.getBoundingClientRect();
    let tx = e.originalEvent.clientX - r.left + 14, ty = e.originalEvent.clientY - r.top - 10;
    if (tx > r.width-260) tx -= 280;
    tip.style.left = tx+'px'; tip.style.top = ty+'px';
  }
  map.on('mousemove', e => {
    const layers = geo==='hex'?['hex-fill'] : geo==='nta'?['nta-fill'] : geo==='cd'?['cd-fill'] : ['dots-pts'];
    if (!map.getLayer(layers[0])) return;
    const fs = map.queryRenderedFeatures(e.point, {layers});
    if (!fs.length) { tip.style.display='none'; map.getCanvas().style.cursor=''; return; }
    map.getCanvas().style.cursor = (geo==='nta'||geo==='cd') ? 'pointer' : '';
    const f = fs[0];
    if (geo==='hex') {
      const v = f.properties['y'+year];
      showTip(e, `<div class="t-name">${fmt(v)} sighting${v===1?'':'s'} on this block</div><div class="t-val">${yearText()} · all years: ${fmt(f.properties.tot)}</div>`);
    } else if (geo==='dots') {
      showTip(e, `<div class="t-name">Rat sighting</div><div class="t-val">reported ${f.properties.m}</div>`);
    } else {
      const d = (geo==='nta'?NTA:CD)[f.properties.id];
      if (!d) return;
      const v = f.properties.val;
      const name = geo==='nta' ? d.name : d.name;
      const vt = v==null ? 'insufficient data' :
        metric==='count' ? fmt(Math.round(v))+' sightings, '+yearText() :
        metric==='rate' ? v.toFixed(1)+' per 10k residents, '+yearText() :
        metric==='yoy' ? pct(v,0)+` Jan.–Jul. ${year} vs. ${year-1}` :
        v.toFixed(1)+'% of inspections found rat signs, '+yearText();
      showTip(e, `<div class="t-name">${name}</div><div class="t-val">${vt}</div>`);
    }
  });
  map.on('mouseout', () => tip.style.display='none');

  // detail panel
  const detail = document.getElementById('detail');
  function hideDetail(){ detail.style.display='none'; }
  document.addEventListener('click', e => { if (e.target.classList && e.target.classList.contains('d-close')) hideDetail(); });
  map.on('click', e => {
    if (geo!=='nta' && geo!=='cd') return;
    const fs = map.queryRenderedFeatures(e.point, {layers:[geo+'-fill']});
    if (!fs.length) { hideDetail(); return; }
    const id = fs[0].properties.id;
    const d = (geo==='nta'?NTA:CD)[id];
    if (!d) return;
    const yearly = S.years.map(yr => geo==='nta' ? (d.yearly[String(yr)]||0)
      : months.reduce((a,m,i)=> a + (m.startsWith(String(yr)) ? d.monthly[i] : 0), 0));
    const cur = yearly[S.years.indexOf(year)] || 0;
    const jjA = JJ(d, 2026), jjB = JJ(d, 2025);
    const insp = d.insp[String(year===2026?2026:year)];
    const stats = [
      {n: fmt(cur), l: 'sightings, ' + (year===2026?'2026 YTD':year)},
      {n: d.pop ? (cur/d.pop*10000).toFixed(1) : '—', l: 'per 10k residents'},
      {n: jjB>=5 ? pct((jjA/jjB-1)*100,0) : '—', l: 'Jan–Jul ’26 vs ’25'},
      {n: insp && insp[0]>=20 ? (insp[1]/insp[0]*100).toFixed(0)+'%' : '—', l: 'inspections w/ rat signs'}
    ];
    // sparkline
    const w=260, h=64, bw2=w/yearly.length;
    const maxY = Math.max(...yearly, 1);
    let bars = '';
    yearly.forEach((v,i)=> {
      const bh = Math.round(v/maxY*(h-4));
      const col = S.years[i]===year ? C.orange : C.chartreuse;
      bars += `<rect x="${(i*bw2+1).toFixed(1)}" y="${h-bh}" width="${(bw2-2).toFixed(1)}" height="${bh}" fill="${col}"></rect>`;
    });
    detail.innerHTML = `<button class="d-close">✕</button>
      <div class="d-name">${d.name}</div>
      <div class="d-sub">${geo==='nta' ? d.borough : ''} ${d.pop ? '· pop. '+fmt(d.pop) : '· park/airport area'}</div>
      <div class="d-stats">${stats.map(s=>`<div class="d-stat"><div class="n">${s.n}</div><div class="l">${s.l}</div></div>`).join('')}</div>
      <div class="d-spark"><svg viewBox="0 0 ${w} ${h}" width="100%">${bars}</svg>
      <div class="d-spark-cap">Sightings per year, 2010–2026 (orange = selected year)</div></div>`;
    detail.style.display='block';
  });
}
