import { describe, it, expect } from 'vitest';
import { toDeviceOptions, type DeviceInfoLike } from './hud-select-options.js';

describe('toDeviceOptions', () => {
  it('always prepends the System-Standard sentinel (value = "")', () => {
    const options = toDeviceOptions([], 'audioinput');
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({ value: '', label: 'System-Standard' });
  });

  it('filters by kind (audioinput)', () => {
    const devices: DeviceInfoLike[] = [
      { deviceId: 'a1', kind: 'audioinput',  label: 'Mic One' },
      { deviceId: 'o1', kind: 'audiooutput', label: 'Speaker One' },
      { deviceId: 'v1', kind: 'videoinput',  label: 'Camera' },
      { deviceId: 'a2', kind: 'audioinput',  label: 'Mic Two' },
    ];
    const options = toDeviceOptions(devices, 'audioinput');
    expect(options).toEqual([
      { value: '',   label: 'System-Standard' },
      { value: 'a1', label: 'Mic One' },
      { value: 'a2', label: 'Mic Two' },
    ]);
  });

  it('filters by kind (audiooutput)', () => {
    const devices: DeviceInfoLike[] = [
      { deviceId: 'a1', kind: 'audioinput',  label: 'Mic One' },
      { deviceId: 'o1', kind: 'audiooutput', label: 'Speaker One' },
      { deviceId: 'o2', kind: 'audiooutput', label: 'Speaker Two' },
    ];
    const options = toDeviceOptions(devices, 'audiooutput');
    expect(options).toEqual([
      { value: '',   label: 'System-Standard' },
      { value: 'o1', label: 'Speaker One' },
      { value: 'o2', label: 'Speaker Two' },
    ]);
  });

  it('falls back to "Mikrofon N" for audioinput devices with empty labels', () => {
    const devices: DeviceInfoLike[] = [
      { deviceId: 'a1', kind: 'audioinput', label: '' },
      { deviceId: 'a2', kind: 'audioinput', label: '   ' },
      { deviceId: 'a3', kind: 'audioinput', label: 'Real Mic' },
    ];
    const options = toDeviceOptions(devices, 'audioinput');
    expect(options).toEqual([
      { value: '',   label: 'System-Standard' },
      { value: 'a1', label: 'Mikrofon 1' },
      { value: 'a2', label: 'Mikrofon 2' },
      { value: 'a3', label: 'Real Mic' },
    ]);
  });

  it('falls back to "Lautsprecher N" for audiooutput devices with empty labels', () => {
    const devices: DeviceInfoLike[] = [
      { deviceId: 'o1', kind: 'audiooutput', label: '' },
      { deviceId: 'o2', kind: 'audiooutput', label: '' },
    ];
    const options = toDeviceOptions(devices, 'audiooutput');
    expect(options).toEqual([
      { value: '',   label: 'System-Standard' },
      { value: 'o1', label: 'Lautsprecher 1' },
      { value: 'o2', label: 'Lautsprecher 2' },
    ]);
  });

  it('ignores non-audio device kinds', () => {
    const devices: DeviceInfoLike[] = [
      { deviceId: 'v1', kind: 'videoinput', label: 'Camera' },
    ];
    const options = toDeviceOptions(devices, 'audioinput');
    expect(options).toEqual([
      { value: '', label: 'System-Standard' },
    ]);
  });
});
