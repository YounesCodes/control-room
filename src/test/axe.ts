import axe from "axe-core";
import { settleMotion } from "./motion";

export async function runAxe(context: axe.ElementContext, options: axe.RunOptions = {}) {
  await settleMotion(document);
  return axe.run(context, options);
}
