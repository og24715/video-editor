import type { ChromaKeySettings, CropRect } from "./model";

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uCropUv;
uniform vec3 uKey;
uniform float uTol;
uniform float uSoft;

vec2 chromaOf(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  return vec2(cb, cr);
}

void main() {
  vec2 uv = uCropUv.xy + vUv * uCropUv.zw;
  vec4 col = texture2D(uTex, uv);
  float d = distance(chromaOf(col.rgb), chromaOf(uKey));
  float alpha = smoothstep(uTol, uTol + max(uSoft, 0.001), d);
  vec3 rgb = col.rgb;
  float spill = (1.0 - alpha) * 0.85;
  if (uKey.g > uKey.r && uKey.g > uKey.b) {
    float cap = max(col.r, col.b);
    if (rgb.g > cap) rgb.g = mix(rgb.g, cap, spill);
  } else if (uKey.b > uKey.r && uKey.b > uKey.g) {
    float cap = max(col.r, col.g);
    if (rgb.b > cap) rgb.b = mix(rgb.b, cap, spill);
  }
  gl_FragColor = vec4(rgb, col.a * alpha);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [0, 1, 0];
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export class ChromaKeyer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private texture: WebGLTexture | null = null;
  private uCropUv: WebGLUniformLocation | null = null;
  private uKey: WebGLUniformLocation | null = null;
  private uTol: WebGLUniformLocation | null = null;
  private uSoft: WebGLUniformLocation | null = null;

  constructor(existingCanvas?: HTMLCanvasElement) {
    this.canvas = existingCanvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return;
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
    this.uCropUv = gl.getUniformLocation(program, "uCropUv");
    this.uKey = gl.getUniformLocation(program, "uKey");
    this.uTol = gl.getUniformLocation(program, "uTol");
    this.uSoft = gl.getUniformLocation(program, "uSoft");
    this.gl = gl;
  }

  get ok(): boolean {
    return this.gl !== null;
  }

  render(
    source: TexImageSource,
    sourceWidth: number,
    sourceHeight: number,
    crop: CropRect,
    settings: ChromaKeySettings,
  ): boolean {
    const gl = this.gl;
    if (!gl || sourceWidth <= 0 || sourceHeight <= 0) return false;
    const width = Math.max(1, Math.round(crop.width));
    const height = Math.max(1, Math.round(crop.height));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }
    const uploadFlipped = !(typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap);
    const tOrigin = uploadFlipped
      ? 1 - (crop.y + crop.height) / sourceHeight
      : (crop.y + crop.height) / sourceHeight;
    const tScale = (uploadFlipped ? 1 : -1) * (crop.height / sourceHeight);
    gl.uniform4f(this.uCropUv, crop.x / sourceWidth, tOrigin, crop.width / sourceWidth, tScale);
    const [kr, kg, kb] = hexToRgb(settings.color);
    gl.uniform3f(this.uKey, kr, kg, kb);
    gl.uniform1f(this.uTol, Math.max(0, Math.min(1, settings.tolerance)));
    gl.uniform1f(this.uSoft, Math.max(0, Math.min(1, settings.softness)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}
