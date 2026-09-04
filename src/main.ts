import { Game } from "@/Game";
import "@/style.css";

/**
 * Bootstrap. Thin on purpose: find the two DOM anchors, build the Game, start
 * the loop. Everything else lives in a module that can be reset or replaced.
 */

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud-root") as HTMLElement | null;

if (!canvas || !hudRoot) {
  throw new Error("Swerve n Serve: #game-canvas and #hud-root must exist in index.html");
}

const game = new Game(canvas, hudRoot);
game.start();

// Vite HMR: tear the old game down completely rather than stacking a second
// render loop on top of the first one.
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
