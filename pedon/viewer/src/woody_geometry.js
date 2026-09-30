// Shared mesh construction; species architecture and dimensions live in their builders.
import * as THREE from 'three';
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);

/** Compile immutable piecewise-cubic curves through THREE's own evaluator.
 * The same curve and arc-length samples are retained. We avoid recomputing
 * centripetal coefficients hundreds of times for each tiny botanical shoot.
 */
export function compileStaticCurve(curve){
 const evaluate=curve.getPoint.bind(curve),segments=curve.points.length-1,coefficients=[];
 if(curve.closed)throw new Error('Static botanical curves must be open');
 for(let k=0;k<segments;k++){
  const samples=[0,1/3,2/3,1].map(t=>evaluate((k+t)/segments)),axes=[];
  for(const axis of ['x','y','z']){
   const [a,b,c,d]=samples.map(p=>p[axis]);
   axes.push([a,(-11*a+18*b-9*c+2*d)/2,9*a-22.5*b+18*c-4.5*d,(-9*a+27*b-27*c+9*d)/2]);
  }
  coefficients.push(axes);
 }
 curve.getPoint=(t,target=V())=>{
  const p=t*segments,k=Math.min(segments-1,Math.floor(p)),u=p-k,axes=coefficients[k];
  const x=axes[0],y=axes[1],z=axes[2];
  return target.set(((x[3]*u+x[2])*u+x[1])*u+x[0],((y[3]*u+y[2])*u+y[1])*u+y[0],((z[3]*u+z[2])*u+z[1])*u+z[0]);
 };
 // Retain THREE's sample count, accumulation order and cached array, while
 // reusing two points instead of allocating one vector for every arc sample.
 curve.getLengths=function(divisions=this.arcLengthDivisions){
  if(this.cacheArcLengths&&this.cacheArcLengths.length===divisions+1&&!this.needsUpdate)return this.cacheArcLengths;
  this.needsUpdate=false;const lengths=new Array(divisions+1);lengths[0]=0;let last=this.getPoint(0),current=V(),sum=0;
  for(let p=1;p<=divisions;p++){
   this.getPoint(p/divisions,current);sum+=current.distanceTo(last);lengths[p]=sum;
   const swap=last;last=current;current=swap;
  }
  this.cacheArcLengths=lengths;return lengths;
 };
 return curve;
}

/** Stream transforms to packed buffers instead of retaining millions of
 * temporary Vector/Quaternion/Color records. No instance is omitted.
 */
export class InstanceTransforms{
 // Leaf-shape and aging banks often hold only a handful of organs. Grow the
 // same unlimited buffers on demand instead of reserving 1,024 for every bank.
 constructor(){this.length=0;this.capacity=32;this.matrices=new Float32Array(this.capacity*16);this.colors=new Float32Array(this.capacity*3);this.hasColors=false;this.matrix=new THREE.Matrix4();}
 // Optional allocation hint, never an organ limit. Larger inputs still grow.
 reserve(count){
  if(!Number.isSafeInteger(count)||count<0)throw new Error('Invalid instance reservation');
  if(count<=this.capacity)return;
  const matrices=new Float32Array(count*16),colors=new Float32Array(count*3);
  matrices.set(this.matrices.subarray(0,this.length*16));colors.set(this.colors.subarray(0,this.length*3));
  this.matrices=matrices;this.colors=colors;this.capacity=count;
 }
 push(p){
  if(this.length===this.capacity)this.reserve(this.capacity*2);
  // THREE's affine compose, written straight into the final packed storage.
  const q=p.q,x=q.x,y=q.y,z=q.z,w=q.w,x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2,s=p.scale,a=this.matrices,k=this.length*16;
  a[k]=(1-(yy+zz))*s.x;a[k+1]=(xy+wz)*s.x;a[k+2]=(xz-wy)*s.x;a[k+3]=0;
  a[k+4]=(xy-wz)*s.y;a[k+5]=(1-(xx+zz))*s.y;a[k+6]=(yz+wx)*s.y;a[k+7]=0;
  a[k+8]=(xz+wy)*s.z;a[k+9]=(yz-wx)*s.z;a[k+10]=(1-(xx+yy))*s.z;a[k+11]=0;
  a[k+12]=p.at.x;a[k+13]=p.at.y;a[k+14]=p.at.z;a[k+15]=1;
  if(p.color){this.hasColors=true;const k=this.length*3;this.colors[k]=p.color.r;this.colors[k+1]=p.color.g;this.colors[k+2]=p.color.b;}
  else {const k=this.length*3;this.colors[k]=this.colors[k+1]=this.colors[k+2]=1;}
  return ++this.length;
 }
}
export function surfaceGeometry(P,I,UV,C){
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setIndex(I);
 if(UV)g.setAttribute('uv',new THREE.Float32BufferAttribute(UV,2));
 if(C)g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));
 g.computeVertexNormals();return g;
}

/** Collapsed botanical tips still need a finite, unit glTF surface basis. */
export function surfaceTangents(g){
 const normal=g.attributes.normal,n=V(),t=V();
 for(let i=0;i<normal.count;i++){
  n.fromBufferAttribute(normal,i);
  if(n.lengthSq()<1e-12)normal.setXYZ(i,0,1,0);
 }
 g.computeTangents();
 const tangent=g.attributes.tangent;
 for(let i=0;i<tangent.count;i++){
  t.fromBufferAttribute(tangent,i);
  if(t.lengthSq()<1e-12){
   n.fromBufferAttribute(normal,i).normalize();
   t.crossVectors(n,Math.abs(n.y)>.9?V(0,0,1):V(0,1,0)).normalize();
   tangent.setXYZW(i,t.x,t.y,t.z,1);
  }
 }
 return g;
}

/** Tapered, gently flattened wood around a curved axis; UV length in metres. */
export function woodyBranch(path,r0,r1,phase=0,segmentLength=.045){
 if(!Number.isFinite(segmentLength)||segmentLength<=0)throw new RangeError('Botanical segment length must be positive and finite');
 const curve=new THREE.CatmullRomCurve3(path),length=curve.getLength(),S=Math.max(5,Math.ceil(length/segmentLength)),N=10;
 const frames=curve.computeFrenetFrames(S,false),P=[],UV=[],I=[],C=[];
 for(let i=0;i<=S;i++){
  const t=i/S,p=curve.getPointAt(t),rad=r0*(1-t)+r1*t;
  for(let j=0;j<=N;j++){
   const a=j/N*Math.PI*2,bulge=1+.07*Math.sin(t*8+phase)+.035*Math.sin(a*3+phase);
   const v=p.clone().addScaledVector(frames.normals[i],Math.cos(a)*rad*bulge).addScaledVector(frames.binormals[i],Math.sin(a)*rad*.85*bulge);
   P.push(...v.toArray());UV.push(j/N*(2*Math.PI*r0/.25)+phase,t*length/.25);
   const f=Math.min(1,.80+.15*t+.06*Math.sin(t*5+phase));C.push(f,f,f);
  }
 }
 for(let i=0;i<S;i++)for(let j=0;j<N;j++){const a=i*(N+1)+j,b=a+N+1;I.push(a,a+1,b,a+1,b+1,b);}
 // Closed rounded ends: exposed scaffold tips must not read as hollow pipes.
 for(const end of [0,1]){
  const t=end,rad=end?r1:r0,center=curve.getPointAt(t).addScaledVector(curve.getTangentAt(t),(end?1:-1)*rad*.45),index=P.length/3;
  P.push(...center.toArray());UV.push(phase+.5,t*length/.25);C.push(.9,.9,.9);
  const ring=end*S*(N+1);
  for(let j=0;j<N;j++)if(end)I.push(ring+j,ring+j+1,index);else I.push(ring+j+1,ring+j,index);
 }
 return {geometry:surfaceGeometry(P,I,UV,C),curve};
}
// ── LEVEL OF DETAIL ──────────────────────────────────────────────────────────
//
// The botanical builders model organs at macro-photography fidelity, which is
// correct: compare.html shows ONE plant and that is where they were validated.
// Rendered as a GARDEN they are not affordable and not even visible. Measured on
// a real 139-plant design: 79,500 M triangles, a single Ceanothus contributing
// 21,900 M from 11.6 M instances. The WebGL context is lost rather than merely
// slow, and it can take the browser's whole GPU process with it.
//
// The arithmetic that decides everything: at the viewer's ~1849 px and a 45 deg
// field of view, one pixel spans 6.9 mm of garden at 10 m and 3.5 mm at 5 m. So
//
//   a 0.3 mm leaf hair       cannot reach a pixel from anywhere in the garden
//   a 3 mm ceanothus floret  is under half a pixel at 10 m
//   a 60 mm panicle          is ~9 px — THIS is the unit the eye resolves
//
// Every organ smaller than about a pixel is paid for in full and contributes
// nothing but aliasing. `renderQuality` alone is a binary switch between
// simplified builders and the inspection model, and neither is distance-aware;
// this is the distance-aware level of detail.
//
// It lives HERE because every botanical module stamps its organs through
// instanceBatch, and it already receives the semantic class name. No species
// builder changes, no plant is redesigned, and inspection keeps every hair.

let detailMode = 'inspection';

/** 'garden' thins organs to what resolves at garden distance; 'inspection'
 *  keeps everything, and is the default so compare.html and the exporters are
 *  unaffected by merely importing this module. */
export function setBotanicalDetail(mode){
 detailMode = mode === 'garden' ? 'garden' : 'inspection';
 return detailMode;
}

// Surface finish: real, and sub-pixel at every distance a garden is seen from.
// Matched on the class name the builder already passes, because that is the only
// place the DISTINCTION between "this is the plant" and "this is its texture"
// exists — geometry alone cannot tell a leaf from the hairs on a leaf.
const FINISH = /hair|wool|pubescen|underside|down|papill|scale|reproductive|involucre|sepal|ovary|bract/i;

// AN ORGAN SWARM CANNOT BE THINNED, IT MUST BE AGGREGATED. Culling anything
// under 6 mm and thinning the rest to a triangle budget reports a 219x saving
// and DELETES THE PLANTS: a Ceanothus goes from 5,082,611 florets to zero and
// from 30,303 leaves to ten. Measuring cost alone looks wonderful, because an
// empty shrub is very cheap.
//
// The reason thinning fails here is that florets are not redundant copies, they
// TILE A SURFACE. Half a million of them make a shrub blue; five thousand of them
// make a shrub with a few blue specks on it. Removing 99% of a drift of leaves
// leaves a bald plant, not a lighter one.
//
// So a dense swarm of sub-pixel organs is replaced by the shape it actually adds
// up to: the instances are bucketed into cells and each cell becomes ONE coarse
// lump of the mean colour: the visible unit on a shrub in flower is the CLUSTER,
// not the floret.
const SWARM_ORGAN_M = 0.060;   // an organ this small is never individually read
const SWARM_MIN     = 800;     // below this a swarm is cheap and worth keeping whole
const CELL_M        = 0.060;   // a lump this size is ~5 px at 10 m: what the eye gets

// What one surviving organ class may spend when it is NOT a swarm — leaves and
// twigs, which are individually resolvable and must stay individually placed.
let batchTriangleBudget = 240000;
export function setBotanicalBudget(t){ batchTriangleBudget = Math.max(1, t | 0); }

// A canopy must never go bald to satisfy a budget. Thinning stops here even if
// that costs triangles, because a plant with ten leaves is not a cheap plant, it
// is a wrong one.
const MIN_KEEP_FRACTION = 0.25;

const _size = V();
function protoCost(g){
 if(!g.boundingBox) g.computeBoundingBox();
 g.boundingBox.getSize(_size);
 const tri = g.index ? g.index.count/3 : (g.attributes.position?.count ?? 0)/3;
 return { tri, span: Math.max(_size.x, _size.y, _size.z) };
}

/** What garden detail does to one batch. Exported so a test can assert the
 *  policy without building a plant. */
export function detailPlan(g, name, count, mode = detailMode){
 if(mode !== 'garden') return { action: 'keep', keep: count };
 const { tri, span } = protoCost(g);
 if(FINISH.test(name || '')) return { action: 'cull', keep: 0 };
 if(span < SWARM_ORGAN_M && count >= SWARM_MIN) return { action: 'aggregate', keep: count };
 const budget = Math.max(1, Math.floor(batchTriangleBudget / Math.max(tri, 1)));
 return { action: 'thin', keep: Math.max(Math.ceil(count * MIN_KEEP_FRACTION), Math.min(count, budget)) };
}

/** An evenly spaced subset. Taking the FIRST n would thin a drift from one end
 *  and leave a bald patch; a stride keeps the organ spread over the whole plant. */
function stride(total, keep){
 const step = total / keep, out = new Uint32Array(keep);
 for(let i=0;i<keep;i++) out[i] = Math.min(total-1, Math.floor(i*step));
 return out;
}

// One low-poly lump, reused for every aggregated swarm in the scene.
let _lump = null;
function lumpGeometry(){
 if(!_lump){
  _lump = new THREE.IcosahedronGeometry(0.5, 1);   // 80 triangles
  // A WHITE `color` ATTRIBUTE, because the lump is drawn with the CALLER'S material
  // and across the plant modules that material is `vertexColors: true` — the real
  // organ carries its colour per vertex. With the flag set and no attribute bound,
  // WebGL supplies (0,0,0) and the whole swarm multiplies to BLACK: California
  // fuchsia draws as a mound of black balls with red flowers on it.
  const n = _lump.attributes.position.count;
  _lump.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
 }
 return _lump;
}

/** The mean of a prototype's own vertex colours, [r,g,b], or white when it has none.
 *  THAT is what colour a leaf is — the instance colour is only a tint over it (a
 *  fuchsia leaf is (0.19, 0.24, 0.17) per vertex under an instance tint near 1) — so a
 *  lump standing in for a swarm of them has to be multiplied by it, or it comes out
 *  the colour of the tint: white. Once per geometry. */
const _protoTint = new WeakMap();
export function prototypeTint(g){
 let t = _protoTint.get(g);
 if(!t){
  const c = g?.attributes?.color;
  if(!c || !c.count) t = [1, 1, 1];
  else{
   let r = 0, gg = 0, b = 0;
   for(let i = 0; i < c.count; i++){ r += c.getX(i); gg += c.getY(i); b += c.getZ(i); }
   t = [r / c.count, gg / c.count, b / c.count];
  }
  if(g) _protoTint.set(g, t);
 }
 return t;
}

/** Bucket instance positions into CELL_M cells; return one transform per cell,
 *  sized to what it holds and coloured by the mean of its members. */
function aggregate(matrices, colors, count, hasColors){
 const cells = new Map();
 for(let i=0;i<count;i++){
  const x = matrices[i*16+12], y = matrices[i*16+13], z = matrices[i*16+14];
  const key = `${Math.floor(x/CELL_M)},${Math.floor(y/CELL_M)},${Math.floor(z/CELL_M)}`;
  let c = cells.get(key);
  if(!c){ c = { n:0, x:0, y:0, z:0, r:0, g:0, b:0,
                x0:Infinity, y0:Infinity, z0:Infinity, x1:-Infinity, y1:-Infinity, z1:-Infinity };
          cells.set(key, c); }
  c.n++; c.x+=x; c.y+=y; c.z+=z;
  c.x0=Math.min(c.x0,x); c.y0=Math.min(c.y0,y); c.z0=Math.min(c.z0,z);
  c.x1=Math.max(c.x1,x); c.y1=Math.max(c.y1,y); c.z1=Math.max(c.z1,z);
  if(hasColors){ c.r+=colors[i*3]; c.g+=colors[i*3+1]; c.b+=colors[i*3+2]; }
 }
 const n = cells.size, mat = new Float32Array(n*16), col = new Float32Array(n*3);
 let k = 0;
 for(const c of cells.values()){
  // A lump fills its cell, with a floor so a sparse cell still reads as mass
  // rather than as a speck — the swarm's own extent, not a fixed size.
  const sx = Math.max(c.x1-c.x0, CELL_M*0.55), sy = Math.max(c.y1-c.y0, CELL_M*0.55),
        sz = Math.max(c.z1-c.z0, CELL_M*0.55);
  mat[k*16]=sx; mat[k*16+5]=sy; mat[k*16+10]=sz; mat[k*16+15]=1;
  mat[k*16+12]=c.x/c.n; mat[k*16+13]=c.y/c.n; mat[k*16+14]=c.z/c.n;
  col[k*3]=hasColors?c.r/c.n:1; col[k*3+1]=hasColors?c.g/c.n:1; col[k*3+2]=hasColors?c.b/c.n:1;
  k++;
 }
 return { matrices: mat, colors: col, count: n };
}

export function instanceBatch(g,material,items,name){
 const packed=items instanceof InstanceTransforms;
 const total=packed?items.length:items.length;
 const plan=detailPlan(g,name,total);
 const matrix=new THREE.Matrix4();

 // A culled class stays in the tree as an EMPTY batch rather than being dropped:
 // every caller does group.add(instanceBatch(...)) and a null would have to be
 // handled in every module. count 0 costs no draw call, and the node is still there
 // to be counted, named and switched back on.
 if(plan.action==='cull'){
  const m=new THREE.InstancedMesh(g,material,0);m.name=name;m.count=0;
  m.instanceMatrix=new THREE.InstancedBufferAttribute(new Float32Array(0),16);
  m.userData.lodCulled=total;m.castShadow=m.receiveShadow=false;return m;
 }

 if(plan.action==='aggregate'){
  // The swarm's own transforms are needed as data, so pack an array form first.
  let mats,cols,has;
  if(packed){ mats=items.matrices; cols=items.colors; has=items.hasColors; }
  else{
   mats=new Float32Array(total*16); cols=new Float32Array(total*3); has=false;
   items.forEach((p,i)=>{ matrix.compose(p.at,p.q,p.scale); mats.set(matrix.elements,i*16);
    if(p.color){ has=true; cols[i*3]=p.color.r; cols[i*3+1]=p.color.g; cols[i*3+2]=p.color.b; }
    else cols[i*3]=cols[i*3+1]=cols[i*3+2]=1; });
  }
  const lump=aggregate(mats,cols,total,has);
  const tint=prototypeTint(g);
  for(let i=0;i<lump.count;i++){ lump.colors[i*3]*=tint[0]; lump.colors[i*3+1]*=tint[1]; lump.colors[i*3+2]*=tint[2]; }
  const m=new THREE.InstancedMesh(lumpGeometry(),material,0);m.name=name;
  m.instanceMatrix=new THREE.InstancedBufferAttribute(lump.matrices,16);m.count=lump.count;
  m.instanceColor=new THREE.InstancedBufferAttribute(lump.colors,3);
  m.userData.lodAggregated=total;
  m.castShadow=m.receiveShadow=true;botanicalInstanceBounds(m);return m;
 }

 const keep=plan.keep;
 const m=new THREE.InstancedMesh(g,material,packed?0:total);m.name=name;
 if(packed){
  if(keep<total){
   const pick=stride(total,keep),mat=new Float32Array(keep*16),col=new Float32Array(keep*3);
   for(let i=0;i<pick.length;i++){
    mat.set(items.matrices.subarray(pick[i]*16,pick[i]*16+16),i*16);
    col.set(items.colors.subarray(pick[i]*3,pick[i]*3+3),i*3);
   }
   m.instanceMatrix=new THREE.InstancedBufferAttribute(mat,16);m.count=keep;
   if(items.hasColors)m.instanceColor=new THREE.InstancedBufferAttribute(col,3);
   m.userData.lodThinned=total;
  }else{
   // Packing is finished before batching. The front/back faces can share these
   // immutable views; no duplicate half-gigabyte array is needed for a canopy.
   m.instanceMatrix=new THREE.InstancedBufferAttribute(items.matrices.subarray(0,total*16),16);m.count=total;
   if(items.hasColors)m.instanceColor=new THREE.InstancedBufferAttribute(items.colors.subarray(0,total*3),3);
  }
 }else if(keep<total){
  const pick=stride(total,keep);m.count=keep;m.userData.lodThinned=total;
  for(let i=0;i<pick.length;i++){const p=items[pick[i]];matrix.compose(p.at,p.q,p.scale);m.setMatrixAt(i,matrix);if(p.color)m.setColorAt(i,p.color);}
 }else items.forEach((p,i)=>{matrix.compose(p.at,p.q,p.scale);m.setMatrixAt(i,matrix);if(p.color)m.setColorAt(i,p.color);});
 m.castShadow=m.receiveShadow=true;botanicalInstanceBounds(m);return m;
}

/** All botanical transforms are affine TRS. Transform the prototype box's
 * center/extents directly instead of allocating/evaluating eight corners per
 * organ, then revisiting every organ for its sphere. The enclosing box sphere
 * is conservative for culling and picking: it never removes a visible organ. */
export function botanicalInstanceBounds(mesh){
 const g=mesh.geometry;if(!g.boundingBox)g.computeBoundingBox();
 const b=g.boundingBox,c=b.getCenter(V()),e=b.getSize(V()).multiplyScalar(.5),a=mesh.instanceMatrix.array;
 let lx=Infinity,ly=Infinity,lz=Infinity,hx=-Infinity,hy=-Infinity,hz=-Infinity;
 for(let i=0;i<mesh.count;i++){
  const k=i*16,x=a[k]*c.x+a[k+4]*c.y+a[k+8]*c.z+a[k+12],y=a[k+1]*c.x+a[k+5]*c.y+a[k+9]*c.z+a[k+13],z=a[k+2]*c.x+a[k+6]*c.y+a[k+10]*c.z+a[k+14],
   ex=Math.abs(a[k])*e.x+Math.abs(a[k+4])*e.y+Math.abs(a[k+8])*e.z,ey=Math.abs(a[k+1])*e.x+Math.abs(a[k+5])*e.y+Math.abs(a[k+9])*e.z,ez=Math.abs(a[k+2])*e.x+Math.abs(a[k+6])*e.y+Math.abs(a[k+10])*e.z;
  lx=Math.min(lx,x-ex);ly=Math.min(ly,y-ey);lz=Math.min(lz,z-ez);hx=Math.max(hx,x+ex);hy=Math.max(hy,y+ey);hz=Math.max(hz,z+ez);
 }
 mesh.boundingBox=new THREE.Box3(V(lx,ly,lz),V(hx,hy,hz));
 mesh.boundingSphere=mesh.boundingBox.getBoundingSphere(new THREE.Sphere());
}
