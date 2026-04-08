import * as THREE from 'three';

type SegmentData = {
  mesh: THREE.Mesh;
  baseNormal: THREE.Vector3;
  basePosition: THREE.Vector3;
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

/**
 * SarahHexOrb
 *
 * Phase 1 implementation:
 * - pseudo hex-sphere using many flat hex plates distributed on a sphere
 * - plates can move radially outward during break
 * - outline fades in during movement
 * - no inner light core yet by default (can be added later)
 *
 * Notes:
 * - This is intentionally a clean base architecture, not the final look.
 * - It avoids the previous "many whole spheres" approach.
 */
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

  private time = 0;
  private breaking = false;
  private breakStart = 0;
  private breakDurationMs = 900;
  private animationFrameId: number | null = null;

  private radius: number;
  private segmentRadius: number;

  constructor(
    private container: HTMLElement,
    options: SarahHexOrbOptions = {},
  ) {
    this.accentColor = new THREE.Color(options.accentColor ?? '#6ee7ff');
    this.outlineColor = new THREE.Color(options.outlineColor ?? '#4fd1c5');
    this.shellColor = new THREE.Color(options.shellColor ?? '#d4af37');
    this.radius = options.radius ?? 1.28;
    this.segmentRadius = options.segmentRadius ?? 0.115;

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
    this.createShell();

    this.root.add(this.shellGroup);
    this.scene.add(this.root);

    this.handleResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.handleResize);

    this.animate();
  }

  private createLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3.2, 4.4, 5.8);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fd3ff, 0.7);
    fill.position.set(-4.2, -1.8, 2.2);
    this.scene.add(fill);

    const rim = new THREE.PointLight(this.accentColor, 1.1, 14);
    rim.position.set(-2.2, 1.3, 2.6);
    this.scene.add(rim);
  }

  private createShell() {
    const points = this.generateFibonacciSphere(220, this.radius);

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
      roughness: 0.22,
      metalness: 0.68,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
      reflectivity: 0.7,
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

      const plate = new THREE.Mesh(plateGeometry, shellMaterial.clone());
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

      // small random twist so it does not look too mathematically sterile
      plateGroup.rotateZ(Math.random() * Math.PI * 2);

      this.shellGroup.add(plateGroup);

      this.segments.push({
        mesh: plateGroup as unknown as THREE.Mesh,
        baseNormal: normal,
        basePosition: point.clone(),
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

  public setAccentColor(color: string) {
    this.accentColor.set(color);
    this.outlineColor.set(color);

    this.segments.forEach((segment) => {
      const group = segment.mesh as unknown as THREE.Group;
      const outline = group.children[0] as THREE.Mesh;
      const mat = outline.material as THREE.MeshBasicMaterial;
      mat.color = this.outlineColor;
    });
  }

  public setShellColor(color: string) {
    this.shellColor.set(color);
    this.segments.forEach((segment) => {
      const group = segment.mesh as unknown as THREE.Group;
      const plate = group.children[1] as THREE.Mesh;
      const mat = plate.material as THREE.MeshPhysicalMaterial;
      mat.color = this.shellColor;
    });
  }

  public triggerBreak(durationMs = 900) {
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

    // 0 -> 1 -> 0 envelope
    const envelope = this.breaking ? Math.sin(breakProgress * Math.PI) : 0;

    this.root.rotation.y += 0.0022;
    this.root.rotation.x = Math.sin(this.time * 0.33) * 0.035;

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
      const radialOffset = envelope * (0.11 + microWobble);

      group.position.copy(
        segment.baseNormal.clone().multiplyScalar(this.radius + radialOffset),
      );

      group.rotation.z += 0.0008 * envelope * segment.randomStrength;

      const outlineMat = outline.material as THREE.MeshBasicMaterial;
      outlineMat.opacity = 0.04 + envelope * 0.52;

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

    this.renderer.dispose();

    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
