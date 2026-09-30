// Botanically distinct structures, in metres. Shared by the app and review export.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
function colour(g,hex=0xffffff,f=1){
 const c=new THREE.Color(hex),a=new Float32Array(g.attributes.position.count*3);
 for(let i=0;i<a.length;i+=3){a[i]=c.r*f;a[i+1]=c.g*f;a[i+2]=c.b*f;}
 g.setAttribute('color',new THREE.BufferAttribute(a,3));return g;
}
// FAST PREVIEW: the same segments, as open 3-sided prisms — 6 triangles
// against 20. Set only for the length of one botanicalModel(..., {preview:true}) call.
let LITE=false;
function segment(a,b,width=.001,hair=false){
 // a HAIR (a panicle branchlet under a millimetre) is an open three-sided prism: a closed five-sided
 // tube is 20 triangles for something no view resolves, and a pink muhly's cloud is thousands
 const d=b.clone().sub(a),g=LITE||hair?new THREE.CylinderGeometry(width*.72,width,d.length(),3,1,true):new THREE.CylinderGeometry(width*.72,width,d.length(),5,1);
 g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0,1,0),d.normalize()));
 return g.translate(...a.clone().add(b).multiplyScalar(.5).toArray());
}
function mesh(parts,name){
 if(!parts.length)return null;
 const gs=parts.map(g=>{const n=g.index?g.toNonIndexed():g;n.deleteAttribute('uv');return n;});
 const geo=mergeGeometries(gs,false);for(const g of new Set([...gs,...parts]))g.dispose();
 if(!geo)throw new Error('Cannot merge botanical '+name);
 const m=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:.85,side:THREE.DoubleSide}));
 m.name=name;m.castShadow=m.receiveShadow=true;return m;
}
// A leaf has an upper and lower surface, a narrowed petiole, a curved centre,
// and a broad distal half. Succulent leaves must not be triangular agave blades.
function spoon(length,width,thickness=.001,teeth=0){
 const P=[],I=[],S=12,N=8;
 for(let i=0;i<=S;i++){
  const t=i/S,half=Math.pow(Math.sin(Math.PI*t),.62)*width*.5;
  for(let j=0;j<N;j++){
   const a=j/N*Math.PI*2,edge=teeth?1+.09*Math.sin(t*Math.PI*teeth):1;
   P.push(Math.cos(a)*half*edge,.11*length*Math.sin(Math.PI*t)+Math.sin(a)*thickness*Math.sin(Math.PI*t),t*length);
  }
 }
 for(let i=0;i<S;i++)for(let j=0;j<N;j++){const a=i*N+j,b=i*N+(j+1)%N,c=a+N,d=b+N;I.push(a,c,b,b,c,d);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setIndex(I);g.computeVertexNormals();return g;
}
function palmate(size){
 const P=[0,0,size*.37],I=[];
 for(let i=0;i<=96;i++){
  const a=i/96*Math.PI*2,rad=size*.5*(.83+.13*Math.cos(7*a)+.04*Math.cos(35*a));
  P.push(Math.cos(a)*rad,.006*Math.sin(a*2),Math.sin(a)*rad+size*.37);if(i)I.push(0,i,i+1);
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setIndex(I);g.computeVertexNormals();return g;
}
const petal=(l,w)=>spoon(l,w,.0004);

/** One rosemary corolla: short tube, upper hood, three-lobed lower lip and
 * two projecting stamens. Origin is the calyx attachment, flower points +Z. */
export function rosemaryFlower() {
 const parts=[];
 const calyx=new THREE.SphereGeometry(.0022,8,6);calyx.scale(1,1,1.4);parts.push(colour(calyx,'#777068'));
 const tube=new THREE.CylinderGeometry(.0021,.0013,.006,10,2,true);tube.rotateX(Math.PI/2);tube.translate(0,0,.004);parts.push(colour(tube,'#c7c0e1'));
 const hood=petal(.0045,.0035);hood.rotateX(-.5);hood.translate(0,.0015,.006);parts.push(colour(hood,'#c5b9df'));
 for(let j=-1;j<=1;j++) {
  const lip=petal(j===0?.006:.0045,j===0?.006:.0035);lip.rotateY(j*.55);lip.rotateX(.22);lip.translate(j*.002,-.001,.007);
  colour(lip,'#b6a6d7');const c=lip.attributes.color,p=lip.attributes.position;
  // Purple throat markings run outward along the lower lip, as in the reference.
  for(let i=0;i<c.count;i++)if(Math.sin(p.getZ(i)*1800+p.getX(i)*3700)>.82&&p.getZ(i)<.012){c.setXYZ(i,c.getX(i)*.58,c.getY(i)*.51,c.getZ(i)*.8);}
  parts.push(lip);
 }
 for(const x of [-.00065,.00065]) {
  parts.push(colour(segment(V(x,.001,.006),V(x,.004,.013),.00016),'#d1c7e7'));
  const anther=new THREE.SphereGeometry(.00045,6,4);anther.translate(x,.004,.013);parts.push(colour(anther,'#6d5683'));
 }
 for(const g of parts)g.deleteAttribute('uv');
 const result=mergeGeometries(parts,false);for(const g of parts)g.dispose();return result;
}

// Blade widths are modelling estimates in metres, independent of clump size.
export function grassBladeWidth(p){
 const sp=p.species||'';
 if(/festuca (idahoensis|rubra)|festuca.*siskiyou|nassella|stipa pulchra/i.test(sp))return .0013;
 if(/sporobolus|calamagrostis|carex pansa/i.test(sp))return .002;
 if(/muhlenbergia|festuca californica/i.test(sp))return .003;
 if(/carex tumulicola|leymus/i.test(sp))return .004;
 return .006;
}

export function grassInflorescence(p,r){
 if(!p.flower||!/muhlenbergia|festuca|nassella|stipa pulchra|sporobolus|calamagrostis|leymus/i.test(p.species||''))return null;
 const h=p.mature_height_m,w=p.mature_spread_m,parts=[];
 const tall=p.flowering_height_range_m?.[1]||h*1.35;
 // AIRY means a diffuse open panicle rather than a narrow spike, and the two
 // Muhlenbergia in this catalog are on opposite sides of that line: M. rigens is
 // a tight straw spike (correctly not airy), while M. capillaris IS the cloud —
 // a haze of tiny florets is the entire plant, and drawn as a spike it is
 // indistinguishable from deer grass — and it is grown for the pink.
 const airy=/sporobolus|festuca|nassella|stipa pulchra|muhlenbergia capillaris/i.test(p.species);
 const awned=/nassella|stipa pulchra/i.test(p.species);
 // The head takes the plant's OWN declared flower colour. Hardcoded straw for
 // everything but Sporobolus would discard every grass's declared flower colour —
 // Nassella pulchra is PURPLE needlegrass at #99788a and would draw tan, and a
 // pink muhly could not be pink at all. The same shape of fault as a file that
 // cannot draw a straw blade although a third of a real fescue clump is straw.
 const headColour=p.flower||(/sporobolus/i.test(p.species)?'#b39a94':'#ac9d76');
 // A PINK MUHLY IS ITS CLOUD: the photographs are a dense pink mist over the clump, and a few
 // dozen sparse panicles draw only a grey haze.
 // Its panicles are many and finely branched — more culms, more branches, more branchlets.
 const cloud=/muhlenbergia capillaris/i.test(p.species);
 const culms=Math.round((12+w*20)*(cloud?2.6:1)),branches=cloud?11:7,branchlets=cloud?7:4;
 for(let i=0;i<culms;i++){
  const a=i*2.399,rad=w*.32*Math.sqrt(r()),top=V(Math.cos(a)*rad,tall*(.73+r()*.26),Math.sin(a)*rad);
  parts.push(colour(segment(V(top.x*.2,0,top.z*.2),top,.0009),'#8b9164'));
  if(!airy){
   parts.push(colour(segment(top.clone().add(V(0,-tall*.17,0)),top,.0024),headColour));
  }else for(let j=0;j<branches;j++){
   const y=top.y-tall*(.02+j*.025*7/branches),reach=tall*(.02+j*.012*7/branches),theta=a+j*2.399;
   const tip=V(top.x+Math.cos(theta)*reach,y+reach*.35,top.z+Math.sin(theta)*reach);
   parts.push(colour(segment(V(top.x,y,top.z),tip,.00035,cloud),headColour));
   for(let k=0;k<branchlets;k++){
    const base=V(top.x,y,top.z).lerp(tip,.35+k*.2*4/branchlets),end=base.clone().add(V(Math.cos(theta+k)*.018,.012,Math.sin(theta+k)*.018));
    parts.push(colour(segment(base,end,.00055,cloud),headColour));
    if(awned)parts.push(colour(segment(end,end.clone().add(V(.025,.035,.008)),.0002),'#a48b77'));
   }
  }
 }
 return mesh(parts,'bloom');
}

// ONE two-lipped salvia flower — tube, hood and lip — facing +Z at the origin: Hot Lips' white hood
// over a red lip for 'hot_lips', plain white (the plant's colour goes on the material) otherwise.
function lipParts(kind){
 const tube=new THREE.CylinderGeometry(.0028,.0018,.018,8,1,true);tube.rotateX(Math.PI*.33);tube.translate(0,.004,.009);
 const hood=petal(.010,.006);hood.rotateX(-.25);hood.translate(0,.009,.013);
 const lip=petal(.016,.018);lip.rotateX(.35);lip.translate(0,.002,.018);
 return [[tube,0xf7efec],[hood,0xf4e9e6],[lip,0xd92948]].map(([g,c])=>{if(kind==='savory')g.scale(.25,.25,.25);return [g,kind==='hot_lips'?c:0xffffff];});
}
/** Hot Lips' flower as one geometry, vertex-coloured — what a shoot's raceme carries (shoots.js). */
export function lipFlower(){
 const parts=lipParts('hot_lips').map(([g,c])=>{colour(g,c);g.deleteAttribute('uv');return g.index?g.toNonIndexed():g;});
 return mergeGeometries(parts,false);
}

/** A complete attached inflorescence, using the shared stem-builder interface. */
export function botanicalHead(kind,len,wide,r){
 if(!['hot_lips','bilabiate','savory','bracted_whorl','tube','tube_cluster','fan','bell','gaura'].includes(kind))return null;
 const heads=[],stem=segment(V(),V(0,len,0),.0011);
 const add=(g,c=0xffffff)=>heads.push(colour(g,c));
 if(kind==='bracted_whorl'){
  for(let tier=0;tier<3;tier++)for(let j=0;j<7;j++){
   const a=j*Math.PI*2/7,y=len*(.46+tier*.23);
   for(let k=0;k<2;k++){
    const g=petal(.017,.012);g.rotateX(-.15+k*.3);g.rotateY(a+k*.35);g.translate(0,y,0);add(g,0xa473a8);
   }
   const g=new THREE.CylinderGeometry(.0023,.0013,.022,8,1,true);
   g.translate(0,.011,0);g.rotateX(.8);g.rotateY(a);g.translate(0,y+.006,0);add(g,0x655ca8);
  }
 }else if(kind==='hot_lips'||kind==='bilabiate'||kind==='savory'){
  for(let i=0;i<4;i++){
   const a=i*Math.PI*.91,y=len*(.4+i*.18);
   for(const [g,c] of lipParts(kind)){g.rotateY(a);g.translate(0,y,0);add(g,c);}
  }
 }else if(kind==='fan'||kind==='gaura'){
  const n=kind==='fan'?5:4;
  for(let j=0;j<n;j++){
   const g=petal(kind==='fan'?.012:.018,kind==='fan'?.005:.009);
   g.rotateY(kind==='fan'?(-.95+j*.475):(-1.3+j*.87));g.rotateX(-.24);g.translate(0,len,0);add(g);
  }
  if(kind==='gaura')for(let j=0;j<7;j++)add(segment(V(0,len,.005),V((j-3)*.0015,len+.008,.029),.00024));
 }else if(kind==='bell'){
  // Branched panicle of hanging bells; flowers do not grow out of a bare rod.
  for(let j=0;j<6;j++){
   const a=j*2.399,y=len*(.52+j*.075),reach=.025*(1-j*.11);
   const end=V(Math.cos(a)*reach,y+.012,Math.sin(a)*reach);
   add(segment(V(0,y,0),end,.00045),0x80936c);
   for(let k=0;k<3;k++){
    const g=new THREE.CylinderGeometry(.0034,.0016,.011,9,2,true);
    g.translate(0,.0055,0);g.rotateX(Math.PI*.83);g.rotateY(a+k*.8);
    g.translate(end.x+(k-1)*.007,end.y+k*.006,end.z);add(g);
   }
  }
 }else{
  const n=kind==='tube_cluster'?6:3;
  for(let j=0;j<n;j++){
   const a=j*2.399,y=kind==='tube_cluster'?len:len*(.4+j/n*.55),L=kind==='bell'?.009:.032;
   const tilt=kind==='bell'?Math.PI*.78:Math.PI*.31;
   const g=new THREE.CylinderGeometry(kind==='bell'?.003:.004,.0018,L,10,3,true);
   g.translate(0,L/2,0);g.rotateX(tilt);g.rotateY(a);g.translate(0,y,0);add(g);
   for(let k=0;k<4;k++){const p=petal(L*.2,L*.14);p.rotateY(k*Math.PI/2);p.translate(0,L,0);p.rotateX(tilt);p.rotateY(a);p.translate(0,y,0);add(p);}
  }
 }
 // The caller merges these with CylinderGeometry and its UV attribute.
 for(const g of [stem,...heads])if(!g.attributes.uv)g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(g.attributes.position.count*2),2));
 return {stem,heads};
}

export function botanicalModel(p,r,{preview=false}={}){
 LITE=!!preview;
 try{return botanicalBuild(p,r);}finally{LITE=false;}
}
function botanicalBuild(p,r){
 const sp=p.species||'',h=p.mature_height_m||.3,w=p.mature_spread_m||.4;
 const group=new THREE.Group(),leaves=[],stems=[],flowers=[];
 const fol=p.foliage?.startsWith('#')?p.foliage:'#8b9c7b';
 const leaf=(g,f=1)=>leaves.push(colour(g,fol,f));
 const stalk=g=>stems.push(colour(g,'#687352'));
 const bloom=(g,c=p.flower||'#d2b5c5')=>flowers.push(colour(g,c));
 if(/echeveria/i.test(sp)){
  const wool=/doris taylor/i.test(sp),radius=w*.48,base=h*.28;
  for(let ring=0;ring<5;ring++){
   const n=13-ring,L=radius*(1-ring*.16);
   for(let i=0;i<n;i++){
    const a=i/n*Math.PI*2+ring*1.2+(r()-.5)*.12,tilt=.09-ring*.29;
    const g=spoon(L,L*.62,L*.12);g.rotateX(tilt);g.rotateY(a);g.translate(0,base+ring*h*.025,0);leaf(g,.86+r()*.26);
    if(wool)for(let j=0;j<Math.round(L*1800);j++){
     const t=.15+r()*.68,x=(r()-.5)*L*.30*Math.sin(Math.PI*t),z=t*L,y=.21*L*Math.sin(Math.PI*t);
     const hair=segment(V(x,y,z),V(x,y+.0008+r()*.0012,z+.0003),.00012);
     hair.rotateX(tilt);hair.rotateY(a);hair.translate(0,base+ring*h*.025,0);leaves.push(colour(hair,'#e0e4d8'));
    }
   }
  }
  stalk(segment(V(),V(0,base+h*.1,0),w*.04));
 }else if(/carex.*evergold/i.test(sp)){
  const n=Math.round(w*h/.0005),P=[],C=[],I=[],green=new THREE.Color('#456b3e'),cream=new THREE.Color('#d6ce82');
  for(let i=0;i<n;i++){
   const a=r()*Math.PI*2,reach=w*(.15+r()*.34),high=h*(.28+r()*.68),base=r()*w*.075,width=.003+r()*.002,off=P.length/3;
   for(let j=0;j<=14;j++){
    const t=j/14,rad=base+reach*t,y=high*Math.sin(t*Math.PI*.92);
    for(let k=0;k<5;k++){
     const x=(k/4-.5)*width*(1-.94*t);P.push(Math.cos(a)*rad-Math.sin(a)*x,y,Math.sin(a)*rad+Math.cos(a)*x);
     const c=k===0||k===4?green:cream,f=.65+t*.35;C.push(c.r*f,c.g*f,c.b*f);
    }
   }
   for(let j=0;j<14;j++)for(let k=0;k<4;k++){const q=off+j*5+k;I.push(q,q+5,q+1,q+1,q+5,q+6);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));g.setIndex(I);g.computeVertexNormals();leaves.push(g);
 }else if(/foeniculum/i.test(sp)){
  // BRONZE FENNEL, from the habit photograph (Commons "Foeniculum vulgare "Purpureum".jpg": a plant
  // in flower in a gravel garden): a vase of pale GLAUCOUS stems, a haze of bronze thread-leaves
  // over its lower half, and yellow umbels 8-12 cm across fanned out at the top, several a stem.
  // Drawn as dark 6 mm sticks with 0.45 mm threads and 9 cm umbels of 1.5 mm dots, the threads vanish
  // at garden distance and the plant reads as dead stalks at two-thirds of its spread. A thread is
  // sub-millimetre, so it is a HAIR prism, as a muhly cloud is.
  const glaucous=g=>stems.push(colour(g,'#8e9a88'));
  const umbel=(at,R,rays)=>{
   for(let j=0;j<rays;j++){
    const a=j*2.399,rr=R*Math.sqrt((j+.5)/rays),head=at.clone().add(V(Math.cos(a)*rr,R*.3,Math.sin(a)*rr));
    glaucous(segment(at,head,.0006,true));
    for(let k=0;k<6;k++){const g=LITE?new THREE.OctahedronGeometry(.0019,0):new THREE.SphereGeometry(.0019,5,3);
     g.translate(head.x+Math.cos(k*1.047)*.0065,head.y+.002,head.z+Math.sin(k*1.047)*.0065);bloom(g);}
   }
  };
  for(let i=0;i<Math.round(w*24);i++){
   const a=i*2.399,rad=w*.5*Math.sqrt(r()),top=V(Math.cos(a)*rad,h*(.62+r()*.38),Math.sin(a)*rad);
   glaucous(segment(V(Math.cos(a)*rad*.08,0,Math.sin(a)*rad*.08),top,.0035));
   // leaves big and dense low, few and short up the stem — the haze is the lower half
   for(let j=1;j<10;j++){
    const base=top.clone().multiplyScalar(j/12),theta=a+j*2.4,reach=w*(.2+r()*.14)*(1-j*.075),tip=base.clone().add(V(Math.cos(theta)*reach,reach*.26,Math.sin(theta)*reach));glaucous(segment(base,tip,.0008,true));
    for(let k=1;k<12;k++)for(const s of [-1,1]){
     // Fast draws each leaf as its one thread, twice as thick — the four side threads' coverage
     // in a fifth of the parts, in the same place (no r() below, so it is the same individual)
     const b=base.clone().lerp(tip,k/12),L=reach*(1-k/14)*.5,t=b.clone().add(V(Math.cos(theta+s*.65)*L,L*.2,Math.sin(theta+s*.65)*L));leaf(segment(b,t,LITE?.0015:.0007,true),.85+r()*.25);
     if(!LITE)for(let m=1;m<5;m++){const q=b.clone().lerp(t,m/5),len=L*.38;leaf(segment(q,q.clone().add(V(Math.cos(theta+s*1.3)*len,len*.35,Math.sin(theta+s*1.3)*len)),.0005,true));}
    }
   }
   if(p.flower){
    umbel(top,.055,16);
    // two side umbels on the upper branches, lower and out — the fan the photograph shows
    for(const s of [-1,1]){const at=top.clone().multiplyScalar(.84).add(V(Math.cos(a+s*1.2)*w*.12,0,Math.sin(a+s*1.2)*w*.12));glaucous(segment(top.clone().multiplyScalar(.7),at,.0015));umbel(at,.04,12);}
   }
  }
 }else if(/fragaria|heuchera|stachys byzantina/i.test(sp)){
  const strawberry=/fragaria/i.test(sp),heuchera=/heuchera/i.test(sp);
  const leafArea=strawberry?3*.045*.038*.65:heuchera?.065*.078*.68:.105*.05*.62;
  const n=Math.round(1.8*Math.PI*(w/2)**2/leafArea);
  for(let i=0;i<n;i++){
   const a=i*2.399,rad=w*.42*Math.sqrt(r()),x=Math.cos(a)*rad,z=Math.sin(a)*rad;
   const y=h*(.10+.67*(1-Math.pow(rad/(w*.48),1.4)))*(.75+r()*.25);
   stalk(segment(V(x*.22,.008,z*.22),V(x,y,z),.0012));
   for(let j=0;j<(strawberry?3:1);j++){
    const L=strawberry?.045:heuchera?.08:.105,g=heuchera?palmate(L*1.2):spoon(L,strawberry?L*.85:L*.47,.0015,strawberry?20:0);
    g.rotateX(-.12-r()*.45);g.rotateY(a+(j-1)*1.5);g.translate(x,y,z);leaf(g,.83+r()*.32);
   }
  }
  if(p.flower)for(let i=0;i<Math.max(5,Math.round(w*12));i++){
   const a=r()*6.28,x=Math.cos(a)*w*.22,z=Math.sin(a)*w*.22;
   if(strawberry){
    const y=h*.75;stalk(segment(V(x,0,z),V(x,y,z),.001));
    for(let j=0;j<5;j++){const g=petal(.010,.008);g.rotateY(j*1.257);g.translate(x,y,z);bloom(g,'#f4f0e4');}
    const g=new THREE.SphereGeometry(.0028,6,4);g.translate(x,y+.001,z);bloom(g,'#d6b538');
   }else{
    const b=botanicalHead(heuchera?'bell':'bilabiate',Math.max(h,.6)*(.65+r()*.35),.016,r);
    b.stem.translate(x,0,z);stalk(b.stem);for(const g of b.heads){g.translate(x,0,z);bloom(g);}
   }
  }
 }else return null;
 for(const [parts,name] of [[leaves,'foliage'],[stems,'wood'],[flowers,'bloom']]){const m=mesh(parts,name);if(m)group.add(m);}
 group.userData.botanicalModel=true;return group;
}
