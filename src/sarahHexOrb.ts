import * as THREE from 'three';

type SegmentData = {
  mesh: THREE.Mesh;
  baseNormal: THREE.Vector3;
  basePosition: THREE.Vector3;
  randomVec: THREE.Vector3;
  randomPhase: number;
  randomStrength: number;
};

type SarahHexOrbOptions = {
  accentColor?: string;
  outlineColor?: string;
  shellColor?: string;
  radius?: number;
  segmentRadius?: number;
};

export class SarahHexOrb {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private root = new THREE.Group();
  private shellGroup = new THREE.Group();

  private segments: SegmentData[] = [];

  private accentColor: THREE.Color;
  private outlineColor: THREE.Color;
  private shellColor: THREE.Color;

  private innerSphere: THREE.Mesh | null = null;
  private innerMaterial: THREE.MeshPhysicalMaterial | null = null;
  private innerIdleColor: THREE.Color;
  private innerAccentColor: THREE.Color;
  private innerRadius: number;

  private time = 0;
  private breaking = false;
  private breakStart = 0;
  private breakDurationMs = 2000;
  private animationFrameId: number | null = null;

  private radius: number;
  private segmentRadius: number;

  // Light references for dynamic intensity control
  private ambientLight: THREE.AmbientLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private fillLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.PointLight | null = null;

  // Base intensities (set in createLights)
  private baseLightIntensities = {
    ambient: 0.95,
    key: 2.4,
    fill: 0.7,
    rim: 1.1,
  };
  private lightFactor = 1.0;

  constructor(
    private container: HTMLElement,
    options: SarahHexOrbOptions = {},
  ) {
    this.accentColor = new THREE.Color(options.accentColor ?? '#6ee7ff');
    this.outlineColor = new THREE.Color(
      options.accentColor ?? '#6ee7ff',
    ).multiplyScalar(0.75);
    this.shellColor = new THREE.Color(options.shellColor ?? '#d4af37');

    this.radius = options.radius ?? 1;
    this.segmentRadius = options.segmentRadius ?? 0.116;

    this.innerIdleColor = this.shellColor.clone();
    this.innerAccentColor = this.accentColor.clone();
    this.innerRadius = this.radius - 0.075;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      42,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      100,
    );
    this.camera.position.set(0, 0.15, 5.5);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(
      Math.max(1, container.clientWidth),
      Math.max(1, container.clientHeight),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    container.appendChild(this.renderer.domElement);

    this.createLights();
    this.createInnerSphere();
    this.createShell();

    this.root.add(this.shellGroup);
    this.scene.add(this.root);

    this.handleResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.handleResize);

    // Flex containers may not have dimensions yet at construction time.
    // Use ResizeObserver to catch the first proper layout.
    const ro = new ResizeObserver(() => {
      this.handleResize();
      if (this.container.clientWidth > 1 && this.container.clientHeight > 1) {
        ro.disconnect();
      }
    });
    ro.observe(this.container);

    this.animate();
  }

  private createLights() {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.keyLight.position.set(3.2, 4.4, 5.8);
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0x9fd3ff, 0.7);
    this.fillLight.position.set(-4.2, -1.8, 2.2);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.PointLight(this.accentColor, 1.1, 14);
    this.rimLight.position.set(-2.2, 1.3, 2.6);
    this.scene.add(this.rimLight);
  }

  private createInnerSphere() {
    const geometry = new THREE.SphereGeometry(this.innerRadius, 64, 64);

    const material = new THREE.MeshPhysicalMaterial({
      color: this.innerIdleColor.clone(),
      emissive: this.innerIdleColor.clone(),
      emissiveIntensity: 0.025,
      roughness: 0.22,
      metalness: 0.18,
      clearcoat: 0.9,
      clearcoatRoughness: 0.9,
      transparent: false,
      reflectivity: 0.7,
      side: THREE.FrontSide,
    });

    const sphere = new THREE.Mesh(geometry, material);
    sphere.renderOrder = 0;

    this.innerSphere = sphere;
    this.innerMaterial = material;

    this.root.add(sphere);
  }

  private createShell() {
    const points = this.generateFibonacciSphere(440, this.radius);

    const plateShape = this.createHexShape(this.segmentRadius);
    const plateGeometry = new THREE.ExtrudeGeometry(plateShape, {
      depth: 0.032,
      bevelEnabled: false,
      curveSegments: 6,
      steps: 1,
    });
    plateGeometry.center();

    const shellMaterial = new THREE.MeshPhysicalMaterial({
      color: this.shellColor,
      roughness: 0.7,
      metalness: 0.9,
      clearcoat: 0.2,
      clearcoatRoughness: 0.08,
      reflectivity: 0.1,
      envMapIntensity: 0.15,
      side: THREE.DoubleSide,
    });

    const outlineMaterial = new THREE.MeshBasicMaterial({
      color: this.outlineColor,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    for (const point of points) {
      const normal = point.clone().normalize();
      const plateGroup = new THREE.Group();

      const plateGeo = plateGeometry.clone();
      plateGeo.computeVertexNormals();
      const normals = plateGeo.attributes.normal;
      for (let i = 0; i < normals.count; i++) {
        normals.setXYZ(i, 0, 0, 1);
      }
      normals.needsUpdate = true;

      const plate = new THREE.Mesh(plateGeo, shellMaterial.clone());
      plate.castShadow = false;
      plate.receiveShadow = false;

      const outline = new THREE.Mesh(plateGeometry, outlineMaterial.clone());
      outline.scale.setScalar(1.055);
      outline.renderOrder = 2;

      plateGroup.add(outline);
      plateGroup.add(plate);

      plateGroup.position.copy(point);
      plateGroup.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        normal,
      );

      plateGroup.rotateZ(Math.random() * Math.PI * 2);

      this.shellGroup.add(plateGroup);

      this.segments.push({
        mesh: plateGroup as unknown as THREE.Mesh,
        baseNormal: normal,
        basePosition: point.clone(),
        randomVec: new THREE.Vector3(
          Math.random() - 0.5,
          Math.random() - 0.5,
          Math.random() - 0.5,
        ).normalize(),
        randomPhase: Math.random() * Math.PI * 2,
        randomStrength: 0.75 + Math.random() * 0.5,
      });
    }
  }

  private createHexShape(r: number): THREE.Shape {
    const shape = new THREE.Shape();

    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;

      if (i === 0) {
        shape.moveTo(x, y);
      } else {
        shape.lineTo(x, y);
      }
    }

    shape.closePath();
    return shape;
  }

  private generateFibonacciSphere(
    count: number,
    radius: number,
  ): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    const phi = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * i;
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;

      pts.push(new THREE.Vector3(x * radius, y * radius, z * radius));
    }

    return pts;
  }

  private rangeProgress(t: number, start: number, end: number): number {
    if (t <= start) return 0;
    if (t >= end) return 1;
    return (t - start) / (end - start);
  }

  public setAccentColor(color: string) {
    this.accentColor.set(color);
    this.outlineColor.set(color);
    this.innerAccentColor.set(color);

    this.segments.forEach((segment) => {
      const group = segment.mesh as unknown as THREE.Group;
      const outline = group.children[0] as THREE.Mesh;
      const mat = outline.material as THREE.MeshBasicMaterial;
      mat.color = this.outlineColor;
    });
  }

  public setShellColor(color: string) {
    this.shellColor.set(color);
    this.innerIdleColor = this.shellColor.clone();

    this.segments.forEach((segment) => {
      const group = segment.mesh as unknown as THREE.Group;
      const plate = group.children[1] as THREE.Mesh;
      const mat = plate.material as THREE.MeshPhysicalMaterial;
      mat.color = this.shellColor;
    });

    if (this.innerMaterial && !this.breaking) {
      this.innerMaterial.color.copy(this.innerIdleColor);
      this.innerMaterial.emissive.copy(this.innerIdleColor);
    }
  }

  /** Set overall light intensity factor (0 = off, 1 = normal). */
  public setLightIntensity(factor: number): void {
    this.lightFactor = factor;
    const b = this.baseLightIntensities;
    if (this.ambientLight) this.ambientLight.intensity = b.ambient * factor;
    if (this.keyLight) this.keyLight.intensity = b.key * factor;
    if (this.fillLight) this.fillLight.intensity = b.fill * factor;
    if (this.rimLight) this.rimLight.intensity = b.rim * factor;
  }

  /** Set the orb root scale uniformly. */
  public setOrbScale(scale: number): void {
    this.root.scale.setScalar(scale);
  }

  /** Offset the orb root position (e.g. to simulate approach from below). */
  public setOrbOffset(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
  }

  /** Set the color of all scene lights (key, fill, rim). Ambient stays neutral. */
  public setLightColor(r: number, g: number, b: number): void {
    const color = new THREE.Color(r, g, b);
    if (this.keyLight) this.keyLight.color.copy(color);
    if (this.fillLight) this.fillLight.color.copy(color);
    if (this.rimLight) this.rimLight.color.copy(color);
  }

  public triggerBreak(durationMs = 3000) {
    this.breakDurationMs = durationMs;
    this.breaking = true;
    this.breakStart = performance.now();
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);

    const now = performance.now();
    this.time += 0.016;

    let breakProgress = 0;

    if (this.breaking) {
      breakProgress = Math.min(
        1,
        (now - this.breakStart) / this.breakDurationMs,
      );

      if (breakProgress >= 1) {
        this.breaking = false;
      }
    }

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const t = easeOutCubic(breakProgress);
    const envelope = this.breaking ? Math.sin(t * Math.PI) : 0;

    const accentIn = this.breaking
      ? this.rangeProgress(breakProgress, 0.01, 0.05)
      : 0;

    const accentOut = this.breaking
      ? this.rangeProgress(breakProgress, 0.95, 1.0)
      : 0;

    this.root.rotation.y += 0.0022;
    this.root.rotation.x = Math.sin(this.time * 0.33) * 0.035;

    if (this.innerSphere && this.innerMaterial) {
      const innerColor = this.innerIdleColor.clone();

      innerColor.lerp(this.innerAccentColor, accentIn);

      if (accentOut > 0) {
        innerColor.lerp(this.innerIdleColor, accentOut);
      }

      this.innerMaterial.color.copy(innerColor);
      this.innerMaterial.emissive.copy(innerColor);

      const activeGlow = accentIn * (1 - accentOut);
      const idlePulse = 0.6 + Math.sin(this.time * 2) * 0.2;
      this.innerMaterial.emissiveIntensity = idlePulse + activeGlow * 0.38;

      const pulse =
        1 + envelope * 0.01 + Math.sin(this.time * 3.2) * 0.0025 * envelope;

      this.innerSphere.scale.setScalar(pulse);
    }

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      const group = segment.mesh as unknown as THREE.Group;
      const outline = group.children[0] as THREE.Mesh;
      const plate = group.children[1] as THREE.Mesh;

      const microWobble =
        Math.sin(this.time * 2.3 + segment.randomPhase) *
        0.0045 *
        envelope *
        segment.randomStrength;

      const breakAmount = envelope * (0.35 + microWobble);

      const pos = segment.basePosition
        .clone()
        .add(segment.baseNormal.clone().multiplyScalar(breakAmount))
        .add(segment.randomVec.clone().multiplyScalar(breakAmount * 0.25));

      group.position.copy(pos);

      group.rotation.z += 0.0008 * envelope * segment.randomStrength;

      const outlineMat = outline.material as THREE.MeshBasicMaterial;
      outlineMat.opacity = THREE.MathUtils.smoothstep(breakAmount, 0.1, 1.0);

      const plateMat = plate.material as THREE.MeshPhysicalMaterial;
      plateMat.clearcoat = 0.9;
      plateMat.clearcoatRoughness = 0.12 - envelope * 0.04;
      plateMat.roughness = 0.22 - envelope * 0.04;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private handleResize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  public destroy() {
    window.removeEventListener('resize', this.handleResize);

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.segments.forEach((segment) => {
      const group = segment.mesh as unknown as THREE.Group;

      group.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
    });

    if (this.innerSphere) {
      this.innerSphere.geometry.dispose();
    }

    if (this.innerMaterial) {
      this.innerMaterial.dispose();
    }

    this.renderer.dispose();

    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
