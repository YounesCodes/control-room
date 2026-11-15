import axe from "axe-core";
import { settleMotion } from "./motion";

/**
 * `axe.run` once no finite animation or transition is running in the document.
 * Axe samples computed colors, so an element that is still fading in reports
 * a blended, lower-contrast color than the one it settles on.
 */
export async function runAxe(context: axe.ElementContext, options: axe.RunOptions = {}) {
  await settleMotion(document);
  return axe.run(context, options);
}
