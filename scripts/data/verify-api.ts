import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [origin, expectedFile] = process.argv.slice(2);
if (!origin || !expectedFile) throw new Error("Usage: verify-api.ts <API origin> <import.expected.json>");
const expected = JSON.parse(await readFile(expectedFile,"utf8"));
async function get(path: string) {
  const response = await fetch(new URL(path,origin));
  assert.equal(response.status,200,path);
  return response.json();
}
const { datasets } = await get("/api/v1/datasets");
for (const dataset of expected.datasets) {
  assert.ok(datasets.find((d:{id:string})=>d.id===dataset.id));
  const wanted = expected.observations.filter((o:{dataset_version_id:string})=>o.dataset_version_id===dataset.id).sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));
  const found = []; let cursor = "";
  do {
    const page = await get(`/api/v1/datasets/${dataset.id}/observations?limit=137&after=${encodeURIComponent(cursor)}`);
    found.push(...page.observations); cursor=page.nextCursor;
  } while(cursor);
  assert.equal(found.length,wanted.length);
  for(let i=0;i<wanted.length;i++) for(const key of Object.keys(wanted[i])) assert.deepEqual(found[i][key],wanted[i][key],`${wanted[i].id}:${key}`);
}
for(const tile of expected.tiles) {
  const {tile:actual} = await get(`/api/v1/layers/${tile.dataset_version_id}?tile=${tile.id}`);
  assert.equal(actual.cells.length,tile.cells.length);
  // JSON float spellings may shorten; compare underlying float32 bit values.
  assert.deepEqual(new Float32Array(actual.cells.map((v:number|null)=>v??NaN)),new Float32Array(tile.cells.map((v:number|null)=>v??NaN)));
  assert.deepEqual(actual.cells.map((v:number|null)=>v===null),tile.cells.map((v:number|null)=>v===null));
  for(const [row,col] of [[0,0],[40,40],[tile.height-1,tile.width-1]]) {
    const sample = await get(`/api/v1/layers/${tile.dataset_version_id}/sample?tile=${tile.id}&row=${row}&col=${col}`);
    assert.equal(Math.fround(sample.value),Math.fround(tile.cells[row*tile.width+col]));
  }
  assert.equal((await fetch(new URL(`/api/v1/layers/${tile.dataset_version_id}/sample?tile=${tile.id}&row=${tile.height}&col=0`,origin))).status,400);
}
// The expected economic reference is derived from the actual observations just checked.
const ys=expected.observations.filter((o:{variable:string})=>o.variable==='yield');
const ws=expected.observations.filter((o:{variable:string})=>o.variable==='recorded_irrigation');
let dy=0,dw=0;
for(const year of [2003,2004,2005]) {
  const value=(rows:any[],program:string)=>rows.find(o=>o.dimensions.harvest_year===year&&o.dimensions.program===program).value;
  dy+=value(ys,'RDI')-value(ys,'C');dw+=(value(ws,'C')-value(ws,'RDI'))*10;
}
assert.ok(Math.abs(dy/3-(-986.6666666666666))<1e-7);
assert.ok(Math.abs(dw/3-537.3333333333333)<1e-7);
console.log(JSON.stringify({status:'passed',checks:['catalog','complete paginated observations','all float32 pixel values and masks','pixel sample bounds','CSIRO three-year reference'],observations:expected.observations.length,pixels:expected.tiles[0].cells.length}));
