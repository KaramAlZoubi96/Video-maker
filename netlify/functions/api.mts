import type { Config, Context } from "@netlify/functions";
import { handle } from "../lib/api.mts";

export default async (req: Request, context: Context) => handle(req, context);

export const config: Config = {
  path: "/api/*",
};
