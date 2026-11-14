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
    this.bright = fsPass(`in vec2 vUv; uniform sampler2D t; ${SAFE} void main(){ vec3 c = safeC(texture(t, vUv).rgb); vec3 b = max(c - 1.5, 0.0); gl_FragColor = vec4(b/(1.0 + max(b.r, max(b.g, b.b))/25.0), 1.0); }`, { t: { value: null } });
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
  // Sun star: diffraction spikes from the eye's/camera's aperture, drawn additively around the Sun's screen position.
  // pos: pixel position in the render target; col: RGB strength (0 = off); len: spike length (px)
  sunStar(pos, col, len, flare = 1) {
    if (!this.star) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uC: { value: new THREE.Vector2() }, uCen: { value: new THREE.Vector2() }, uCol: { value: new THREE.Vector3() }, uLen: { value: 100 }, uRot: { value: 0.3 }, uFlare: { value: 1 } },
        depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        // The eye's glare around a bright point (ciliary corona): many fine needle rays of uneven length and strength
        // radiating from a soft halo, instead of a camera's few hard spikes.
        fragmentShader: `uniform vec2 uC, uCen; uniform vec3 uCol; uniform float uLen, uRot, uFlare;
          float h1(float x){ return fract(sin(x*127.1)*43758.5453); }
          float n1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f); return mix(h1(i), h1(i + 1.0), f); }
          void main(){
            vec2 p = gl_FragCoord.xy - uC; float r = length(p), th = atan(p.y, p.x) + uRot;
            float t = th/6.2831853 + 0.5;
            // three families of rays: many fine ones, fewer brighter ones, a handful of long faint streaks
            float f1 = n1(t*260.0), f2 = n1(t*96.0 + 17.0), f3 = n1(t*31.0 + 41.0);
            float len1 = uLen*(0.25 + 0.55*n1(t*260.0 + 5.3)), len2 = uLen*(0.35 + 0.65*n1(t*96.0 + 9.1)), len3 = uLen*(0.5 + 0.5*n1(t*31.0 + 2.7));
            // each ray fades out by its own length (Gaussian), so the star ends cleanly instead of trailing across the view
            float rays = pow(f1, 9.0)*exp(-pow(r/len1, 2.0))*0.9 + pow(f2, 12.0)*exp(-pow(r/len2, 2.0))*1.0 + pow(f3, 20.0)*exp(-pow(r/len3, 2.0))*0.7;
            rays *= smoothstep(1.0, 8.0, r);
            // diffuse halo: bright core falling off smoothly, plus a wide faint veil
            float halo = exp(-r/(uLen*0.08))*0.9 + 0.35/(1.0 + pow(r/(uLen*0.12), 1.6)) + 0.05*exp(-r/(uLen*1.2));
            vec3 c = uCol*(rays*0.9 + halo);
            // lens flare: ghost images of the aperture along the line from the Sun through the image centre
            if (uFlare > 0.0) {
              vec2 axis = uCen - uC; float S = uLen*0.9;
              const int NG = 7;
              float kk[NG] = float[NG](0.35, 0.62, 0.9, 1.25, 1.55, 1.9, 2.3);
              float rr[NG] = float[NG](0.10, 0.05, 0.22, 0.08, 0.35, 0.14, 0.5);
              vec3 tc[NG] = vec3[NG](vec3(0.5, 0.8, 1.0), vec3(1.0, 0.8, 0.4), vec3(0.4, 1.0, 0.6), vec3(1.0, 0.5, 0.7), vec3(0.6, 0.7, 1.0), vec3(1.0, 0.9, 0.6), vec3(0.5, 0.9, 1.0));
              float aa[NG] = float[NG](0.07, 0.12, 0.035, 0.07, 0.025, 0.05, 0.018);
              for (int i = 0; i < NG; i++) {
                vec2 q = gl_FragCoord.xy - (uC + axis*kk[i]); float R = rr[i]*S;
                // hexagonal aperture blades: distance to a regular hexagon
                vec2 a = abs(q); float hx = max(a.x*0.866 + a.y*0.5, a.y);
                float disc = smoothstep(R, R*0.88, hx), rim = smoothstep(R*0.8, R*0.97, hx)*disc;
                c += tc[i]*uCol*aa[i]*(disc*0.6 + rim*0.8)*uFlare;
              }
              // faint halo ring centred on the Sun
              float ring = exp(-pow((r - S*1.15)/(S*0.05), 2.0));
              c += vec3(0.7, 0.85, 1.0)*uCol*0.02*ring*uFlare;
            }
            gl_FragColor = vec4(min(c, vec3(60.0)), 1.0);
          }`,
      });
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; this.star = new THREE.Scene(); this.star.add(m); this.starU = mat.uniforms;
    }
    if (!(col[0] + col[1] + col[2] > 0.001)) return;
    this.starU.uC.value.set(pos[0], pos[1]); this.starU.uCol.value.set(col[0], col[1], col[2]); this.starU.uLen.value = len;
    this.starU.uCen.value.set(this.rt.width / 2, this.rt.height / 2); this.starU.uFlare.value = flare;
    this.r.setRenderTarget(this.rt); this.r.render(this.star, CAM);
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
