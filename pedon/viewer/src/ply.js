// Minimal PLY reader (binary little/big-endian + ascii) for non-splat stages.
// Gaussian-splat PLYs (Scaniverse splat export) go to Spark's own loader; this
// module handles header sniffing and plain point-cloud PLYs (mesh-scan export).

const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

function parseHeader(buf) {
  // Locate end_header by raw byte scan: immune to CRLF line endings and to
  // non-UTF-8 comment bytes (a decode/re-encode round-trip shifts the offset).
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536));
  const tag = [0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72]; // "end_header"
  let tagAt = -1;
  scan: for (let i = 0; i + tag.length < bytes.length; i++) {
    if (i > 0 && bytes[i - 1] !== 0x0a) continue;                    // must start a line
    for (let j = 0; j < tag.length; j++) if (bytes[i + j] !== tag[j]) continue scan;
    const after = bytes[i + tag.length];
    if (after === 0x0a || (after === 0x0d && bytes[i + tag.length + 1] === 0x0a)) { tagAt = i; break; }
  }
  if (tagAt < 0) throw new Error("PLY: header not found");
  let bodyOffset = tagAt + tag.length;
  if (bytes[bodyOffset] === 0x0d) bodyOffset++;
  bodyOffset++; // the \n
  const header = new TextDecoder().decode(bytes.subarray(0, tagAt));

  let format = "";
  let vertexCount = 0;
  const props = []; // vertex-element properties only
  let inVertex = false;
  for (const line of header.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") {
      inVertex = t[1] === "vertex";
      if (inVertex) vertexCount = parseInt(t[2], 10);
    } else if (t[0] === "property" && inVertex) {
      if (t[1] === "list") throw new Error("PLY: list property in vertex element unsupported");
      props.push({ type: t[1], name: t[2] });
    }
  }
  const stride = props.reduce((s, p) => s + SIZES[p.type], 0);
  const offsets = {};
  let off = 0;
  for (const p of props) { offsets[p.name] = { off, type: p.type }; off += SIZES[p.type]; }
  for (const a of ["x", "y", "z"]) if (!(a in offsets)) throw new Error(`PLY: no ${a} property`);
  return { format, vertexCount, props, stride, offsets, bodyOffset };
}

// A Gaussian-splat PLY carries per-splat covariance/opacity attributes that a
// plain point cloud lacks. A header this minimal parser can't read (packed or
// compressed splat variants, oversized headers) defers to Spark's loader,
// which reads any splat PLY.
export function isSplatPly(buf) {
  try { return "scale_0" in parseHeader(buf).offsets; }
  catch { return true; }
}

// Positions (+ colors if present) of a point-cloud PLY, subsampled to maxPoints.
// Returns { positions: Float32Array, colors: Float32Array|null, count }.
export async function loadPlyPointCloud(source, maxPoints = 1_200_000) {
  const buf = source instanceof ArrayBuffer ? source : await (await fetch(source)).arrayBuffer();
  const { format, vertexCount, props, stride, offsets, bodyOffset } = parseHeader(buf);
  if (!vertexCount) throw new Error("PLY: no vertices");

  const hasColor = "red" in offsets && "green" in offsets && "blue" in offsets;
  // 1-byte colors are 0..255, 2-byte 0..65535; float colors are already 0..1
  const colorSize = hasColor ? SIZES[offsets.red.type] : 0;
  const colorScale = colorSize === 1 ? 1 / 255 : colorSize === 2 ? 1 / 65535 : 1;

  const step = Math.max(1, Math.floor(vertexCount / maxPoints));
  const n = Math.ceil(vertexCount / step);
  const positions = new Float32Array(n * 3);
  const colors = hasColor ? new Float32Array(n * 3) : null;
  let k = 0;

  if (format === "ascii") {
    const text = new TextDecoder().decode(buf.slice(bodyOffset));
    const rows = text.split("\n");
    const col = name => props.findIndex(p => p.name === name);
    const xi = col("x"), yi = col("y"), zi = col("z");
    const ri = col("red"), gi = col("green"), bi = col("blue");
    for (let i = 0; i < vertexCount; i += step, k++) {
      const c = rows[i].trim().split(/\s+/);
      positions[k * 3] = parseFloat(c[xi]);
      positions[k * 3 + 1] = parseFloat(c[yi]);
      positions[k * 3 + 2] = parseFloat(c[zi]);
      if (colors) {
        colors[k * 3] = parseFloat(c[ri]) * colorScale;
        colors[k * 3 + 1] = parseFloat(c[gi]) * colorScale;
        colors[k * 3 + 2] = parseFloat(c[bi]) * colorScale;
      }
    }
  } else {
    const little = format === "binary_little_endian";
    const dv = new DataView(buf, bodyOffset);
    const read = (byteOff, type) => {
      switch (type) {
        case "float": case "float32": return dv.getFloat32(byteOff, little);
        case "double": case "float64": return dv.getFloat64(byteOff, little);
        case "uchar": case "uint8": return dv.getUint8(byteOff);
        case "char": case "int8": return dv.getInt8(byteOff);
        case "short": case "int16": return dv.getInt16(byteOff, little);
        case "ushort": case "uint16": return dv.getUint16(byteOff, little);
        case "int": case "int32": return dv.getInt32(byteOff, little);
        case "uint": case "uint32": return dv.getUint32(byteOff, little);
        default: throw new Error("PLY type " + type);
      }
    };
    for (let i = 0; i < vertexCount; i += step, k++) {
      const base = i * stride;
      positions[k * 3] = read(base + offsets.x.off, offsets.x.type);
      positions[k * 3 + 1] = read(base + offsets.y.off, offsets.y.type);
      positions[k * 3 + 2] = read(base + offsets.z.off, offsets.z.type);
      if (colors) {
        colors[k * 3] = read(base + offsets.red.off, offsets.red.type) * colorScale;
        colors[k * 3 + 1] = read(base + offsets.green.off, offsets.green.type) * colorScale;
        colors[k * 3 + 2] = read(base + offsets.blue.off, offsets.blue.type) * colorScale;
      }
    }
  }
  return {
    positions: positions.slice(0, k * 3),
    colors: colors ? colors.slice(0, k * 3) : null,
    count: k,
  };
}
