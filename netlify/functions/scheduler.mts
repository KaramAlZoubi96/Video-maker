import type { Config } from "@netlify/functions";
import { runScheduler } from "../lib/queue.mts";

// Runs every minute: posts at your time slots and moves uploads forward.
export default async () => {
  const steps = await runScheduler(22000);
  console.log(steps === null ? "Another run is still working; skipped." : `Scheduler run done (${steps} steps).`);
};

export const config: Config = {
  schedule: "* * * * *",
};
