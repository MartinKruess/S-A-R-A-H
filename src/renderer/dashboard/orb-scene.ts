import { SarahHexOrb } from '../../sarahHexOrb';

const container = document.getElementById('sarah-orb-3d');

export let orb: SarahHexOrb | null = null;

if (container) {
  orb = new SarahHexOrb(container);

  if (document.body.classList.contains('boot-mode')) {
    orb.setOrbScale(0.4);
    orb.setLightIntensity(0.1);
    orb.setOrbOffset(0, -0.35, 0);
  }
}
