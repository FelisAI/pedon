// LEAF-BEARING SHOOTS, for any species a PROFILE describes: leaves that meet stem nodes, wood,
// flowers along or above the shoots — no solid canopy masses, no scattered cards. The profiles
// themselves (which species, their leaf, spacing, bloom) are species knowledge, made from
// photographs: the library's (<library>/species/shoot_profiles.js), which
// hands one to shootModel. The leaf kinds and blooms they name are drawn here.
import * as THREE from 'three';
import {translucent, translucencyFor} from './translucency.js';
import {groundTexture} from './grain.js';
import {rosemaryFlower, lipFlower} from './botanical.js';

const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const surfaceCache=new Map();
let sageLeafTexture=null;   // registered by the library profile that loads it
export function registerSageLeafTexture(texture) {
  texture.colorSpace=THREE.SRGBColorSpace;texture.userData.sharedPlantTexture=true;sageLeafTexture=texture;
}


/** Curled leaf surface with a real outline, midrib, and irregular margin.
 *
 * TESSELLATED FOR THE DISTANCE IT IS SEEN AT. A rosemary needle is 2 cm
 * long: in a garden view at 5 m it is FOUR PIXELS tall, and the full mesh spends
 * 80 triangles on it — twenty triangles per pixel. One plant carries about a
 * hundred thousand of them, which is millions of triangles for a single shrub
 * and, at a dozen copies, most of a design's geometry.
 *
 * `specimen` is the one case where the tessellation is worth paying for: ONE
 * plant on its own at half a metre, which is `compare.html` — where the
 * shoots, curved laminae, undersides and corollas are reviewed, and
 * where a needle really is hundreds of pixels. The garden view gets the same
 * shape at a fifth of the cost; it is the same leaf, not a different plant.
 */
export function shootLeaf(profile,variant=0,{specimen=false,preview=false}={}) {
  const sage=profile.leaf==='sage';
  // THREE LEVELS OF THE SAME LEAF. Fast preview must preserve the full-detail
  // plant's shape and size: same profile, same length, same width, same curve
  // table; only how finely it is cut changes. A single quad is 2 triangles
  // against the garden view's 12, but a needle needs two rows to keep its area.
  // TWO ROWS, NEVER ONE. A needle's outline is
  // sqrt(min(t/.06,1) * min((1-t)/.06,1)) — zero at BOTH ends — so a single row
  // samples t=0 and t=1 and builds a leaf with no width anywhere: measured 5-77
  // mm2 against the full model's 64, i.e. degenerate slivers that hide the leaves.
  // Two rows put a vertex at t=0.5 where the outline is 1, and the leaf has area
  // again. 4 triangles, not 2.
  const rows=specimen?(sage?32:10):preview?2:(sage?10:3),
        cols=specimen?(sage?8:4):preview?1:(sage?4:2);
  // the needle's own profile, sampled to however many rows this level uses —
  // the 11-entry table is the specimen curve and the garden view walks it
  const RT=[0,.025,.06,.15,.3,.5,.7,.85,.94,.975,1];
  const rosemaryT=Array.from({length:rows+1},(_,i)=>RT[Math.round(i*(RT.length-1)/rows)]);
  const P=[],U=[],C=[],I=[];
  for(let i=0;i<=rows;i++) {
    const t=sage?i/rows:rosemaryT[i];
    // The photographed sage is broadly oval, with a short narrowed base.
    const outline=sage?Math.pow(Math.sin(Math.PI*Math.pow(t,1.35)),.46):Math.sqrt(Math.min(t/.06,1)*Math.min((1-t)/.06,1));
    const edge=sage?1+.025*Math.sin(t*Math.PI*32+variant):1;
    for(let j=0;j<=cols;j++) {
      const u=j/cols,s=u*2-1,x=s*profile.width*.5*outline*edge;
      const centre=profile.length*(.11*Math.sin(Math.PI*t)-.06*t*t);
      const cup=profile.width*(sage?.08:-.15)*s*s*Math.sin(Math.PI*t);
      const twist=profile.width*.10*s*t*Math.sin(variant*3+t*2);
      P.push(x,centre+cup+twist,profile.length*t);
      U.push(u,t);
      const shade=.93+.07*Math.sin(Math.PI*t)-.05*Math.abs(s);
      C.push(shade,shade,shade);
    }
  }
  for(let i=0;i<rows;i++)for(let j=0;j<cols;j++) {
    const a=i*(cols+1)+j,b=a+cols+1;
    I.push(a,b,a+1,a+1,b,b+1);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(U,2));
  g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));
  g.setIndex(I);g.computeVertexNormals();
  return g;
}

// Raised venation and the rolled needle midrib. Fine mottle uses the existing
// grain generator; this map supplies botanical relief, not a second noise engine.
export function leafSurface(kind) {
  if(surfaceCache.has(kind))return surfaceCache.get(kind);
  let maps={};
  try {
    const S=256,c=document.createElement('canvas');c.width=c.height=S;
    const ctx=c.getContext('2d');if(!ctx)return maps;
    const h=new Float32Array(S*S),sage=kind==='sage'||kind==='morello';
    for(let y=0;y<S;y++)for(let x=0;x<S;x++) {
      const u=x/(S-1),v=y/(S-1),side=Math.abs(u-.5)*2;
      const midrib=Math.exp(-side*side*900)*.5;
      const course=v*8-side*.48-.10*Math.sin(side*4);
      const d=Math.abs(course-Math.round(course));
      const veins=Math.exp(-d*d*900)*Math.sin(side*Math.PI)*.27;
      h[y*S+x]=midrib+(sage?veins:0);
    }
    const pixels=ctx.createImageData(S,S);
    for(let y=0;y<S;y++)for(let x=0;x<S;x++) {
      const dx=(h[y*S+Math.min(S-1,x+1)]-h[y*S+Math.max(0,x-1)])*3;
      const dy=(h[Math.min(S-1,y+1)*S+x]-h[Math.max(0,y-1)*S+x])*3;
      const n=V(-dx,-dy,1).normalize(),i=(y*S+x)*4;
      pixels.data.set([(n.x*.5+.5)*255,(n.y*.5+.5)*255,(n.z*.5+.5)*255,255],i);
    }
    ctx.putImageData(pixels,0,0);
    const normalMap=new THREE.CanvasTexture(c);normalMap.userData.sharedPlantTexture=true;
    const map=groundTexture(0xffffff,sage?.055:.025,.5);
    map.userData.sharedPlantTexture=true;
    maps={map,normalMap};surfaceCache.set(kind,maps);
  }catch { /* Geometry review and no-DOM tests can still build the asset. */ }
  return maps;
}

/** Complete branched shrub; the same geometry is used live and in baked GLBs. */
// HOW THE PREVIEW IS CHEAPENED, in one place so it can be tuned against a
// measurement rather than guessed at each call site.
//
// The shoot COUNT is the dominant cost: it goes as 1/spacing^2, so thinning the
// pitch by SHOOT_PITCH cuts the crown by its square. Fewer shoots would leave a
// see-through plant, so the leaves grow by LEAF_SCALE to hold the same coverage.
// That is a LOD trade and it is only legal
// in the preview: the master keeps every organ at its botanical size, which is
// the rule in ASSET_FIDELITY.md.
// NODES MATTER AS MUCH AS SHOOTS.
// Thinning only the pitch leaves a rosemary at 273,000 triangles in the preview —
// it carries 40 nodes on a 35 cm shoot, so the leaves per shoot, not the number
// of shoots, dominate the cost. Measure in the BROWSER: the same build costs
// 46 s and 170 ms a frame there, against 2.3 s with Node's canvas shim.
// AND THE THINNING HAS TO BALANCE.
//
// Two separate faults can make the foliage disappear:
//
//  1. `rows: 1` in the preview leaf builds DEGENERATE geometry. A needle's
//     outline is sqrt(min(t/.06,1) * min((1-t)/.06,1)) — zero at BOTH ends — so
//     one row samples t=0 and t=1 only and every leaf becomes a sliver with no
//     width anywhere: measured 5-77 mm2 against the full model's 64. Two rows put
//     a vertex at t=0.5 where the outline is 1. That alone takes the crown from
//     7% of full's leaf area to 60%.
//  2. An arithmetic model of coverage
//     (LEAF_SCALE^2 / (SHOOT_PITCH^2 * NODE_STEP)) can disagree with the geometry:
//     90% predicted against 7% in the mesh. Measure leaf AREA off
//     the built triangles to account for the actual geometry.
//
// MEASURED, one Coast Rosemary at 1.8 m, leaf area against the full model, and
// a 201-plant design's stored triangles:
//
//   2.5/2.0/4.1   82 x 14.8 mm   90%   9.08 M   over the 9 M tripwire
//   3.0/2.0/4.9   98 x 17.6 mm   89%   7.87 M   <- chosen
//   3.5/2.0/5.7  114 x 20.5 mm   89%   7.15 M   leaf too far from the plant
//
// A Westringia needle is 20 x 3.6 mm, so the chosen leaf is still five times too
// big. That is the honest price of holding the canopy closed with 4% of the
// triangles. A leaf-CLUSTER card carrying many leaves in one texture can avoid
// enlarging individual leaves; this builder does not provide one.
export const PREVIEW = { SHOOT_PITCH: 3.0, NODE_STEP: 2.0, LEAF_SCALE: 4.9 };

/** A plant drawn as shoots, to `profile` (a library's shoot profile), or null without one. */
export function shootModel(plant,r,foliageTint,{specimen=false,preview=false,profile:profile0=null}={}) {
  if(!profile0||plant.asset)return null;
  const profile=preview
    ? {...profile0, spacing:profile0.spacing*PREVIEW.SHOOT_PITCH,
       nodes:Math.max(3,Math.round(profile0.nodes/PREVIEW.NODE_STEP)),
       length:profile0.length*PREVIEW.LEAF_SCALE, width:profile0.width*PREVIEW.LEAF_SCALE}
    : profile0;
  // `crown`: the foliage is this share of the sourced height; the spikes rise to all of it
  const hAll=plant.mature_height_m||.6,h=hAll*(profile.crown??1),w=plant.mature_spread_m||.9;
  const sage=profile.leaf==='sage',trail=profile.trailing;
  const leafBatches=Array.from({length:5},()=>[]),woodRecords=[],flowers=[];
  const group=new THREE.Group(),attachments=[];
  // `tint` lets a caller name the colour outright. A flower STALK is not bark:
  // on a salvia it is a green-grey stem, and drawn in the shrub's brown at 3 mm
  // it vanishes at garden distance — which leaves the whorls reading as specks
  // floating above the plant rather than as a spike rising out of it.
  const addWood=(a,b,radius,soft=false,tint=null)=>{
    const direction=b.clone().sub(a),length=direction.length();
    if(length<1e-7)return;
    const matrix=new THREE.Matrix4().compose(a.clone().lerp(b,.5),
      new THREE.Quaternion().setFromUnitVectors(V(0,1,0),direction.divideScalar(length)),V(radius,length,radius));
    woodRecords.push({matrix,tone:.82+r()*.25,colour:tint||(soft?'#78876a':profile.wood)});
  };
  const primary=[],secondary=[];
  for(let i=0;i<9;i++) {
    const a=i*2.399,reach=w*(.05+r()*.11);
    const fork=V(Math.cos(a)*reach,h*.13*(.7+r()*.5),Math.sin(a)*reach);
    addWood(V(0,.006,0),fork,Math.min(.009,w*.014));primary.push(fork);
    for(let j=0;j<4;j++) {
      const angle=a+(j-1.5)*.22,rad=w*(.14+j*.06);
      const end=V(Math.cos(angle)*rad,h*(.18+r()*.15),Math.sin(angle)*rad);
      addWood(fork,end,sage?.0036:.0028);secondary.push(end);
    }
  }
  const count=Math.round(Math.PI*(w*.44)**2/(profile.spacing**2));
  for(let i=0;i<count;i++) {
    const a=i*2.399+(r()-.5)*.38,rad=w*.44*Math.sqrt((i+.5)/count);
    const crown=Math.sqrt(Math.max(.02,1-(rad/(w*.51))**2));
    // Shoots occupy the crown's depth, not just a mathematically smooth roof.
    // `skirt` clothes the FLANKS: the floor of the shell drops as a shoot sits
    // further out, so the mound comes down its own sides instead of standing on
    // a bare bouquet stalk with every leaf in a cap on top. The centre
    // keeps the same shell, so the crown does not fill in and cost triangles
    // where nothing can be seen anyway.
    const rimness=rad/(w*.44);
    const floor=profile.skirt!==undefined
      ? profile.shell-(profile.shell-profile.skirt)*rimness
      : (profile.shell ?? .48);
    const layer=i===0?1:(floor+r()*(1-floor));
    const top=V(Math.cos(a)*rad,h*(.28+.66*crown)*layer,Math.sin(a)*rad);
    let fork=secondary[0],nearest=Infinity;
    for(const node of secondary) {const d=node.distanceToSquared(top);if(d<nearest){nearest=d;fork=node;}}
    const reach=profile.shootLength*(.78+r()*.45);
    // a DOME splays: shoots near the rim lean out, the centre stands up
    const splay=profile.shell?.25+.6*rad/(w*.44):(trail?.82:.35);
    const axis=V(Math.cos(a)*splay,trail?.46:(profile.shell?.95-.4*rad/(w*.44):.93),Math.sin(a)*splay).normalize();
    const base=top.clone().addScaledVector(axis,-Math.min(reach,top.y*.82));base.y=Math.max(.018,base.y);
    const mid=fork.clone().lerp(base,.55);mid.y=Math.max(.01,mid.y*.85);
    // inside a clipped dome the stem to each shoot is fine and hidden, not wire
    const stem=profile.shell?.55:1;
    addWood(fork,mid,(sage?.0019:.0010)*stem);addWood(mid,base,(sage?.0016:.0008)*stem);
    const axisY=top.clone().sub(base).normalize();
    const side=V(axisY.z,0,-axisY.x).normalize(),cross=axisY.clone().cross(side).normalize();
    const n=Math.max(4,Math.round(profile.nodes*Math.min(1,base.distanceTo(top)/profile.shootLength)));
    let previous=base;
    for(let node=0;node<n;node++) {
      // Crowded soft growth at the tip, wider internodes on the older stem.
      const t=1-Math.pow(1-(node+1)/n,1.35),point=base.clone().lerp(top,t);
      point.addScaledVector(side,Math.sin(t*Math.PI)*reach*.08*(r()-.5));
      addWood(previous,point,sage?.0012:.00065,true);previous=point;
      const whorl=profile.whorl||0;
      const angle=node*Math.PI/(whorl||2)+(r()-.5)*(whorl?.12:.32);
      const pair=side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(cross,Math.sin(angle));
      const size=(.55+.45*Math.sin(Math.PI*(.16+t*.78)))*(.82+r()*.3);
      // a pair is two leaves facing apart; a whorl is `whorl` leaves round the node
      const around=whorl?Array.from({length:whorl},(_,k)=>{const a=angle+k*2*Math.PI/whorl;
        return side.clone().multiplyScalar(Math.cos(a)).addScaledVector(cross,Math.sin(a));}):[pair.clone().negate(),pair];
      for(const out of around) {
        const lift=sage?(-.08+.65*t*t):whorl?(.22+.55*t*t):(.35+.65*t*t);
        const direction=out.clone().multiplyScalar(sage?.88:.75).addScaledVector(axisY,lift).normalize();
        if(point.y+direction.y*profile.length<.005)direction.y=Math.abs(direction.y);direction.normalize();
        const right=V().crossVectors(V(0,1,0),direction).normalize();if(right.lengthSq()<.1)right.copy(side);
        const normal=V().crossVectors(direction,right).normalize();
        const petiole=point.clone().addScaledVector(direction,sage?.006:.0012);
        if(!profile.sessile)addWood(point,petiole,sage?.00065:.00035,true);
        const matrix=new THREE.Matrix4().makeBasis(right,normal,direction);matrix.setPosition(petiole);matrix.scale(V(size,size,size));
        leafBatches[(i+node)%5].push({matrix,tone:.85+r()*.25});
        if(attachments.length<64)attachments.push({node:point.toArray(),petiole:petiole.toArray(),length_m:profile.length*size});
      }
      const bloomBand=profile.bloom==='westringia'?(t>.45&&t<.95):(t>.25&&t<.8);
      if((!sage||profile.alongShoots)&&plant.flower&&r()<profile.flowerRate&&bloomBand) {
        const end=point.clone().addScaledVector(pair,.010);addWood(point,end,.0004);
        const rotation=new THREE.Quaternion().setFromUnitVectors(V(0,0,1),pair);
        const bs=profile.bloomScale??1;
        flowers.push({matrix:new THREE.Matrix4().compose(end,rotation,V(bs,bs,bs)),tone:1});
      }
    }
  }
  // The declared foliage stays the colour of the leaf tops — an explicit hex wins
  // outright. A species whose underside differs this much names that face only.
  const baseColour=new THREE.Color(foliageTint||(plant.foliage?.startsWith('#')?plant.foliage:(sage?'#8c9b85':'#566d50')));
  const colour=baseColour.clone();
  const maps=leafSurface(profile.leaf);
  // Berggarten's bitmap carries Berggarten's GREEN; a species whose own colour
  // IS its identity (apiana is silver-white) keeps the lamina and loses the map.
  const texture=(sage&&!profile.plainLeaf)?sageLeafTexture:null;
  // The bitmap carries the leaf's albedo. Multiplying by a second foliage
  // colour muddies it; inverse-average factors >1 are also invalid glTF PBR.
  if(texture)colour.set(0xffffff);
  const topMat=translucent(new THREE.MeshStandardMaterial({color:colour,vertexColors:true,
    roughness:sage?.95:.6,side:THREE.FrontSide,...maps,normalScale:new THREE.Vector2(.35,.35),...(texture?{map:texture}:{})}),translucencyFor(sage?'medium':'needle'));
  const bottomMat=translucent(new THREE.MeshStandardMaterial({color:profile.underside?new THREE.Color(profile.underside):baseColour.clone().lerp(new THREE.Color('#c2c7ac'),sage?.15:.4),
    vertexColors:true,roughness:.98,side:THREE.FrontSide,...maps}),translucencyFor(sage?'medium':'needle'));
  let leafCount=0;
  for(let i=0;i<leafBatches.length;i++) {
    const records=leafBatches[i];if(!records.length)continue;leafCount+=records.length;
    const top=shootLeaf(profile,i/5,{specimen,preview}),bottom=top.clone();
    for(let j=0;j<bottom.index.count;j+=3) {const a=bottom.index.getX(j);bottom.index.setX(j,bottom.index.getX(j+2));bottom.index.setX(j+2,a);}
    const normals=bottom.attributes.normal,positions=bottom.attributes.position;
    for(let j=0;j<normals.count;j++) {
      // Opposite faces cannot be coincident: native path tracers then pick the
      // underside material for the upper surface. Give the lamina real depth.
      const depth=sage?.00010:.00013;
      positions.setXYZ(j,positions.getX(j)-normals.getX(j)*depth,positions.getY(j)-normals.getY(j)*depth,positions.getZ(j)-normals.getZ(j)*depth);
      normals.setXYZ(j,-normals.getX(j),-normals.getY(j),-normals.getZ(j));
    }
    if(texture) {
      const uv=top.attributes.uv;
      for(let j=0;j<uv.count;j++) {
        const u=uv.getX(j),t=uv.getY(j),outline=Math.pow(Math.sin(Math.PI*t),.46);
        // Only sample the leaf interior. The generated reference plate is RGB;
        // its surrounding checkerboard is not an alpha channel or a material.
        uv.setXY(j,.5+(u*2-1)*.225*outline,.108+t*.86);
      }
    }
    group.add(instances(top,records,'foliage',topMat),instances(bottom,records,'leaf undersides',bottomMat));
  }
  if(flowers.length)group.add(instances(profile.bloom==='westringia'?westringiaFlower():rosemaryFlower(),flowers,'bloom',new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:.8,side:THREE.DoubleSide})));
  // ── THE SPIKES ────────────────────────────────────────────────────
  //
  // A salvia flowers on a TERMINAL STALK carrying whorls stacked up it, not as
  // blobs scattered over a dome. The spikes are essential to recognising a
  // salvia; accurate leaves alone cannot establish its identity.
  //
  // The colour is the plant's declared `flower`, so a Cleveland sage is violet
  // and a Rose Sage is the rose-magenta of its BRACTS — which on that species is
  // where the colour actually lives.
  if(profile.spike&&plant.flower) {
    const sp=profile.spike, stalks=[], florets=[];
    // the floret's natural size: a westringia disc is 5.2 mm across, Hot Lips' flower is its own 10.5 mm
    const lip=sp.flower==='hot_lips', unit=lip?.0105:.0052;
    const top=(plant.flowering_height_m||(profile.crown?hAll:h*sp.rise));
    for(let i=0;i<sp.count;i++) {
      // a `dome` raceme comes out anywhere on the dome, shoulders included, from just under its leaves
      const a=i*2.399+(r()-.5)*.5, rad=w*(sp.dome?.46:.36)*Math.sqrt((i+.5)/sp.count);
      // the stalk leaves the crown where the foliage actually is, not the floor
      const crown=Math.sqrt(Math.max(.02,1-(rad/(w*.51))**2));
      const base=V(Math.cos(a)*rad,sp.dome?h*(.28+.66*crown)*.8:h*(.30+.55*crown),Math.sin(a)*rad);
      const lean=(r()-.5)*.16;
      // CLAMPED to the declared height. `.82 + r()*.3` reaches 1.12, so a wand
      // could stand 12% above the flowering height the palette states — and a
      // plant that draws taller than it claims is the fault salvia.test.mjs's
      // height guard exists to catch.
      // `dome`: a short raceme on a leafy tip, standing that share of the height above the
      // foliage where it comes out — the flowers cover the mound's dome ('Hot Lips'), where
      // wands to one height make a flat-topped column over its middle. The same one draw of r().
      const tipY=sp.dome?Math.min(top,h*(.28+.66*crown)+top*sp.dome*(.8+r()*.4)):Math.min(top,top*(.82+r()*.3));
      const tip=V(base.x+lean*top*.5,tipY,base.z+lean*top*.4);
      // 5 mm of stem, in the spike's own colour. A real salvia flower stalk is
      // 3-6 mm and square in section; what matters here is that it READS, so the
      // eye joins the whorls to the plant they belong to.
      addWood(base,tip,.0050,false,sp.stem);
      const axis=tip.clone().sub(base);
      // whorls START above the foliage — `gap` is how far up the stalk the first
      // one sits, which is the difference between a wand (apiana, high and bare)
      // and a dense spike (pachyphylla, colour almost in the leaves)
      for(let k=0;k<sp.whorls;k++) {
        const t=sp.gap+(1-sp.gap)*(sp.whorls===1?1:k/(sp.whorls-1));
        const at=base.clone().addScaledVector(axis,t);
        const each=sp.each??5;
        for(let j=0;j<each;j++) {
          const b=k*1.1+j*2*Math.PI/each;
          const out=V(Math.cos(b),0,Math.sin(b)).multiplyScalar(sp.petal*1.5);
          const m=new THREE.Matrix4().compose(at.clone().add(out),
            new THREE.Quaternion().setFromUnitVectors(V(0,0,1),out.clone().normalize()),
            V(sp.petal/unit,sp.petal/unit,sp.petal/unit));
          florets.push({matrix:m,tone:.9+r()*.25});
        }
      }
    }
    if(florets.length) {
      // A SECOND COLOUR on a share of the florets: a bicolour sage reads at garden distance as its
      // two colours together — 'Hot Lips' opens red, then red-lipped and white-hooded, then white.
      // Spread by index, not drawn from r(), so the rest of the plant is the same individual.
      const two=sp.second;
      if(two)florets.forEach((f,i)=>{f.colour=(i*37%100)/100<two.share?two.colour:lip?0xffffff:plant.flower;});
      // `flower: 'hot_lips'` carries the species' own two-lipped flower, its colours in the geometry
      group.add(instances(lip?lipFlower():westringiaFlower(),florets,'bloom',
        new THREE.MeshStandardMaterial({color:new THREE.Color(two||lip?0xffffff:plant.flower),
          vertexColors:true,roughness:.8,side:THREE.DoubleSide})));
    }
    group.userData.spikeCount=sp.count;
  }
  // THE WOOD LAST. An InstancedMesh is sized from its records when it is
  // made, and the spikes above add their stalks to woodRecords. Building it first
  // omits those stalks, leaving flowers at 1.24-2.26 m floating over plants whose
  // visible stems stop at 0.97-1.44 m.
  // NOT vertexColors: the cylinder carries no colour attribute, so asking for one
  // multiplies every stem by WebGL's default (0,0,0) and draws the rosemary and
  // coast rosemary skeletons BLACK. The bark tone rides in instanceColor.
  group.add(instances(new THREE.CylinderGeometry(.64,1,1,5,1),woodRecords,'wood',
    new THREE.MeshStandardMaterial({color:0xffffff,roughness:1})));
  group.userData.shootModel=true;group.userData.leafCount=leafCount;group.userData.leafAttachments=attachments;
  group.userData.species=plant.species;group.userData.quality='reference-modelled approximation; not a scan';
  if(texture)group.userData.textureAttribution={author:'AI-generated adaptation; reference photograph by David J. Stang',
    source:'https://commons.wikimedia.org/wiki/File:Salvia_officinalis_Berggarten_1zz.jpg',
    license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',modified:true};
  return group;
}

/** Westringia's flower: 1 cm across, five white lobes, the upper one cleft, pink
 * spots in the throat — the reference photograph's flower, facing out along +Z. */
function westringiaFlower() {
  const P=[0,0,0],C=[.96,.9,.93],I=[],steps=40,R=.0052;
  for(let i=0;i<=steps;i++) {
    const a=i/steps*Math.PI*2,lobe=.55+.45*Math.abs(Math.cos(a*2.5)),r=R*lobe;
    P.push(Math.cos(a)*r,Math.sin(a)*r,.0006*Math.sin(a*5));C.push(1,1,.99);
    if(i)I.push(0,i,i+1);
  }
  // throat spots: a ring of pink just outside the centre
  for(let i=0;i<10;i++) {
    const a=i/10*Math.PI*2,x=Math.cos(a)*.0017,y=Math.sin(a)*.0017,b=P.length/3;
    P.push(x-.00035,y,.0002,x+.00035,y,.0002,x,y+.0005,.0002);C.push(.86,.5,.62,.86,.5,.62,.86,.5,.62);I.push(b,b+1,b+2);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));
  g.setIndex(I);g.computeVertexNormals();return g;
}

function instances(geometry,records,name,material) {
  const mesh=new THREE.InstancedMesh(geometry,material,records.length),colour=new THREE.Color();
  records.forEach((r,i)=>{mesh.setMatrixAt(i,r.matrix);colour.set(r.colour||0xffffff).multiplyScalar(r.tone);mesh.setColorAt(i,colour);});
  mesh.name=name;mesh.castShadow=mesh.receiveShadow=true;
  mesh.computeBoundingBox();mesh.computeBoundingSphere();return mesh;
}
