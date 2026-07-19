import { describe, it, expect } from 'vitest';
import { resolveRealExe, type ResolveFs } from './program-utils.js';

describe('resolveRealExe', () => {
  describe('updater (Squirrel)', () => {
    it('resolves to the highest-version app-<version> dir exe, ignoring lower versions', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'app-1.0.9', 'app-1.0.10'],
        existsSync: (p: string) => p.endsWith('app-1.0.10\\Discord.exe'),
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBe('C:\\Discord\\app-1.0.10\\Discord.exe');
    });

    it('uses numeric version sort, not string sort (app-1.0.10 > app-1.0.9)', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'app-1.0.9', 'app-1.0.10', 'app-1.0.8'],
        existsSync: (p: string) => p.endsWith('app-1.0.10\\Discord.exe'),
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBe('C:\\Discord\\app-1.0.10\\Discord.exe');
    });

    it('returns null if no app-<version> dirs exist', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'resources', 'locales'],
        existsSync: () => true,
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBeNull();
    });

    it('returns null if app-<version> dir exists but the exe does not', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'app-1.0.10'],
        existsSync: (p: string) => !p.includes('Discord.exe'),
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBeNull();
    });

    it('returns null if readdirSync throws', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => {
          throw new Error('Permission denied');
        },
        existsSync: () => true,
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBeNull();
    });

    it('skips versions that do not have an exe and tries the next version', () => {
      let existsCheckCount = 0;
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'app-1.0.10', 'app-1.0.9'],
        existsSync: (p: string) => {
          existsCheckCount++;
          // app-1.0.10 does not exist, but app-1.0.9 does
          return p.includes('app-1.0.9') && p.endsWith('Discord.exe');
        },
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBe('C:\\Discord\\app-1.0.9\\Discord.exe');
      expect(existsCheckCount).toBeGreaterThanOrEqual(2); // tried 1.0.10, then 1.0.9
    });
  });

  describe('launcher', () => {
    it('finds a sibling exe whose normalized name matches the folder', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['PDFLauncher.exe', 'PDFgear.exe'],
        existsSync: (p: string) => !p.includes('PDFLauncher.exe'),
      };

      const result = resolveRealExe('C:\\PDFgear\\PDFLauncher.exe', 'launcher', mockFs);
      expect(result).toBe('C:\\PDFgear\\PDFgear.exe');
    });

    it('handles name normalization (strip spaces, dashes, dots)', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['App-Launcher.exe', 'App Gear.exe'],
        existsSync: (p: string) => !p.includes('Launcher') && p.endsWith('.exe'),
      };

      const result = resolveRealExe('C:\\App-Gear\\App-Launcher.exe', 'launcher', mockFs);
      expect(result).toBe('C:\\App-Gear\\App Gear.exe');
    });

    it('returns null if only the launcher itself exists', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['PDFLauncher.exe', 'config.ini'],
        existsSync: (p: string) => p.endsWith('PDFLauncher.exe'),
      };

      const result = resolveRealExe('C:\\PDFgear\\PDFLauncher.exe', 'launcher', mockFs);
      expect(result).toBeNull();
    });

    it('returns null if readdirSync throws', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => {
          throw new Error('Permission denied');
        },
        existsSync: () => true,
      };

      const result = resolveRealExe('C:\\PDFgear\\PDFLauncher.exe', 'launcher', mockFs);
      expect(result).toBeNull();
    });

    it('ignores non-.exe entries', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['PDFLauncher.exe', 'PDFgear.txt', 'config.ini'],
        existsSync: () => false,
      };

      const result = resolveRealExe('C:\\PDFgear\\PDFLauncher.exe', 'launcher', mockFs);
      expect(result).toBeNull();
    });

    it('matches if folder name is contained in exe name', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Launcher.exe', 'SlackApp.exe'],
        existsSync: (p: string) => p.endsWith('SlackApp.exe'),
      };

      const result = resolveRealExe('C:\\Slack\\Launcher.exe', 'launcher', mockFs);
      expect(result).toBe('C:\\Slack\\SlackApp.exe');
    });
  });

  describe('exe and appx', () => {
    it('returns null for exe type (no-op)', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => {
          throw new Error('should not be called');
        },
        existsSync: () => {
          throw new Error('should not be called');
        },
      };

      const result = resolveRealExe('C:\\Program Files\\App\\app.exe', 'exe', mockFs);
      expect(result).toBeNull();
    });

    it('returns null for appx type (no-op)', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => {
          throw new Error('should not be called');
        },
        existsSync: () => {
          throw new Error('should not be called');
        },
      };

      const result = resolveRealExe('appx:spotify', 'appx', mockFs);
      expect(result).toBeNull();
    });
  });

  describe('path normalization', () => {
    it('uses path.join on Windows style paths', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Update.exe', 'app-2.0.0'],
        existsSync: (p: string) => p === 'C:\\Discord\\app-2.0.0\\Discord.exe',
      };

      const result = resolveRealExe('C:\\Discord\\Update.exe', 'updater', mockFs);
      expect(result).toBe('C:\\Discord\\app-2.0.0\\Discord.exe');
    });

    it('correctly extracts folder name from nested paths', () => {
      const mockFs: ResolveFs = {
        readdirSync: () => ['Launcher.exe', 'MyApp.exe'],
        existsSync: (p: string) => p.endsWith('MyApp.exe'),
      };

      const result = resolveRealExe('C:\\Program Files\\MyApp\\Launcher.exe', 'launcher', mockFs);
      expect(result).toBe('C:\\Program Files\\MyApp\\MyApp.exe');
    });
  });
});
