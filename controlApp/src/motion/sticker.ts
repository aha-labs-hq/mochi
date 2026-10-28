import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from "three";

/** A single paper surface, not a second character player. The existing timeline
 * supplies every pose; this material owns only the substrate and compositing.
 * Original assets, alpha, facial geometry and atlas seams are never rewritten. */
export class StickerSurface {
  private readonly renderer: WebGLRenderer;
  private texture: CanvasTexture;
  private readonly geometry = new PlaneGeometry(2, 2, 1, 48);
  private readonly material: ShaderMaterial;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private paper = 0;
  private curl = 0;
  private previousTime: number | null = null;
  private disposed = false;
  private sourceWidth: number;
  private sourceHeight: number;
  private outputSize: { width: number; height: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly source: HTMLCanvasElement,
    private readonly onFailure: () => void,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    this.sourceWidth = source.width;
    this.sourceHeight = source.height;
    this.renderer.setSize(source.width, source.height, false);
    this.renderer.setClearColor(0, 0);
    this.renderer.debug.onShaderError = onFailure;
    this.texture = this.createTexture();
    this.material = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      uniforms: {
        image: { value: this.texture },
        texel: { value: new Vector2(1 / source.width, 1 / source.height) },
        paper: { value: 0 },
        curl: { value: 0 },
      },
      vertexShader: `
        varying vec2 imageUV;
        varying float light;
        uniform float curl;
        void main() {
          imageUV = uv;
          vec3 p = position;
          float t = (p.y + 1.0) * 0.5;
          float angle = curl * t;
          if (abs(curl) > 0.0001) {
            p.y = -1.0 + 2.0 * sin(angle) / curl;
            p.z = 2.0 * (1.0 - cos(angle)) / curl;
          }
          light = 1.0 - 0.10 * sin(angle);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 imageUV;
        varying float light;
        uniform sampler2D image;
        uniform vec2 texel;
        uniform float paper;
        vec4 sampleInkAt(vec2 point, float bias) {
          vec4 value = texture2D(image, point, bias);
          if (value.a > 0.0) value.rgb /= value.a;
          return value;
        }
        void main() {
          vec4 ink = sampleInkAt(imageUV, 0.0);
          float edge = ink.a;
          // Colour and coverage are compiled once into the source assets.
          // Runtime only draws the paper underneath the unchanged character.
          if (paper > 0.001 && ink.a < 0.999) {
            for (int direction = 0; direction < 32; direction++) {
              float angle = float(direction) * 0.1963495408;
              vec2 ray = vec2(cos(angle), sin(angle));
              edge = max(edge, texture2D(image, imageUV + ray * texel * 5.0, -16.0).a);
            }
          }
          // Paper is a clean cut edge behind the fibers, not a second fuzzy halo.
          float substrate = smoothstep(0.05, 0.85, edge) * paper;
          float alpha = ink.a + substrate * (1.0 - ink.a);
          vec3 rgb = ink.rgb * ink.a + vec3(0.99, 0.98, 0.96) * substrate * (1.0 - ink.a);
          // Explicit premultiplied output: neither Three nor the browser applies
          // source-over twice. No lights, tone mapping, gloss or texture tint.
          gl_FragColor = vec4(rgb * light, alpha);
        }
      `,
    });
    this.camera.position.z = 4;
    this.scene.add(new Mesh(this.geometry, this.material));
    canvas.addEventListener("webglcontextlost", this.contextLost);
  }

  /** Rasterize at the actual display density instead of enlarging a fixed 512px canvas. */
  resize(width: number, height: number): void {
    const size = {
      width: Math.max(1, Math.min(2048, Math.round(width))),
      height: Math.max(1, Math.min(2048, Math.round(height))),
    };
    if (
      this.outputSize?.width === size.width &&
      this.outputSize.height === size.height
    )
      return;
    this.outputSize = size;
    this.renderer.setSize(size.width, size.height, false);
    // Changing a WebGL backing store clears it immediately. ResizeObserver can
    // run after the frame callback, including while the player is paused for a
    // native handoff. Repaint the held pose before this callback returns.
    if (this.previousTime !== null)
      this.renderer.render(this.scene, this.camera);
  }

  draw(
    changed: boolean,
    paper: boolean,
    curled: boolean,
    reduced: boolean,
    now: number,
  ): void {
    if (this.disposed) return;
    if (
      this.sourceWidth !== this.source.width ||
      this.sourceHeight !== this.source.height
    ) {
      this.sourceWidth = this.source.width;
      this.sourceHeight = this.source.height;
      if (!this.outputSize)
        this.renderer.setSize(this.source.width, this.source.height, false);
      // Three's uploaded texture storage is immutable in size. Retain the
      // canvas/context, but replace only its GPU texture at a stage boundary.
      this.texture.dispose();
      this.texture = this.createTexture();
      this.material.uniforms.image!.value = this.texture;
      this.material.uniforms.texel!.value.set(
        1 / this.source.width,
        1 / this.source.height,
      );
      changed = true;
    }
    const dt =
      this.previousTime === null
        ? 0
        : Math.min(0.1, (now - this.previousTime) / 1000);
    const first = this.previousTime === null;
    this.previousTime = now;
    const targetPaper = Number(paper);
    const targetCurl = curled && !reduced ? 0.34 : 0;
    const blend = reduced || first ? 1 : 1 - Math.exp(-dt * 9);
    const nextPaper = this.approach(this.paper, targetPaper, blend);
    const nextCurl = this.approach(this.curl, targetCurl, blend);
    if (
      !changed &&
      nextPaper === this.paper &&
      nextCurl === this.curl &&
      !first
    )
      return;
    this.paper = nextPaper;
    this.curl = nextCurl;
    this.material.uniforms.paper!.value = this.paper;
    this.material.uniforms.curl!.value = this.curl;
    if (changed) this.texture.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.texture.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }

  private createTexture(): CanvasTexture {
    const texture = new CanvasTexture(this.source);
    texture.colorSpace = NoColorSpace;
    // Interpolate coverage-weighted RGB. Straight-alpha filtering mixes invisible
    // background RGB into the fur when the canvas is resized or moved fractionally.
    texture.premultiplyAlpha = true;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    return texture;
  }

  private approach(value: number, target: number, blend: number): number {
    const next = value + (target - value) * blend;
    return Math.abs(next - target) < 0.0001 ? target : next;
  }
  private contextLost = (event: Event): void => {
    event.preventDefault();
    // Explicit resource failure, never a silent second rendering backend.
    this.onFailure();
  };
}
