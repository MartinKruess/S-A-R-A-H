import { initCanvas } from './splash/canvas.js';
import { runTimeline } from './splash/timeline.js';

interface SplashApi {
  splashDone: () => void;
}

declare const sarah: SplashApi;

const canvas = initCanvas('splash-canvas');
const title = document.getElementById('splash-title')!;
const subtitle = document.getElementById('splash-subtitle')!;

runTimeline(canvas, { title, subtitle }, () => sarah.splashDone());
