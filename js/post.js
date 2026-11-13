// HDR pipeline shared by all three views (from SkyScout): scene -> half-float target -> bloom -> tone map + dither.
// Every bright value is clamped before blending: iPhones overflow half floats from the Sun into black boxes.
import * as THREE from '../vendor/three.module.min.js';

const SAFE = 'vec3 safeC(vec3 c){ return vec3(c.r >= 0.0 ? min(c.r, 3.0e4) : 0.0, c.g >= 0.0 ? min(c.g, 3.0e4) : 0.0, c.b >= 0.0 ? min(c.b, 3.0e4) : 0.0); }';
const CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function fsPass(frag, uniforms) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mat = new THREE.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false, vertexShader: 'out vec2 vUv; void main(){ vUv = position.xy*0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: frag });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; const scene = new THREE.Scene(); scene.add(m);
  return { scene, mat };
}
export class Post {
  constructor(renderer) {
    this.r = renderer;
    this.bright = fsPass(`in vec2 vUv; uniform sampler2D t; ${SAFE} void main(){ vec3 c = safeC(texture(t, vUv).rgb); vec3 b = max(c - 1.5, 0.0); gl_FragColor = vec4(b/(1.0 + dot(b, vec3(0.3))*0.02), 1.0); }`, { t: { value: null } });
    this.blur = fsPass(`in vec2 vUv; uniform sampler2D t; uniform vec2 d; void main(){ vec3 s = texture(t, vUv).rgb*0.227; for (int i = 1; i < 5; i++){ float w = float[5](0.227,0.194,0.121,0.054,0.016)[i]; s += (texture(t, vUv + d*float(i)).rgb + texture(t, vUv - d*float(i)).rgb)*w; } gl_FragColor = vec4(s, 1.0); }`, { t: { value: null }, d: { value: new THREE.Vector2() } });
    this.final = fsPass(`in vec2 vUv; uniform sampler2D t, tB1, tB2; uniform float uScot, uBloom; ${SAFE}
      vec3 tm(vec3 x){ return x*(1.0 + x/9.0)/(1.0 + x); }
      void main(){
        vec2 o1 = 0.6/vec2(textureSize(tB1, 0)), o2 = 0.6/vec2(textureSize(tB2, 0));
        vec3 b1 = (texture(tB1, vUv + o1*vec2(1,1)).rgb + texture(tB1, vUv + o1*vec2(-1,1)).rgb + texture(tB1, vUv + o1*vec2(1,-1)).rgb + texture(tB1, vUv - o1).rgb)*0.25;
        vec3 b2 = (texture(tB2, vUv + o2*vec2(1,1)).rgb + texture(tB2, vUv + o2*vec2(-1,1)).rgb + texture(tB2, vUv + o2*vec2(1,-1)).rgb + texture(tB2, vUv - o2).rgb)*0.25;
        vec3 c = safeC(texture(t, vUv).rgb) + (safeC(b1)*0.06 + safeC(b2)*0.05)*uBloom;
        float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(L)*vec3(0.78, 0.92, 1.18), uScot);
        c = pow(tm(max(c, 0.0)), vec3(1.0/2.2));
        float n1 = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float n2 = fract(52.9829189*fract(dot(gl_FragCoord.xy + vec2(17.3, 41.7), vec2(0.00583715, 0.06711056))));
        gl_FragColor = vec4(c + (n1 + n2 - 1.0)/255.0*2.0, 1.0);
      }`, { t: { value: null }, tB1: { value: null }, tB2: { value: null }, uScot: { value: 0 }, uBloom: { value: 1 } });
  }
  size(w, h) {
    if (this.w === w && this.h === h) return; this.w = w; this.h = h;
    const hf = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    if (this.rt) [this.rt, this.b1, this.b1b, this.b2, this.b2b].forEach(t => t.dispose());
    this.rt = new THREE.WebGLRenderTarget(w, h, { ...hf, depthBuffer: true });
    const q = (s) => new THREE.WebGLRenderTarget(Math.max(2, w >> s), Math.max(2, h >> s), { ...hf, depthBuffer: false });
    this.b1 = q(2); this.b1b = q(2); this.b2 = q(4); this.b2b = q(4);
  }
  finish() {
    const r = this.r;
    this.bright.mat.uniforms.t.value = this.rt.texture; r.setRenderTarget(this.b1); r.render(this.bright.scene, CAM);
    const bl = (s, d, dx, dy) => { this.blur.mat.uniforms.t.value = s.texture; this.blur.mat.uniforms.d.value.set(dx / s.width, dy / s.height); r.setRenderTarget(d); r.render(this.blur.scene, CAM); };
    bl(this.b1, this.b1b, 1, 0); bl(this.b1b, this.b1, 0, 1);
    bl(this.b1, this.b2, 2, 0); bl(this.b2, this.b2b, 0, 2); bl(this.b2b, this.b2, 2, 0); bl(this.b2, this.b2b, 0, 2);
    const u = this.final.mat.uniforms; u.t.value = this.rt.texture; u.tB1.value = this.b1.texture; u.tB2.value = this.b2b.texture;
    r.setRenderTarget(null); r.render(this.final.scene, CAM);
  }
}
